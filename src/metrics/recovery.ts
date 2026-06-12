// Recovery — a transparent 0–100 recovery score.
//
// A z-score + logistic composite, HRV-dominant and baseline-normalized. APPROXIMATE — not
// WHOOP-identical (their model is proprietary), but grounded and explainable:
//
//   higher HRV vs baseline        → higher recovery  (W_HRV   = 0.60, dominant)
//   lower resting HR vs baseline  → higher recovery  (W_RHR   = 0.20)
//   lower respiration vs baseline → higher recovery  (W_RESP  = 0.05)
//   higher sleep performance      → higher recovery  (W_SLEEP = 0.15)
//
// Each driver is standardized to a robust z against the personal baseline (mean + EWMA-abs-dev
// spread). Missing terms are dropped and the weights renormalized. The composite z is squashed
// through a logistic anchored so Z = 0 → ~58% (WHOOP's published population-average recovery).
// Inputs are measured during the detected sleep window. Cold-start: if the HRV baseline isn't
// usable yet, recovery() returns null and the UI shows "Calibrating — N of 4 nights" instead of
// a fabricated number. Cross-checked against NOOP's RecoveryScorer (see CREDITS.md).

import { BaselineState, baselineUsable, MAD_TO_SIGMA } from './baselines';

export const W_HRV = 0.6;
export const W_RHR = 0.2;
export const W_RESP = 0.05;
export const W_SLEEP = 0.15;

export const LOGISTIC_K = 1.6; // ±2 z-units ≈ full red–green band
export const LOGISTIC_Z0 = -0.2; // offset so Z=0 → 58%
export const POPULATION_MEAN = 58.0; // WHOOP-published population-average recovery (cold-start fallback)

export const BAND_RED_MAX = 34;
export const BAND_YELLOW_MAX = 67;

export const SLEEP_PERF_CENTER = 0.85; // a "good night" at ~85% efficiency
export const SLEEP_PERF_SCALE = 0.12; // ±2 z spans the normal range

export type RecoveryBand = 'red' | 'yellow' | 'green';

/** WHOOP-style color band for a recovery score [0, 100]. */
export function recoveryBand(score: number): RecoveryBand {
  if (score < BAND_RED_MAX) return 'red';
  if (score < BAND_YELLOW_MAX) return 'yellow';
  return 'green';
}

/** Robust z-score using EWMA spread: (value − mean) / (1.253 × spread). */
function zScore(value: number, mean: number, spread: number): number {
  const sigma = Math.max(MAD_TO_SIGMA * spread, 1e-9);
  return (value - mean) / sigma;
}

export interface RecoveryInputs {
  hrv: number; // tonight's RMSSD (ms)
  rhr: number; // tonight's resting HR (bpm)
  resp?: number | null; // tonight's respiration (optional)
  hrvBaseline: BaselineState; // required for a score
  rhrBaseline?: BaselineState | null;
  respBaseline?: BaselineState | null;
  sleepPerf?: number | null; // sleep efficiency 0..1 (optional)
}

export interface RecoveryBreakdown {
  total: number | null;
  band: RecoveryBand | null;
  compositeZ: number | null;
  hrvZ: number | null;
  rhrZ: number | null;
  respZ: number | null;
  sleepZ: number | null;
}

/**
 * Full recovery breakdown (per-driver z + composite + score + band). total/band/compositeZ are
 * null on cold-start (HRV baseline not usable) or when no driver is available.
 */
export function recoveryBreakdown(inp: RecoveryInputs): RecoveryBreakdown {
  const out: RecoveryBreakdown = {
    total: null, band: null, compositeZ: null, hrvZ: null, rhrZ: null, respZ: null, sleepZ: null,
  };
  if (!baselineUsable(inp.hrvBaseline)) return out; // cold-start gate

  const terms: { z: number; w: number }[] = [];

  // HRV: higher is better.
  const hrvZ = zScore(inp.hrv, inp.hrvBaseline.baseline, inp.hrvBaseline.spread);
  out.hrvZ = hrvZ;
  terms.push({ z: hrvZ, w: W_HRV });

  // RHR: lower is better → (baseline − value) / σ.
  if (inp.rhrBaseline) {
    const z = zScore(inp.rhrBaseline.baseline, inp.rhr, inp.rhrBaseline.spread);
    out.rhrZ = z;
    terms.push({ z, w: W_RHR });
  }
  // Respiration: lower is better, optional.
  if (inp.resp != null && inp.respBaseline) {
    const z = zScore(inp.respBaseline.baseline, inp.resp, inp.respBaseline.spread);
    out.respZ = z;
    terms.push({ z, w: W_RESP });
  }
  // Sleep performance: centered, no baseline needed.
  if (inp.sleepPerf != null) {
    const z = (inp.sleepPerf - SLEEP_PERF_CENTER) / SLEEP_PERF_SCALE;
    out.sleepZ = z;
    terms.push({ z, w: W_SLEEP });
  }

  const totalWeight = terms.reduce((a, t) => a + t.w, 0);
  if (totalWeight <= 0) return out;

  const z = terms.reduce((a, t) => a + t.z * t.w, 0) / totalWeight;
  const score = 100 / (1 + Math.exp(-LOGISTIC_K * (z - LOGISTIC_Z0)));
  const clamped = Math.max(0, Math.min(100, score));
  out.compositeZ = z;
  out.total = Math.round(clamped * 10) / 10;
  out.band = recoveryBand(out.total);
  return out;
}

/** Recovery score [0, 100], or null on cold-start / no driver. */
export function recovery(inp: RecoveryInputs): number | null {
  return recoveryBreakdown(inp).total;
}
