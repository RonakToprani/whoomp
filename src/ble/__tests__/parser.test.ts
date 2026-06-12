import { describe, it, expect } from 'vitest';
import { parseHistorical, BIOMETRIC_HISTORICAL_VERSIONS } from '../parser';

// Build a V24-shaped historical body (pkt.data) with known values at the documented offsets.
function buildV24Body(): Uint8Array {
  const buf = new ArrayBuffer(80);
  const dv = new DataView(buf);
  dv.setUint32(4, 1_700_000_000, true); // unix
  dv.setUint8(14, 55); // heart_rate
  dv.setUint8(15, 1); // rr_count
  dv.setUint16(16, 850, true); // rr[0]
  dv.setFloat32(33, 0.1, true); // gravity_x
  dv.setFloat32(37, 0.2, true); // gravity_y
  dv.setFloat32(41, 0.98, true); // gravity_z
  dv.setUint8(48, 1); // skin_contact
  dv.setUint16(61, 12345, true); // spo2_red
  dv.setUint16(63, 23456, true); // spo2_ir
  dv.setUint16(65, 30000, true); // skin_temp_raw
  dv.setUint16(73, 15000, true); // resp_rate_raw
  return new Uint8Array(buf);
}

describe('parseHistorical V24 channel decode', () => {
  it('decodes HR/RR + full biometric block on version 24', () => {
    const r = parseHistorical(buildV24Body(), 24);
    expect(r.version).toBe(24);
    expect(r.unix).toBe(1_700_000_000);
    expect(r.heartRateBpm).toBe(55);
    expect(r.rrIntervalsMs).toEqual([850]);
    expect(r.gravity).toBeDefined();
    expect(r.gravity!.x).toBeCloseTo(0.1, 5);
    expect(r.gravity!.y).toBeCloseTo(0.2, 5);
    expect(r.gravity!.z).toBeCloseTo(0.98, 5);
    expect(r.skinContact).toBe(1);
    expect(r.spo2Red).toBe(12345);
    expect(r.spo2Ir).toBe(23456);
    expect(r.skinTempRaw).toBe(30000);
    expect(r.respRaw).toBe(15000);
  });

  it('version 12 is also a biometric layout', () => {
    expect(BIOMETRIC_HISTORICAL_VERSIONS.has(12)).toBe(true);
    expect(parseHistorical(buildV24Body(), 12).gravity).toBeDefined();
  });

  it('generic version 5 decodes HR/RR only (no channels)', () => {
    const r = parseHistorical(buildV24Body(), 5);
    expect(r.version).toBe(5);
    expect(r.heartRateBpm).toBe(55);
    expect(r.gravity).toBeUndefined();
    expect(r.respRaw).toBeUndefined();
    expect(r.spo2Red).toBeUndefined();
  });

  it('short biometric frame degrades to HR/RR without throwing', () => {
    const r = parseHistorical(buildV24Body().slice(0, 40), 24); // too short for gravity (needs ≥45)
    expect(r.heartRateBpm).toBe(55);
    expect(r.gravity).toBeUndefined();
    expect(r.respRaw).toBeUndefined();
  });

  it('throws only on a body shorter than the HR/RR header', () => {
    expect(() => parseHistorical(new Uint8Array(20), 24)).toThrow();
  });
});
