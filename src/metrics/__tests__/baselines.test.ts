import { describe, it, expect } from 'vitest';
import {
  updateBaseline, foldHistory, deviation, rollingMeanSD, baselineUsable, baselineTrusted, hrvCfg,
} from '../baselines';

// Parity vectors from NOOP BaselinesTests (Winsorized EWMA + trailing mean/SD).
describe('baselines parity', () => {
  it('first night seeds', () => {
    const s = updateBaseline(null, 50, hrvCfg);
    expect(s.baseline).toBeCloseTo(50, 9);
    expect(s.spread).toBeCloseTo(hrvCfg.floorSpread, 9);
    expect(s.nValid).toBe(1);
    expect(s.status).toBe('calibrating');
  });

  it('cold-start status progression 3→4→14', () => {
    let s = foldHistory(new Array(3).fill(50), hrvCfg);
    expect(s.status).toBe('calibrating');
    expect(baselineUsable(s)).toBe(false);

    s = foldHistory(new Array(4).fill(50), hrvCfg);
    expect(s.status).toBe('provisional');
    expect(baselineUsable(s)).toBe(true);

    s = foldHistory(new Array(14).fill(50), hrvCfg);
    expect(s.status).toBe('trusted');
    expect(baselineTrusted(s)).toBe(true);
  });

  it('missing night skip-and-hold', () => {
    const seed = updateBaseline(null, 50, hrvCfg);
    const after = updateBaseline(seed, null, hrvCfg);
    expect(after.baseline).toBeCloseTo(seed.baseline, 9);
    expect(after.spread).toBeCloseTo(seed.spread, 9);
    expect(after.nValid).toBe(seed.nValid);
    expect(after.nightsSinceUpdate).toBe(1);
  });

  it('constant series converges to value, spread at floor', () => {
    const s = foldHistory(new Array(30).fill(50), hrvCfg);
    expect(s.baseline).toBeCloseTo(50, 6);
    expect(s.spread).toBeCloseTo(hrvCfg.floorSpread, 9);
  });

  it('hard outlier is rejected, not folded', () => {
    const stable = foldHistory(new Array(10).fill(50), hrvCfg);
    const after = foldHistory([...new Array(10).fill(50), 200], hrvCfg);
    expect(after.baseline).toBeCloseTo(stable.baseline, 0); // within 1.0
  });

  it('out-of-range value skipped', () => {
    const seed = updateBaseline(null, 50, hrvCfg);
    const after = updateBaseline(seed, 300, hrvCfg); // > hrv max 250
    expect(after.nValid).toBe(seed.nValid);
    expect(after.nightsSinceUpdate).toBe(1);
  });

  it('deviation direction and zero point', () => {
    const s = foldHistory(new Array(14).fill(50), hrvCfg);
    const at = deviation(50, s);
    expect(at.z).toBeCloseTo(0, 6);
    expect(at.delta).toBeCloseTo(0, 6);
    expect(at.inNormalRange).toBe(true);
    expect(deviation(70, s).z).toBeGreaterThan(0);
    expect(deviation(70, s).delta).toBeCloseTo(20, 6);
    expect(deviation(30, s).z).toBeLessThan(0);
  });

  it('rollingMeanSD recovers σ via deviation', () => {
    const s = rollingMeanSD([40, 50, 60], hrvCfg);
    expect(s.baseline).toBeCloseTo(50, 9);
    expect(deviation(60, s).z).toBeCloseTo(1, 6); // (60-50)/10
  });

  it('rollingMeanSD window truncates + drops out-of-range/nil', () => {
    const trunc = rollingMeanSD([...new Array(5).fill(100), ...new Array(30).fill(50)], hrvCfg, 30);
    expect(trunc.baseline).toBeCloseTo(50, 9);
    expect(trunc.nValid).toBe(30);

    const dropped = rollingMeanSD([null, 50, 300, 50, 50], hrvCfg);
    expect(dropped.nValid).toBe(3);
    expect(dropped.baseline).toBeCloseTo(50, 9);
  });
});
