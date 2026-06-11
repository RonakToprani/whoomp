import { PacketType, MetadataType, EventNumber, EventName, WhoopPacket } from './protocol';

function u16le(d: Uint8Array, off: number): number { return d[off] | (d[off + 1] << 8); }
function u32le(d: Uint8Array, off: number): number {
  return (d[off] | (d[off + 1] << 8) | (d[off + 2] << 16) | (d[off + 3] << 24)) >>> 0;
}

export interface RealtimeResult {
  type: 'realtime';
  receivedAt: number;
  heartRateBpm: number | null;
  rrIntervalsMs: number[];
  raw: Uint8Array;
}

export interface HistoricalResult {
  type: 'historical';
  unix: number;
  subsec: number;
  flashIndex: number;
  isoUtc: string;
  heartRateBpm: number | null;
  rrIntervalsMs: number[];
}

export interface MetadataResult {
  type: 'metadata';
  kind: 'historyStart' | 'historyEnd' | 'historyComplete' | string;
  cmd: number;
  unix?: number;
  subsec?: number;
  unk?: number;
  trim?: number;
}

export interface EventResult {
  type: 'event';
  cmd: number;
  name: string;
  unix?: number;
  semantic?: string;
  batteryPct?: number;
}

export interface ResponseResult {
  type: 'response';
  cmd: number;
  data: Uint8Array;
}

export type DecodedPacket =
  | RealtimeResult
  | HistoricalResult
  | MetadataResult
  | EventResult
  | ResponseResult
  | { type: 'consoleLog'; text: string }
  | { type: 'realtimeRaw'; cmd: number; data: Uint8Array }
  | { type: 'imuRealtime'; cmd: number; data: Uint8Array }
  | { type: 'imuHistorical'; cmd: number; data: Uint8Array }
  | { type: 'unknown'; packetType: number; cmd: number; data: Uint8Array };

export function parseRealtime(data: Uint8Array, { recvAt = Date.now() } = {}): RealtimeResult {
  if (data.length < 7) return { type: 'realtime', heartRateBpm: null, rrIntervalsMs: [], receivedAt: recvAt, raw: data };

  const heartRateBpm = (data[5] >= 20 && data[5] <= 250) ? data[5] : null;
  const rrnum = Math.min(4, data[6] ?? 0);

  const rr: number[] = [];
  for (let i = 0; i < rrnum && 7 + i * 2 + 1 < data.length; i++) {
    const v = u16le(data, 7 + i * 2);
    if (v >= 200 && v <= 2000) rr.push(v);
  }

  return {
    type: 'realtime',
    receivedAt: recvAt,
    heartRateBpm,
    rrIntervalsMs: rr,
    raw: data,
  };
}

export function parseHistorical(data: Uint8Array): HistoricalResult {
  if (data.length < 24) throw new Error(`HISTORICAL body too short: ${data.length}`);
  const unix = u32le(data, 4);
  const subsec = u16le(data, 8);
  const flashIndex = u32le(data, 10);
  const heart = data[14];
  const rrnum = Math.min(4, data[15] ?? 0);
  const rr: number[] = [];
  for (let i = 0; i < rrnum; i++) {
    const v = u16le(data, 16 + i * 2);
    if (v >= 200 && v <= 2000) rr.push(v);
  }
  return {
    type: 'historical',
    unix,
    subsec,
    flashIndex,
    isoUtc: new Date(unix * 1000).toISOString(),
    heartRateBpm: (heart >= 20 && heart <= 250) ? heart : null,
    rrIntervalsMs: rr,
  };
}

export function parseMetadata(cmd: number, data: Uint8Array): MetadataResult {
  const kind =
    cmd === MetadataType.HISTORY_START    ? 'historyStart'    :
    cmd === MetadataType.HISTORY_END      ? 'historyEnd'      :
    cmd === MetadataType.HISTORY_COMPLETE ? 'historyComplete' : `unknown:${cmd}`;

  const out: MetadataResult = { type: 'metadata', kind, cmd };

  if (kind === 'historyEnd' && data.length >= 14) {
    out.unix = u32le(data, 0);
    out.subsec = u16le(data, 4);
    out.unk = u32le(data, 6);
    out.trim = u32le(data, 10);
  } else if (kind === 'historyStart' && data.length >= 10) {
    out.unix = u32le(data, 0);
    out.subsec = u16le(data, 4);
    out.unk = u32le(data, 6);
  }
  return out;
}

export function parseEvent(cmd: number, data: Uint8Array): EventResult {
  const name = EventName[cmd] ?? `UNKNOWN_${cmd}`;
  const evt: EventResult = { type: 'event', cmd, name };

  if (data.length >= 5) evt.unix = u32le(data, 1);

  switch (cmd) {
    case EventNumber.WRIST_ON:
      evt.semantic = 'wristOn';
      break;
    case EventNumber.WRIST_OFF:
      evt.semantic = 'wristOff';
      break;
    case EventNumber.CHARGING_ON:
      evt.semantic = 'chargingOn';
      break;
    case EventNumber.CHARGING_OFF:
      evt.semantic = 'chargingOff';
      break;
    case EventNumber.DOUBLE_TAP:
      evt.semantic = 'doubleTap';
      break;
    case EventNumber.BATTERY_LEVEL:
      if (data.length >= 4) evt.batteryPct = u16le(data, 2) / 10;
      evt.semantic = 'batteryLevel';
      break;
    case EventNumber.RTC_LOST:
      evt.semantic = 'rtcLost';
      break;
    case EventNumber.HIGH_FREQ_SYNC_PROMPT:
      evt.semantic = 'syncPrompt';
      break;
    case EventNumber.ERROR:
      evt.semantic = 'error';
      break;
  }
  return evt;
}

export function parseResponse(cmd: number, data: Uint8Array): ResponseResult {
  return { type: 'response', cmd, data };
}

export function parseBatteryResponse(data: Uint8Array): number | null {
  if (data.length < 4) return null;
  return u16le(data, 2) / 10;
}

export function parseClockResponse(data: Uint8Array): number | null {
  if (data.length < 6) return null;
  return u32le(data, 2);
}

export function parseDataRangeResponse(data: Uint8Array): { startUnix: number; endUnix: number } | null {
  if (data.length < 10) return null;
  return {
    startUnix: u32le(data, 2),
    endUnix:   u32le(data, 6),
  };
}

export function parseHelloResponse(data: Uint8Array): { charging: boolean; isWorn: boolean; serial: string | null; raw: Uint8Array; partial?: boolean } {
  if (data.length < 117) return { charging: false, isWorn: false, serial: null, raw: data, partial: true };

  const charging = data[7] === 1;
  const isWorn = data[116] === 1;

  let serial: string | null = null;
  const s = data.subarray(9, 18);
  if (s.every(b => b >= 0x20 && b < 0x7f)) {
    serial = String.fromCharCode(...s).trim();
  }
  return { charging, isWorn, serial, raw: data };
}

export function parseConsoleLog(data: Uint8Array): string {
  if (data.length <= 8) return '';
  const sliced = data.subarray(7, data.length - 1);
  const cleaned: number[] = [];
  for (let i = 0; i < sliced.length; i++) {
    if (i + 2 < sliced.length &&
        sliced[i] === 0x34 && sliced[i + 1] === 0x00 && sliced[i + 2] === 0x01) {
      i += 2;
    } else {
      cleaned.push(sliced[i]);
    }
  }
  try {
    return new TextDecoder('utf-8').decode(new Uint8Array(cleaned));
  } catch {
    return '';
  }
}

export function decodePacket(pkt: WhoopPacket): DecodedPacket {
  switch (pkt.type) {
    case PacketType.REALTIME_DATA:
      return parseRealtime(pkt.data);
    case PacketType.HISTORICAL_DATA:
      return parseHistorical(pkt.data);
    case PacketType.METADATA:
      return parseMetadata(pkt.cmd, pkt.data);
    case PacketType.EVENT:
      return parseEvent(pkt.cmd, pkt.data);
    case PacketType.COMMAND_RESPONSE:
      return { type: 'response', cmd: pkt.cmd, data: pkt.data };
    case PacketType.CONSOLE_LOGS:
      return { type: 'consoleLog', text: parseConsoleLog(pkt.data) };
    case PacketType.REALTIME_RAW_DATA:
      return { type: 'realtimeRaw', cmd: pkt.cmd, data: pkt.data };
    case PacketType.REALTIME_IMU_DATA_STREAM:
      return { type: 'imuRealtime', cmd: pkt.cmd, data: pkt.data };
    case PacketType.HISTORICAL_IMU_DATA_STREAM:
      return { type: 'imuHistorical', cmd: pkt.cmd, data: pkt.data };
    default:
      return { type: 'unknown', packetType: pkt.type, cmd: pkt.cmd, data: pkt.data };
  }
}
