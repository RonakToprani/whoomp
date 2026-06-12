import { BleManager, Device, Subscription } from 'react-native-ble-plx';
import { SERVICES, CHARACTERISTICS } from './constants';
import {
  WhoopPacket, PacketType, CommandNumber, EventNumber,
  buildCommandFrame,
} from './protocol';
import {
  decodePacket, parseHistorical, parseBatteryResponse, parseClockResponse,
  parseHelloResponse, MetadataResult,
} from './parser';

const RECONNECT_INITIAL_MS = 1000;
const RECONNECT_MAX_MS = 30000;
const BATTERY_POLL_MS = 60000;
const RTC_DRIFT_THRESHOLD_S = 5;
const META_QUEUE_TIMEOUT_MS = 30000;

function bytesToB64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function b64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

class AsyncQueue<T> {
  private _items: T[] = [];
  private _waiters: Array<[(val: T) => void]> = [];

  push(x: T): void {
    if (this._waiters.length) {
      const [resolve] = this._waiters.shift()!;
      resolve(x);
    } else {
      this._items.push(x);
    }
  }

  async pop(timeoutMs?: number): Promise<T> {
    if (this._items.length) return this._items.shift()!;
    return new Promise<T>((resolve, reject) => {
      const entry: [(val: T) => void] = [resolve];
      this._waiters.push(entry);
      if (timeoutMs) {
        setTimeout(() => {
          const i = this._waiters.indexOf(entry);
          if (i >= 0) { this._waiters.splice(i, 1); reject(new Error('queue timeout')); }
        }, timeoutMs);
      }
    });
  }

  clear(): void { this._items.length = 0; }
}

class Emitter {
  private _h: Record<string, Array<(p: unknown) => void>> = {};

  on<T>(event: string, fn: (p: T) => void): () => void {
    (this._h[event] ??= []).push(fn as (p: unknown) => void);
    return () => { this._h[event] = this._h[event].filter(h => h !== fn); };
  }

  emit(event: string, payload?: unknown): void {
    this._h[event]?.forEach(fn => fn(payload));
  }
}

export type ClientState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';

const manager = new BleManager();

export class WhoopClient {
  private _emitter = new Emitter();
  private _device: Device | null = null;
  private _connected = false;
  private _connecting = false;
  private _reconnectBackoff = RECONNECT_INITIAL_MS;
  private _reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private _intentionalDisconnect = false;
  private _seq = 0;
  private _batteryPollInterval: ReturnType<typeof setInterval> | null = null;
  private _metaQueue = new AsyncQueue<MetadataResult>();
  private _historicalDumpInFlight = false;
  private _state: ClientState = 'disconnected';
  private _subs: Subscription[] = [];

  charging: boolean | null = null;
  isWorn: boolean | null = null;
  serial: string | null = null;
  batteryPct: number | null = null;
  lastClockUnix: number | null = null;

  on<T>(event: string, fn: (p: T) => void): () => void {
    return this._emitter.on(event, fn);
  }

  private _emit(event: string, payload?: unknown): void {
    this._emitter.emit(event, payload);
  }

  private _setState(s: ClientState): void {
    this._state = s;
    this._emit('state', s);
  }

  private _clearReconnectTimer(): void {
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
  }

  private _scheduleReconnect(): void {
    if (this._intentionalDisconnect) return;
    this._clearReconnectTimer();               // never stack reconnect chains
    this._setState('reconnecting');
    this._reconnectTimer = setTimeout(() => this._tryReconnect(), this._reconnectBackoff);
    this._reconnectBackoff = Math.min(this._reconnectBackoff * 2, RECONNECT_MAX_MS);
  }

  // Remove every per-connection subscription and timer. Safe to call repeatedly,
  // so a reconnect can never leave a previous connection's handlers attached.
  private _teardownConnection(): void {
    this._subs.forEach(s => { try { s.remove(); } catch {} });
    this._subs = [];
    if (this._batteryPollInterval) { clearInterval(this._batteryPollInterval); this._batteryPollInterval = null; }
  }

  async scan(): Promise<void> {
    this._intentionalDisconnect = false;
    this._clearReconnectTimer();
    this._reconnectBackoff = RECONNECT_INITIAL_MS;
    this._setState('connecting');
    manager.startDeviceScan([SERVICES.WHOOP], null, (error, device) => {
      if (error) { this._emit('error', error); return; }
      if (device?.name?.startsWith('WHOOP')) {
        manager.stopDeviceScan();
        this._connectToDevice(device).catch(err => this._emit('error', err));
      }
    });
  }

  private async _connectToDevice(device: Device): Promise<void> {
    this._device = device;
    await this._connect();
  }

  private async _connect(): Promise<void> {
    if (!this._device) return;
    if (this._connecting) return;            // no overlapping connect attempts
    this._connecting = true;
    this._clearReconnectTimer();
    this._teardownConnection();              // drop any stale handlers/timers first
    this._setState('connecting');

    let connected: Device;
    try {
      connected = await this._device.connect();
      this._device = connected;
      await connected.discoverAllServicesAndCharacteristics();
    } catch (err) {
      this._connecting = false;
      throw err;
    }

    this._connected = true;
    this._reconnectBackoff = RECONNECT_INITIAL_MS;

    const discSub = connected.onDisconnected((_error, _d) => this._onDisconnected());

    const dataSub = connected.monitorCharacteristicForService(
      SERVICES.WHOOP,
      CHARACTERISTICS.DATA,
      (error, char) => {
        if (error || !char?.value) return;
        const bytes = b64ToBytes(char.value);
        let pkt: WhoopPacket;
        try { pkt = WhoopPacket.fromData(bytes); }
        catch (err) { this._emit('error', err); return; }

        switch (pkt.type) {
          case PacketType.REALTIME_DATA: {
            const decoded = decodePacket(pkt);
            this._emit('realtime', decoded);
            break;
          }
          case PacketType.HISTORICAL_DATA: {
            try {
              const rec = parseHistorical(pkt.data);
              this._emit('historicalSample', rec);
            } catch (err) { this._emit('error', err); }
            break;
          }
          case PacketType.METADATA: {
            const meta = decodePacket(pkt);
            if (meta.type === 'metadata') this._metaQueue.push(meta);
            this._emit('metadata', meta);
            break;
          }
          case PacketType.CONSOLE_LOGS: {
            const decoded = decodePacket(pkt);
            if (decoded.type === 'consoleLog' && decoded.text) this._emit('log', decoded.text);
            break;
          }
          case PacketType.REALTIME_RAW_DATA:
          case PacketType.REALTIME_IMU_DATA_STREAM:
          case PacketType.HISTORICAL_IMU_DATA_STREAM:
            this._emit('imu', { packetType: pkt.type, data: pkt.data });
            break;
        }
      }
    );

    const respSub = connected.monitorCharacteristicForService(
      SERVICES.WHOOP,
      CHARACTERISTICS.CMD_FROM_STRAP,
      (error, char) => {
        if (error || !char?.value) return;
        const bytes = b64ToBytes(char.value);
        let pkt: WhoopPacket;
        try { pkt = WhoopPacket.fromData(bytes); }
        catch { return; }

        if (pkt.cmd === CommandNumber.GET_BATTERY_LEVEL) {
          const pct = parseBatteryResponse(pkt.data);
          if (pct != null) { this.batteryPct = pct; this._emit('battery', pct); }
        } else if (pkt.cmd === CommandNumber.GET_CLOCK) {
          const unix = parseClockResponse(pkt.data);
          if (unix != null) { this.lastClockUnix = unix; this._emit('clock', unix); }
        } else if (pkt.cmd === CommandNumber.GET_HELLO_HARVARD) {
          const hello = parseHelloResponse(pkt.data);
          if (hello && !hello.partial) {
            this.charging = hello.charging;
            this.isWorn = hello.isWorn;
            this.serial = hello.serial ?? this.serial;
            this._emit('hello', hello);
          }
        }
        this._emit('response', { cmd: pkt.cmd, data: pkt.data });
      }
    );

    const eventSub = connected.monitorCharacteristicForService(
      SERVICES.WHOOP,
      CHARACTERISTICS.EVENTS,
      (error, char) => {
        if (error || !char?.value) return;
        const bytes = b64ToBytes(char.value);
        let pkt: WhoopPacket;
        try { pkt = WhoopPacket.fromData(bytes); }
        catch { return; }
        if (pkt.type !== PacketType.EVENT) return;
        const evt = decodePacket(pkt);

        switch (pkt.cmd) {
          case EventNumber.WRIST_ON:  this.isWorn = true; break;
          case EventNumber.WRIST_OFF: this.isWorn = false; break;
          case EventNumber.CHARGING_ON:  this.charging = true; break;
          case EventNumber.CHARGING_OFF: this.charging = false; break;
          case EventNumber.RTC_LOST:
            this.setClock().catch(() => {});
            break;
          case EventNumber.HIGH_FREQ_SYNC_PROMPT:
            this.downloadHistory().catch(() => {});
            break;
        }
        this._emit('event', evt);
      }
    );

    this._subs = [discSub, dataSub, respSub, eventSub];
    this._setState('connected');

    this._postConnectFlow().catch(err => this._emit('error', err));
    this._batteryPollInterval = setInterval(() => this.getBatteryLevel(), BATTERY_POLL_MS);
    this._connecting = false;
  }

  private async _postConnectFlow(): Promise<void> {
    try { await this.sendHello(); } catch (e) { this._emit('error', e); }

    try {
      const strapUnix = await this.getClock();
      const hostUnix = Math.floor(Date.now() / 1000);
      if (strapUnix && Math.abs(hostUnix - strapUnix) > RTC_DRIFT_THRESHOLD_S) {
        await this.setClock();
      }
    } catch (e) { this._emit('error', e); }

    try { await this.downloadHistory(); } catch (e) { this._emit('error', e); }

    try { await this.startRealtime(); } catch (e) { this._emit('error', e); }

    this.getBatteryLevel().catch(() => {});
  }

  async disconnect(): Promise<void> {
    this._intentionalDisconnect = true;
    this._clearReconnectTimer();
    this._connecting = false;
    try { await this.stopRealtime(); } catch {}
    this._teardownConnection();
    if (this._device) {
      try { await this._device.cancelConnection(); } catch {}
    }
    this._connected = false;
    this._setState('disconnected');
  }

  destroy(): void {
    this._intentionalDisconnect = true;
    this._clearReconnectTimer();
    this._connecting = false;
    this._teardownConnection();
    if (this._device) {
      this._device.cancelConnection().catch(() => {});
    }
  }

  private _onDisconnected(): void {
    this._connected = false;
    this._connecting = false;
    this._teardownConnection();
    this._metaQueue.clear();
    if (this._historicalDumpInFlight) {
      this._emit('historyError', new Error('disconnected during dump'));
      this._historicalDumpInFlight = false;
    }
    this._scheduleReconnect();               // no-ops if the disconnect was intentional
  }

  private async _tryReconnect(): Promise<void> {
    this._reconnectTimer = null;             // the scheduled fire has consumed the timer
    if (this._intentionalDisconnect) return;
    try { await this._connect(); }
    catch (err) {
      this._emit('error', err);
      this._scheduleReconnect();
    }
  }

  private async _sendCommand(cmd: number, payload: Uint8Array = new Uint8Array()): Promise<void> {
    if (!this._device || !this._connected) throw new Error('Not connected');
    const frame = buildCommandFrame(cmd, payload, this._seq);
    this._seq = (this._seq + 1) & 0xff;
    await this._device.writeCharacteristicWithResponseForService(
      SERVICES.WHOOP,
      CHARACTERISTICS.CMD_TO_STRAP,
      bytesToB64(frame)
    );
  }

  async startRealtime(): Promise<void> {
    await this._sendCommand(CommandNumber.TOGGLE_REALTIME_HR, new Uint8Array([0x01]));
  }

  async stopRealtime(): Promise<void> {
    await this._sendCommand(CommandNumber.TOGGLE_REALTIME_HR, new Uint8Array([0x00]));
  }

  async getBatteryLevel(): Promise<void> {
    if (!this._connected) return;
    try { await this._sendCommand(CommandNumber.GET_BATTERY_LEVEL, new Uint8Array([0x00])); }
    catch (err) { console.warn('[WhoopClient] battery poll failed', err); }
  }

  async sendHello(): Promise<void> {
    await this._sendCommand(CommandNumber.GET_HELLO_HARVARD, new Uint8Array([0x00]));
  }

  async getClock(): Promise<number | null> {
    return new Promise(async (resolve) => {
      let resolved = false;
      const dispose = this.on<number>('clock', (unix) => {
        if (resolved) return;
        resolved = true;
        dispose();
        resolve(unix);
      });
      setTimeout(() => { if (!resolved) { dispose(); resolve(null); } }, 3000);
      await this._sendCommand(CommandNumber.GET_CLOCK, new Uint8Array([0x00]));
    });
  }

  async setClock(unix: number = Math.floor(Date.now() / 1000)): Promise<void> {
    const buf = new Uint8Array(4);
    buf[0] = unix & 0xff;
    buf[1] = (unix >>> 8) & 0xff;
    buf[2] = (unix >>> 16) & 0xff;
    buf[3] = (unix >>> 24) & 0xff;
    await this._sendCommand(CommandNumber.SET_CLOCK, buf);
  }

  async downloadHistory(): Promise<{ samples: number; alreadyRunning?: boolean }> {
    if (!this._connected) return { samples: 0 };
    if (this._historicalDumpInFlight) return { samples: 0, alreadyRunning: true };
    this._historicalDumpInFlight = true;
    this._metaQueue.clear();
    this._emit('historyStart', {});

    let samplesReceived = 0;
    const onSample = this.on('historicalSample', () => { samplesReceived++; });

    try {
      await this._sendCommand(CommandNumber.SEND_HISTORICAL_DATA, new Uint8Array([0x00]));

      while (true) {
        let meta: MetadataResult;
        do {
          meta = await this._metaQueue.pop(META_QUEUE_TIMEOUT_MS);
        } while (meta.kind !== 'historyEnd' && meta.kind !== 'historyComplete');

        if (meta.kind === 'historyComplete') {
          this._emit('historyComplete', { samples: samplesReceived });
          return { samples: samplesReceived };
        }

        const ack = new Uint8Array(9);
        ack[0] = 0x01;
        const trim = meta.trim ?? 0;
        ack[1] = trim & 0xff;
        ack[2] = (trim >>> 8) & 0xff;
        ack[3] = (trim >>> 16) & 0xff;
        ack[4] = (trim >>> 24) & 0xff;
        await this._sendCommand(CommandNumber.HISTORICAL_DATA_RESULT, ack);
        this._emit('historyProgress', { samples: samplesReceived, trim });
      }
    } catch (err) {
      this._emit('historyError', err);
      throw err;
    } finally {
      onSample();
      this._historicalDumpInFlight = false;
    }
  }
}
