import { describe, it, expect } from 'vitest';
import { recovery, recoveryBand, SLEEP_PERF_CENTER } from '../recovery';
import { BaselineState, MAD_TO_SIGMA } from '../baselines';

// A usable (trusted) baseline with a given Gaussian σ. spread is abs-dev units (σ/1.253).
function baseline(meanV: number, sigma: number, nValid = 14): BaselineState {
  return {
    baseline: meanV,
    spread: sigma / MAD_TO_SIGMA,
    nValid,
    nightsSinceUpdate: 0,
    status: nValid >= 14 ? 'trusted' : 'provisional',
  };
}

// Parity vectors from NOOP RecoveryScorerTests (z-score + logistic, anchored Z=0→58%).
describe('recovery parity', () => {
  it('at baseline → ~58% (population mean)', () => {
    const r = recovery({
      hrv: 50, rhr: 55, resp: null,
      hrvBaseline: baseline(50, 6), rhrBaseline: baseline(55, 3), respBaseline: null,
      sleepPerf: SLEEP_PERF_CENTER,
    });
    expect(r!).toBeCloseTo(57.93, 1);
  });

  it('higher HRV + lower RHR + better sleep → high; opposite → low', () => {
    const good = recovery({
      hrv: 65, rhr: 50, resp: null,
      hrvBaseline: baseline(50, 6.265), rhrBaseline: baseline(55, 2.506), respBaseline: null,
      sleepPerf: 0.9,
    })!;
    const bad = recovery({
      hrv: 40, rhr: 62, resp: null,
      hrvBaseline: baseline(50, 6.265), rhrBaseline: baseline(55, 2.506), respBaseline: null,
      sleepPerf: 0.7,
    })!;
    expect(good).toBeGreaterThan(bad);
    expect(good).toBeGreaterThan(90);
    expect(bad).toBeLessThan(15);
  });

  it('clamped to [0,100]', () => {
    const r = recovery({
      hrv: 200, rhr: 30, resp: null,
      hrvBaseline: baseline(50, 5), rhrBaseline: baseline(55, 2), respBaseline: null,
      sleepPerf: 1.0,
    })!;
    expect(r).toBeLessThanOrEqual(100);
    expect(r).toBeGreaterThanOrEqual(0);
  });

  it('cold-start (calibrating HRV baseline) → null', () => {
    const cold: BaselineState = { baseline: 50, spread: 5, nValid: 2, nightsSinceUpdate: 0, status: 'calibrating' };
    const r = recovery({
      hrv: 60, rhr: 50, resp: null, hrvBaseline: cold, rhrBaseline: null, respBaseline: null, sleepPerf: 0.9,
    });
    expect(r).toBeNull();
  });

  it('resp at baseline drops out cleanly (renormalize)', () => {
    const withResp = recovery({
      hrv: 50, rhr: 55, resp: 100,
      hrvBaseline: baseline(50, 6), rhrBaseline: baseline(55, 3), respBaseline: baseline(100, 5),
      sleepPerf: SLEEP_PERF_CENTER,
    })!;
    const withoutResp = recovery({
      hrv: 50, rhr: 55, resp: null,
      hrvBaseline: baseline(50, 6), rhrBaseline: baseline(55, 3), respBaseline: baseline(100, 5),
      sleepPerf: SLEEP_PERF_CENTER,
    })!;
    expect(withResp).toBeCloseTo(withoutResp, 6);
  });

  it('resp above baseline lowers, below raises', () => {
    const score = (resp: number | null) => recovery({
      hrv: 50, rhr: 55, resp,
      hrvBaseline: baseline(50, 6), rhrBaseline: baseline(55, 3), respBaseline: baseline(14.5, 1),
      sleepPerf: 0.9,
    })!;
    const neutral = score(null);
    expect(score(17.5)).toBeLessThan(neutral);
    expect(score(12.0)).toBeGreaterThan(neutral);
  });

  it('band thresholds', () => {
    expect(recoveryBand(20)).toBe('red');
    expect(recoveryBand(33.9)).toBe('red');
    expect(recoveryBand(34)).toBe('yellow');
    expect(recoveryBand(66.9)).toBe('yellow');
    expect(recoveryBand(67)).toBe('green');
    expect(recoveryBand(90)).toBe('green');
  });
});
