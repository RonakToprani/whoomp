import { describe, it, expect } from 'vitest';
import { rmssdRaw, sdnnRaw, rangeFilter, rejectEctopic, cleanRR, analyzeHrv } from '../hrv';

// Parity vectors lifted from NOOP HRVAnalyzerTests (Task Force 1996 + Malik cleaning).
describe('hrv parity', () => {
  it('RMSSD hand-computed', () => {
    // diffs 10,-10,10 → sqrt(300/3) = 10
    expect(rmssdRaw([800, 810, 800, 810])!).toBeCloseTo(10, 9);
  });

  it('SDNN sample stddev (ddof=1)', () => {
    expect(sdnnRaw([800, 810, 800, 810])!).toBeCloseTo(5.773502691896258, 9);
  });

  it('too few values → null', () => {
    expect(rmssdRaw([800])).toBeNull();
    expect(sdnnRaw([])).toBeNull();
  });

  it('range filter drops out-of-range, inclusive bounds', () => {
    expect(rangeFilter([250, 300, 800, 2000, 2100, 1500])).toEqual([300, 800, 2000, 1500]);
  });

  it('analyze requires >= 20 clean beats', () => {
    const r = analyzeHrv(new Array(19).fill(800));
    expect(r.rmssd).toBeNull();
    expect(r.sdnn).toBeNull();
    expect(r.nInput).toBe(19);
    expect(r.nClean).toBe(0);
  });

  it('golden 22-interval series matches Python/NOOP values', () => {
    const nn = [800, 810, 805, 815, 800, 820, 810, 800, 815, 805, 810,
      800, 820, 815, 805, 810, 800, 815, 810, 805, 800, 820];
    const r = analyzeHrv(nn);
    expect(r.nClean).toBe(22);
    expect(r.rmssd!).toBeCloseTo(11.649647450214351, 9);
    expect(r.sdnn!).toBeCloseTo(7.101612523427368, 9);
    expect(r.meanNN!).toBeCloseTo(nn.reduce((a, b) => a + b, 0) / 22, 9);
  });

  it('ectopic rejection drops a single impossible spike', () => {
    const nn = new Array(30).fill(800);
    nn[15] = 1400;
    const clean = cleanRR(nn);
    expect(clean.length).toBe(29);
    expect(clean).not.toContain(1400);
    expect(rmssdRaw(clean)!).toBeCloseTo(0, 9);
  });

  it('moderate ±12.5% variation is kept (within 20% Malik threshold)', () => {
    const nn = [800, 900, 800, 900, 800, 900, 800, 900];
    expect(rejectEctopic(nn).length).toBe(nn.length);
  });
});
