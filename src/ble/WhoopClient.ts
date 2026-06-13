import { BleManager, Device, Subscription } from 'react-native-ble-plx';
import { SERVICES, CHARACTERISTICS } from './constants';
import {
  WhoopPacket, PacketType, CommandNumber, EventNumber,
  buildCommandFrame, setClockPayload, setClockPayloadLegacy,
} from './protocol';
import {
  decodePacket, parseHistorical, parseBatteryResponse, parseClockResponse,
  parseHelloResponse, parseDataRangeResponse, MetadataResult,
} from './parser';

const RECONNECT_INITIAL_MS = 1000;
const RECONNECT_MAX_MS = 30000;
const BATTERY_POLL_MS = 60000;
const META_QUEUE_TIMEOUT_MS = 30000;
// ── Strap RTC hold ──────────────────────────────────────────────────────────
// This WHOOP 4.0 (fw 41.17.x) loses its RTC to ~1971 on power-cycle/reboot and then banks NO sensor
// history to flash until the clock is re-latched. So we don't just set the clock once at connect — we
// HOLD it: re-check on a timer, re-set on drift, and re-set immediately on the strap's reboot/RTC-lost
// events. All gated to never fire mid-offload (re-blasting SET_CLOCK during a dump stalls the type-47
// stream — NOOP's hard-won lesson). Mirrors NOOP's ClockPolicy + watchdog re-set.
const CLOCK_KEEPALIVE_MS = 90_000;        // re-verify/hold the strap RTC while connected
const CLOCK_DRIFT_THRESHOLD_S = 2;        // re-set when the strap clock drifts >= this (NOOP ClockPolicy)
const CLOCK_ASSERT_DEBOUNCE_MS = 8_000;   // coalesce event-driven re-sets (a BOOT+RTC_LOST burst)
const RTC_MIN_VALID_UNIX = 1_500_000_000; // ~2017-07 — plausible-unix floor for "RTC valid"
const RTC_MAX_VALID_UNIX = 2_500_000_000; // ~2049 — ceiling
// Re-offload the strap's flash store on a timer while connected (mirrors NOOP/WHOOP, which re-sync
// the 14-day biometric store every ~15 min rather than once per connect). Without this, a single
// failed/empty connect-time drain is never retried for the life of the connection.
const BACKFILL_INTERVAL_MS = 5 * 60_000;

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
  private _backfillTimer: ReturnType<typeof setInterval> | null = null;
  private _clockTimer: ReturnType<typeof setInterval> | null = null;
  private _clockBusy = false;        // a keep-alive tick is in flight — don't stack
  private _lastClockAssertMs = 0;    // debounce for _assertClock (event bursts)

  charging: boolean | null = null;
  isWorn: boolean | null = null;
  serial: string | null = null;
  batteryPct: number | null = null;
  lastClockUnix: number | null = null;
  // Strap's stored-data range from GET_DATA_RANGE (unix seconds). If this is empty/tiny while the
  // DB has no historical samples, the strap has nothing to give (e.g. the official WHOOP app drained
  // + trimmed the flash); if it spans days but no samples arrive, the drain itself is failing.
  dataRange: { startUnix: number; endUnix: number } | null = null;
  // The strap's own RTC value + flash-banking state, scraped from its console-log stream
  // ("Flash: RTC timestamp <n> is invalid; not saving data to flash"). This is the definitive
  // read of whether the clock is valid — independent of GET_CLOCK (which this strap ignores).
  strapRtc: { raw: number; valid: boolean; savingBlocked: boolean } | null = null;
  private _consoleBuf = '';

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
    if (this._backfillTimer) { clearInterval(this._backfillTimer); this._backfillTimer = null; }
    if (this._clockTimer) { clearInterval(this._clockTimer); this._clockTimer = null; }
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
              const rec = parseHistorical(pkt.data, pkt.seq);
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
            if (decoded.type === 'consoleLog' && decoded.text) {
              this._emit('log', decoded.text);
              this._scanConsoleForRtc(decoded.text);
            }
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

        if (pkt.cmd === CommandNumber.GET_DATA_RANGE) {
          const range = parseDataRangeResponse(pkt.data);
          if (range) {
            this.dataRange = range;
            this._emit('dataRange', range);
            this._emit('log', `strap data range: ${new Date(range.startUnix * 1000).toISOString()} → ${new Date(range.endUnix * 1000).toISOString()}`);
          }
        } else if (pkt.cmd === CommandNumber.GET_BATTERY_LEVEL) {
          const pct = parseBatteryResponse(pkt.data);
          if (pct != null) { this.batteryPct = pct; this._emit('battery', pct); }
        } else if (pkt.cmd === CommandNumber.GET_CLOCK) {
          const unix = parseClockResponse(pkt.data);
          if (unix != null) {
            this.lastClockUnix = unix;
            this._emit('clock', unix);
            // GET_CLOCK is an authoritative read of the strap RTC. Reflect it in the panel so a
            // working clock shows VALID even when the strap isn't spontaneously logging its RTC to
            // the console (it only logs when banking is BLOCKED). This is what flips "Strap RTC" to
            // VALID once the both-form GET_CLOCK finally gets a reply on this firmware.
            const valid = unix > RTC_MIN_VALID_UNIX && unix < RTC_MAX_VALID_UNIX;
            this._updateStrapRtc({ raw: unix, valid, savingBlocked: valid ? false : (this.strapRtc?.savingBlocked ?? false) }, 'GET_CLOCK');
          }
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
            // The strap just lost its clock — re-latch immediately so it resumes banking to flash.
            this._assertClock('event RTC_LOST').catch(() => {});
            break;
          case EventNumber.BOOT:
            // A reboot resets this firmware's RTC to ~1971; re-latch before it banks a new (junk) record.
            this._assertClock('event BOOT').catch(() => {});
            break;
          case EventNumber.SET_RTC:
            // Strap acknowledged a clock set — confirm the new value (flips the panel to VALID).
            this._emit('log', 'event SET_RTC (strap acknowledged clock set)');
            this.getClock().catch(() => {});
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
    // Periodically re-drain the flash store so a single failed/empty connect-time offload is retried
    // for the life of the connection (the strap keeps logging; we keep pulling).
    this._backfillTimer = setInterval(() => { this.downloadHistory().catch(() => {}); }, BACKFILL_INTERVAL_MS);
    // HOLD the strap RTC: re-verify on a timer and re-set on drift / lost clock. Without this a
    // reboot mid-session silently stops banking until the next reconnect.
    this._clockTimer = setInterval(() => { this._clockKeepAlive().catch(() => {}); }, CLOCK_KEEPALIVE_MS);
    this._connecting = false;
  }

  private async _postConnectFlow(): Promise<void> {
    try { await this.sendHello(); } catch (e) { this._emit('error', e); }

    try {
      // ALWAYS set the strap RTC on connect — unconditionally, before history. A strap with a
      // lost/relative clock does NOT bank timestamped sensor history; it only emits console
      // diagnostics, so the drain returns 0 frames. Send BOTH firmware payload forms (8-byte +
      // 9-byte) — fw 41.17.x latches ONLY the 9-byte legacy form (#120). Then read back with the
      // both-form GET_CLOCK (this firmware answers only the [0x00] request form, which is why
      // GET_CLOCK never replied before). The keep-alive timer holds it from here.
      await this.sendSetClockBothForms();
      const strapUnix = await this.getClock();
      if (strapUnix) {
        this.lastClockUnix = strapUnix;
        const drift = Math.abs(Math.floor(Date.now() / 1000) - strapUnix);
        this._emit('log', `GET_CLOCK→ ${new Date(strapUnix * 1000).toISOString()} (drift ${drift}s)`);
      } else {
        this._emit('log', 'clock set ×2 forms (GET_CLOCK no reply — watching strap RTC in console)');
      }
    } catch (e) { this._emit('error', e); }

    // Ask the strap what it has stored before draining — distinguishes "nothing to give" (empty
    // range, e.g. the official WHOOP app trimmed the flash) from "drain is failing" (range spans
    // days but no frames arrive). Surfaced in the Settings sync panel.
    try { await this.getDataRange(); } catch (e) { this._emit('error', e); }

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
      // GET_CLOCK's request payload length is firmware-specific, exactly like SET_CLOCK's: newer
      // firmware answers the EMPTY form, but fw 41.17.x answers ONLY [0x00] and ignores empty (#120).
      // whoomp sent empty only — which is precisely why this strap never replied to GET_CLOCK. Send
      // BOTH; the strap answers whichever its firmware accepts (a second reply is a harmless no-op).
      await this._writeNoResp(CommandNumber.GET_CLOCK, new Uint8Array());
      await this._writeNoResp(CommandNumber.GET_CLOCK, new Uint8Array([0x00]));
    });
  }

  // Query the strap's stored-data range (GET_DATA_RANGE). Resolves with the range or null on timeout.
  async getDataRange(): Promise<{ startUnix: number; endUnix: number } | null> {
    if (!this._connected) return null;
    return new Promise(async (resolve) => {
      let resolved = false;
      const dispose = this.on<{ startUnix: number; endUnix: number }>('dataRange', (range) => {
        if (resolved) return;
        resolved = true;
        dispose();
        resolve(range);
      });
      setTimeout(() => { if (!resolved) { dispose(); resolve(null); } }, 3000);
      try { await this._sendCommand(CommandNumber.GET_DATA_RANGE, new Uint8Array()); }
      catch { if (!resolved) { resolved = true; dispose(); resolve(null); } }
    });
  }

  // Write a command WITHOUT a response. NOOP and gowhoop both write SET_CLOCK/GET_CLOCK this way, and
  // build 5's only successful clock latch on this strap came from a no-response write — so it's the
  // proven transport for the clock commands.
  private async _writeNoResp(cmd: number, payload: Uint8Array): Promise<void> {
    if (!this._device || !this._connected) return;
    const frame = buildCommandFrame(cmd, payload, this._seq);
    this._seq = (this._seq + 1) & 0xff;
    try {
      await this._device.writeCharacteristicWithoutResponseForService(
        SERVICES.WHOOP, CHARACTERISTICS.CMD_TO_STRAP, bytesToB64(frame),
      );
    } catch { /* best-effort */ }
  }

  // Set the strap RTC in BOTH firmware payload forms — 8-byte `[u32 LE][4 zero]` (newer fw) and the
  // 9-byte legacy `[u32 LE][5 zero]` (fw 41.17.x, the ONLY form that latches on this strap). One form
  // is a no-op on any given firmware; both carry the same seconds, so double-latching is harmless.
  // This is the single SET_CLOCK path now — the old bare-4-byte form matched NO firmware and was pure
  // noise. See protocol.ts / NOOP #120.
  async sendSetClockBothForms(): Promise<void> {
    if (!this._device || !this._connected) return;
    const now = Math.floor(Date.now() / 1000);
    await this._writeNoResp(CommandNumber.SET_CLOCK, setClockPayload(now));
    await this._writeNoResp(CommandNumber.SET_CLOCK, setClockPayloadLegacy(now));
    this._emit('log', `SET_CLOCK ×2 forms → ${new Date(now * 1000).toISOString().slice(0, 19)}`);
  }

  // Re-latch the strap RTC, then read it back to confirm. GATED: never fires during a historical
  // offload (re-blasting SET_CLOCK mid-dump stalls the type-47 stream — NOOP's hard-won lesson) and
  // debounced so a reboot's BOOT+RTC_LOST event burst coalesces into one set.
  private async _assertClock(reason: string): Promise<void> {
    if (!this._connected || this._historicalDumpInFlight) return;
    const nowMs = Date.now();
    if (nowMs - this._lastClockAssertMs < CLOCK_ASSERT_DEBOUNCE_MS) return;
    this._lastClockAssertMs = nowMs;
    this._emit('log', `clock re-set (${reason})`);
    await this.sendSetClockBothForms();
    this.getClock().catch(() => {});   // reply flips "Strap RTC" → VALID in the panel
  }

  // HOLD the clock: runs on a timer while connected. If the RTC is unknown/lost/blocked, re-latch;
  // if it looks valid, verify against wall time and re-set only on real drift (mirrors NOOP's
  // ClockPolicy — avoids gratuitous resets). Skips entirely during an offload.
  private async _clockKeepAlive(): Promise<void> {
    if (!this._connected || this._historicalDumpInFlight || this._clockBusy) return;
    this._clockBusy = true;
    try {
      const rtc = this.strapRtc;
      if (!rtc || !rtc.valid || rtc.savingBlocked) {
        // Unknown, lost, or banking-blocked → re-latch. This is the nightly-reboot recovery path.
        await this._assertClock(rtc ? 'rtc invalid' : 'rtc unknown');
        return;
      }
      // RTC looked valid (cached) — actively read it back. GET_CLOCK also flips the panel and updates
      // strapRtc via the response handler. A reboot since the last tick shows up here as an
      // out-of-range value → re-latch THIS tick (don't wait for the next one).
      const unix = await this.getClock();
      if (unix != null) {
        if (unix <= RTC_MIN_VALID_UNIX || unix >= RTC_MAX_VALID_UNIX) {
          await this._assertClock('rtc lost (GET_CLOCK)');
        } else {
          const drift = Math.abs(Math.floor(Date.now() / 1000) - unix);
          if (drift >= CLOCK_DRIFT_THRESHOLD_S) await this._assertClock(`drift ${drift}s`);
        }
      }
    } finally {
      this._clockBusy = false;
    }
  }

  // Update the cached strap-RTC state from any source (console scrape OR GET_CLOCK reply) and surface
  // it to the panel. Emit/log only on a STATE flip (valid or banking-blocked changes), not on every
  // ticking-second re-read — otherwise the 90s GET_CLOCK poll would spam the log.
  private _updateStrapRtc(next: { raw: number; valid: boolean; savingBlocked: boolean }, source: string): void {
    const prev = this.strapRtc;
    this.strapRtc = next;
    if (!prev || prev.valid !== next.valid || prev.savingBlocked !== next.savingBlocked) {
      this._emit('strapRtc', next);
      const when = next.valid ? `VALID (${new Date(next.raw * 1000).toISOString().slice(0, 19)})` : `INVALID (${next.raw})`;
      this._emit('log', `strap RTC ${when}${next.savingBlocked ? ' · NOT banking' : ''} [${source}]`);
    }
  }

  // Reassemble fragmented console-log chunks (BLE splits the strap's text mid-word/mid-number) and
  // extract its RTC value + whether it's blocking flash writes ("Flash: RTC timestamp <n> is invalid;
  // not saving data to flash"). This is the strap's own report that it's NOT banking. savingBlocked is
  // tied to an out-of-range RTC so a valid GET_CLOCK read isn't fought by stale "not saving" text
  // lingering in the buffer; GET_CLOCK is the authority for VALID, the console for INVALID.
  private _scanConsoleForRtc(text: string): void {
    // Small window: enough to rejoin a number split across one BLE chunk, but short enough that a
    // stale "invalid" line ages out once the clock recovers (and we take the NEWEST match below).
    this._consoleBuf = (this._consoleBuf + text).slice(-300);
    const re = /RTC timestamp\s*(\d{5,})/g;
    let m: RegExpExecArray | null, last: RegExpExecArray | null = null;
    while ((m = re.exec(this._consoleBuf)) !== null) last = m;
    if (!last) return;
    const raw = parseInt(last[1], 10);
    const valid = raw > RTC_MIN_VALID_UNIX && raw < RTC_MAX_VALID_UNIX;
    const savingBlocked = !valid && /not saving data to flash/i.test(this._consoleBuf);
    this._updateStrapRtc({ raw, valid, savingBlocked }, 'console');
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
