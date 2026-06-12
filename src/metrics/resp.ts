// Respiration rate — breaths per minute from the strap's raw respiration channel.
//
// The WHOOP 4.0 stores a raw respiration ADC (~1 Hz) in each V24 historical frame; WHOOP
// converts it to a rate in the cloud. On-device we approximate: band-pass the raw signal to the
// breathing band (subtract a slow moving average to detrend, smooth a fast one to denoise) then
// count respiratory cycles via hysteresis zero-crossings over the window. Count-based, so it is
// robust to the unknown ADC scale and polarity.
//
// APPROXIMATE — the raw→rate transfer is undocumented; treat as an estimate. Used as the
// lowest-weight recovery driver (0.05) and a displayed nightly metric.

export interface RespSample { ts: number; raw: number; }

export const RESP_MIN_BRPM = 4;
export const RESP_MAX_BRPM = 40;
const SMOOTH_WINDOW_S = 3; // short MA to denoise
const DETREND_WINDOW_S = 30; // long MA ≈ breathing-band high-pass cutoff
const MIN_WINDOW_S = 120; // need ≥ 2 min of signal for a stable rate

function medianDt(pts: RespSample[]): number {
  if (pts.length < 2) return 1;
  const gaps: number[] = [];
  for (let i = 1; i < pts.length; i++) {
    const g = pts[i].ts - pts[i - 1].ts;
    if (g > 0 && g < 300) gaps.push(g);
  }
  if (!gaps.length) return 1;
  gaps.sort((a, b) => a - b);
  return Math.max(1, gaps[gaps.length >> 1]);
}

/** Centered moving average (window in samples), via prefix sums. */
function movingAverage(xs: number[], win: number): number[] {
  const n = xs.length;
  if (win <= 1) return xs.slice();
  const half = win >> 1;
  const pre = new Array(n + 1).fill(0);
  for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + xs[i];
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - half);
    const hi = Math.min(n, i + half + 1);
    out[i] = (pre[hi] - pre[lo]) / (hi - lo);
  }
  return out;
}

function rms(xs: number[]): number {
  if (!xs.length) return 0;
  let s = 0;
  for (const v of xs) s += v * v;
  return Math.sqrt(s / xs.length);
}

/**
 * Estimate respiration rate (breaths/min) from raw respiration samples over a window, or null
 * when there is too little signal or the result is physiologically implausible.
 */
export function respRateFromRaw(samples: RespSample[]): number | null {
  const pts = samples.filter(s => Number.isFinite(s.raw)).sort((a, b) => a.ts - b.ts);
  if (pts.length < MIN_WINDOW_S) return null;

  const durMin = (pts[pts.length - 1].ts - pts[0].ts) / 60;
  if (durMin <= 0) return null;

  const raw = pts.map(p => p.raw);
  const dt = medianDt(pts);
  const sW = Math.max(1, Math.round(SMOOTH_WINDOW_S / dt));
  const dW = Math.max(3, Math.round(DETREND_WINDOW_S / dt));
  const smooth = movingAverage(raw, sW);
  const trend = movingAverage(raw, dW);
  const ac = smooth.map((v, i) => v - trend[i]);

  const amp = rms(ac);
  if (amp <= 0) return null;
  const thr = amp * 0.3; // hysteresis: a real breath swings well beyond noise

  // Count full cycles: arm on a trough below −thr, complete on a peak above +thr.
  let breaths = 0;
  let armed = false;
  for (const v of ac) {
    if (v < -thr) armed = true;
    else if (armed && v > thr) { breaths++; armed = false; }
  }
  if (breaths === 0) return null;

  const rate = breaths / durMin;
  if (rate < RESP_MIN_BRPM || rate > RESP_MAX_BRPM) return null;
  return Math.round(rate * 10) / 10;
}
