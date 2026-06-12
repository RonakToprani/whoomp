// Baselines — personal rolling baselines per nightly metric.
//
// Winsorized EWMA (the production model): a robust, recency-weighted center with an
// EWMA-of-absolute-deviation spread tracker, cold-start gating, hard-outlier rejection, and
// Winsor clamping. Plus a simple trailing-window mean/SD path for explainability.
//
// Recovery is normalized against these baselines, so an honest cold-start matters: a metric
// needs MIN_NIGHTS_SEED valid nights before it is "usable" and MIN_NIGHTS_TRUST before it is
// fully "trusted". Reimplemented in TypeScript from the documented method; cross-checked
// against NOOP's Baselines (see CREDITS.md).

export interface MetricCfg {
  minVal: number; // physiological lower bound (hard reject below)
  maxVal: number; // physiological upper bound (hard reject above)
  floorSpread: number; // σ_floor: minimum dispersion
  halfLifeB: number; // baseline-center half-life (nights)
  halfLifeS: number; // spread half-life (nights, slower than center)
}

export type BaselineStatus = 'calibrating' | 'provisional' | 'trusted' | 'stale';

export interface BaselineState {
  baseline: number; // robust EWMA center (the personal "mean")
  spread: number; // EWMA abs-dev, floored; ×1.253 ≈ Gaussian σ
  nValid: number; // count of valid nights folded in
  nightsSinceUpdate: number; // consecutive nights with no valid value
  status: BaselineStatus;
}

export interface Deviation {
  z: number; // robust z = (value − baseline) / (1.253·spread)
  delta: number; // value − baseline
  ratio: number; // value / baseline − 1
  inNormalRange: boolean; // |z| ≤ 1
}

export const WINSOR_K = 3.0; // fold only within ±3σ
export const HARD_OUTLIER_K = 5.0; // drop the night if > 5σ away
export const MIN_NIGHTS_SEED = 4; // provisionally usable
export const MIN_NIGHTS_TRUST = 14; // fully trusted
export const STALE_DAYS = 14; // stale after this many missing nights
// E[|X−μ|] = σ·√(2/π) ⇒ σ ≈ |dev| / 0.7979 = 1.253·|dev|.
export const MAD_TO_SIGMA = 1.253;

export const METRIC_CFG: Record<string, MetricCfg> = {
  hrv: { minVal: 5, maxVal: 250, floorSpread: 5, halfLifeB: 14, halfLifeS: 21 },
  resting_hr: { minVal: 30, maxVal: 120, floorSpread: 2, halfLifeB: 14, halfLifeS: 21 },
  resp: { minVal: 4, maxVal: 40, floorSpread: 0.5, halfLifeB: 14, halfLifeS: 21 },
  skin_temp: { minVal: 20, maxVal: 42, floorSpread: 0.3, halfLifeB: 14, halfLifeS: 21 },
};

export const hrvCfg = METRIC_CFG.hrv;
export const restingHrCfg = METRIC_CFG.resting_hr;
export const respCfg = METRIC_CFG.resp;

export function baselineUsable(s: BaselineState): boolean {
  return s.status === 'provisional' || s.status === 'trusted';
}
export function baselineTrusted(s: BaselineState): boolean {
  return s.status === 'trusted';
}

function lambda(halfLife: number): number {
  return 1 - Math.pow(0.5, 1 / halfLife);
}

function computeStatus(nValid: number, nightsSinceUpdate: number): BaselineStatus {
  if (nightsSinceUpdate > STALE_DAYS && nValid >= MIN_NIGHTS_SEED) return 'stale';
  if (nValid < MIN_NIGHTS_SEED) return 'calibrating';
  if (nValid < MIN_NIGHTS_TRUST) return 'provisional';
  return 'trusted';
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * Fold one nightly value into the baseline state.
 *  - state == null: seed the first night.
 *  - value missing / out of range: skip-and-hold (carry forward, age staleness).
 *  - hard outlier (> 5σ once seeded): seen but not folded.
 *  - otherwise: Winsorized EWMA center + EWMA-abs-dev spread.
 */
export function updateBaseline(
  state: BaselineState | null,
  value: number | null | undefined,
  cfg: MetricCfg,
): BaselineState {
  const lb = lambda(cfg.halfLifeB);
  const ls = lambda(cfg.halfLifeS);

  if (!state) {
    if (isNum(value) && value >= cfg.minVal && value <= cfg.maxVal) {
      return { baseline: value, spread: cfg.floorSpread, nValid: 1, nightsSinceUpdate: 0, status: 'calibrating' };
    }
    const seed = (cfg.minVal + cfg.maxVal) / 2;
    return { baseline: seed, spread: cfg.floorSpread, nValid: 0, nightsSinceUpdate: 1, status: 'calibrating' };
  }

  // Missing or physiologically implausible → skip-and-hold.
  if (!isNum(value) || value < cfg.minVal || value > cfg.maxVal) {
    const m = state.nightsSinceUpdate + 1;
    return { ...state, nightsSinceUpdate: m, status: computeStatus(state.nValid, m) };
  }

  // Hard-outlier rejection (only once seeded): seen, not folded.
  if (state.nValid >= MIN_NIGHTS_SEED && Math.abs(value - state.baseline) > HARD_OUTLIER_K * state.spread) {
    return { ...state, nightsSinceUpdate: 0, status: computeStatus(state.nValid, 0) };
  }

  // First real value after a placeholder seed: treat as a clean first night.
  if (state.nValid === 0) {
    return { baseline: value, spread: cfg.floorSpread, nValid: 1, nightsSinceUpdate: 0, status: 'calibrating' };
  }

  // Winsorized EWMA center; spread tracks the UNCLAMPED deviation.
  const lo = state.baseline - WINSOR_K * state.spread;
  const hi = state.baseline + WINSOR_K * state.spread;
  const clamped = Math.max(lo, Math.min(hi, value));
  const newBaseline = lb * clamped + (1 - lb) * state.baseline;
  const absDev = Math.abs(value - newBaseline);
  const newSpread = Math.max(cfg.floorSpread, ls * absDev + (1 - ls) * state.spread);
  const newN = state.nValid + 1;
  return { baseline: newBaseline, spread: newSpread, nValid: newN, nightsSinceUpdate: 0, status: computeStatus(newN, 0) };
}

/** Replay an ordered (oldest→newest) sequence of nightly values; null = missing night. */
export function foldHistory(values: (number | null | undefined)[], cfg: MetricCfg): BaselineState {
  let state: BaselineState | null = null;
  for (const v of values) state = updateBaseline(state, v, cfg);
  if (state) return state;
  const seed = (cfg.minVal + cfg.maxVal) / 2;
  return { baseline: seed, spread: cfg.floorSpread, nValid: 0, nightsSinceUpdate: 0, status: 'calibrating' };
}

/** z / delta / ratio / in-normal-range of a value vs a baseline. */
export function deviation(value: number, state: BaselineState): Deviation {
  const sigma = Math.max(MAD_TO_SIGMA * state.spread, 1e-9);
  const z = (value - state.baseline) / sigma;
  const delta = value - state.baseline;
  const ratio = state.baseline !== 0 ? value / state.baseline - 1 : 0;
  return { z, delta, ratio, inNormalRange: Math.abs(z) <= 1 };
}

/** Simple trailing-window mean + sample SD (ddof=1); spread stored in abs-dev units. */
export function rollingMeanSD(values: (number | null | undefined)[], cfg: MetricCfg, window = 30): BaselineState {
  const valid = values.filter((v): v is number => isNum(v) && v >= cfg.minVal && v <= cfg.maxVal);
  if (valid.length === 0) {
    const seed = (cfg.minVal + cfg.maxVal) / 2;
    return { baseline: seed, spread: cfg.floorSpread, nValid: 0, nightsSinceUpdate: 0, status: 'calibrating' };
  }
  const trailing = valid.slice(-window);
  const n = trailing.length;
  const mean = trailing.reduce((a, b) => a + b, 0) / n;
  let sd: number;
  if (n >= 2) {
    let ss = 0;
    for (const v of trailing) { const d = v - mean; ss += d * d; }
    sd = Math.sqrt(ss / (n - 1));
  } else {
    sd = cfg.floorSpread * MAD_TO_SIGMA;
  }
  const spreadInternal = Math.max(cfg.floorSpread, sd) / MAD_TO_SIGMA;
  return { baseline: mean, spread: spreadInternal, nValid: n, nightsSinceUpdate: 0, status: computeStatus(n, 0) };
}

/**
 * Calibration progress for the dashboard: count of usable nights while still below the seed
 * gate, else null (already usable, or no data yet). Drives "Calibrating — N of 4 nights".
 */
export function calibrationNights(
  values: (number | null | undefined)[],
  cfg: MetricCfg = hrvCfg,
  seed = MIN_NIGHTS_SEED,
): number | null {
  const n = values.filter((v): v is number => isNum(v) && v >= cfg.minVal && v <= cfg.maxVal).length;
  return n >= 1 && n < seed ? n : null;
}
