import { describe, it, expect } from 'vitest';
import {
  setClockPayload, setClockPayloadLegacy, buildCommandFrame, WhoopPacket,
  PacketType, CommandNumber,
} from '../protocol';
import { parseClockResponse } from '../parser';

// Pins the dual SET_CLOCK payload forms (mirrors NOOP's SetClockPayloadTests, #120). The payload
// LENGTH is firmware-specific and LOAD-BEARING: fw 41.17.x latches ONLY the 9-byte legacy form and
// ignores the 8-byte form; newer firmware is the reverse. whoomp's old bare-4-byte form matched
// NEITHER — these tests guard against ever regressing to it.
describe('SET_CLOCK payload forms', () => {
  it('8-byte form is [u32 LE seconds][4 zero]', () => {
    const p = setClockPayload(0x11223344);
    expect(p.length).toBe(8);
    expect([...p.slice(0, 4)]).toEqual([0x44, 0x33, 0x22, 0x11]); // u32 LE
    expect([...p.slice(4, 8)]).toEqual([0, 0, 0, 0]);
  });

  it('9-byte legacy form is [u32 LE seconds][5 zero] — the form fw 41.17.x latches', () => {
    const p = setClockPayloadLegacy(0x11223344);
    expect(p.length).toBe(9);
    expect([...p.slice(0, 4)]).toEqual([0x44, 0x33, 0x22, 0x11]);
    expect([...p.slice(4, 9)]).toEqual([0, 0, 0, 0, 0]);
  });

  it('both forms carry the SAME seconds, so whichever latches sets the same time', () => {
    const now = 1_781_000_000;
    expect([...setClockPayload(now).slice(0, 4)]).toEqual([...setClockPayloadLegacy(now).slice(0, 4)]);
  });

  it('handles a real ~2026 unix without sign issues (u32 >> 24 stays unsigned)', () => {
    const now = 1_781_234_567; // > 2^30, exercises the high byte
    const p = setClockPayload(now);
    const back = p[0] | (p[1] << 8) | (p[2] << 16) | (p[3] * 0x1000000);
    expect(back).toBe(now);
  });

  it('framed SET_CLOCK (legacy form) round-trips through WhoopPacket.fromData with correct CRCs', () => {
    const frame = buildCommandFrame(CommandNumber.SET_CLOCK, setClockPayloadLegacy(1_781_000_000), 7);
    const pkt = WhoopPacket.fromData(frame); // throws on bad SOF / CRC-8 / CRC-32
    expect(pkt.type).toBe(PacketType.COMMAND);
    expect(pkt.cmd).toBe(CommandNumber.SET_CLOCK);
    expect(pkt.seq).toBe(7);
    expect(pkt.data.length).toBe(9);
  });
});

// GET_CLOCK reply = u32 LE at offset 2. Must return the RAW value (the client classifies valid vs
// invalid by range) — including a lost-RTC ~1971 value, which must NOT be hidden.
describe('parseClockResponse', () => {
  // [2-byte header][u32 LE clock at offset 2].
  function clockAtOffset2(clock: number): Uint8Array {
    const buf = new Uint8Array(6);
    new DataView(buf.buffer).setUint32(2, clock >>> 0, true);
    return buf;
  }

  it('reads a real ~2026 clock from offset 2', () => {
    expect(parseClockResponse(clockAtOffset2(1_781_000_000))).toBe(1_781_000_000);
  });

  it('surfaces a lost-RTC (~1971) value rather than hiding it', () => {
    // The client will classify this out-of-range value as INVALID and re-latch.
    expect(parseClockResponse(clockAtOffset2(31_812_237))).toBe(31_812_237);
  });

  it('returns null for a too-short response', () => {
    expect(parseClockResponse(new Uint8Array([0, 1, 2]))).toBeNull();
  });
});
