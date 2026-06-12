import { describe, it, expect } from 'vitest';
import { respRateFromRaw, type RespSample } from '../resp';

// 1 Hz raw resp signal: a clean sinusoid at `hz` over `seconds` (hz=0.25 → 15 breaths/min).
function sine(seconds: number, hz: number, amp = 100, dc = 1000): RespSample[] {
  const out: RespSample[] = [];
  for (let t = 0; t < seconds; t++) out.push({ ts: t, raw: Math.round(dc + amp * Math.sin(2 * Math.PI * hz * t)) });
  return out;
}

describe('respiration rate', () => {
  it('recovers ~15 br/min from a 0.25 Hz signal', () => {
    const r = respRateFromRaw(sine(200, 0.25));
    expect(r).not.toBeNull();
    expect(r!).toBeGreaterThan(12);
    expect(r!).toBeLessThan(18);
  });

  it('recovers ~12 br/min from a 0.2 Hz signal', () => {
    const r = respRateFromRaw(sine(200, 0.2));
    expect(r).not.toBeNull();
    expect(r!).toBeGreaterThan(9);
    expect(r!).toBeLessThan(15);
  });

  it('returns null for a flat (no-signal) channel', () => {
    const flat = Array.from({ length: 200 }, (_, t) => ({ ts: t, raw: 1000 }));
    expect(respRateFromRaw(flat)).toBeNull();
  });

  it('returns null with too little data', () => {
    expect(respRateFromRaw(sine(60, 0.25))).toBeNull(); // < 120 s window
  });

  it('rejects implausible rates (out of 4–40 band)', () => {
    expect(respRateFromRaw(sine(200, 1.0))).toBeNull(); // 60 br/min → implausible
  });
});
