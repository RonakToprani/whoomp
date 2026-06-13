// Sleep — sleep/wake detection + APPROXIMATE 4-class staging (wake / light / deep / rem).
//
// HONEST HEDGING: these stages are APPROXIMATIONS, not PSG-validated, not medical advice. The
// EEG-free 4-class ceiling is ~65–73% epoch agreement (Walch 2019). Light/deep separation is the
// weakest link — deep-minute estimates are the least reliable output.
//
// Pipeline (30 s epochs), reimplemented in TypeScript and cross-checked against NOOP's SleepStager:
//   Stage 0  gravity-stillness sleep/wake spine → in-bed sessions. Cole–Kripke (te Lindert 30 s)
//            computed as a citable cross-check; HR confirms runs; a daytime false-nap guard.
//   Stage 1  per-epoch cardiorespiratory features over a rolling 5-min window (mean HR, DoG-HR
//            variability, RMSSD/SDNN from RR, respiration rate + RRV).
//   Stage 2  transparent percentile-band classifier → {wake, light, deep, rem}.
//   Stage 3  median smoothing + physiology re-imposition (no early REM; deep front-loaded).
//
// Gravity comes only from V24/V12 historical frames, so legacy nights stored before the channel
// migration fall back to an HR-only detector (analyzeNight picks automatically).

import { median, rangeFilter, cleanRR, rmssdRaw, sdnnRaw } from './hrv';
import { respRateFromRaw } from './resp';

export type Stage = 'wake' | 'light' | 'deep' | 'rem';
export const STAGES: Stage[] = ['wake', 'light', 'deep', 'rem'];

export interface HRSample { ts: number; bpm: number; }
export interface RRInterval { ts: number; rrMs: number; }
export interface RespSample { ts: number; raw: number; }
export interface GravitySample { ts: number; x: number; y: number; z: number; }

export interface StageSegment { start: number; end: number; stage: Stage; }

export interface SleepSession {
  start: number;
  end: number;
  efficiency: number; // asleep / in-bed, [0,1]
  stages: StageSegment[];
  restingHR: number | null;
  avgHRV: number | null;
  respRate: number | null;
}

// ── Stage 0 constants ──
const GRAVITY_STILL_THRESHOLD_G = 0.01;
const STILL_WINDOW_MIN = 15;
const STILL_FRACTION = 0.7;
const MAX_GAP_MIN = 20;
const MERGE_MIN = 15;
const MIN_SLEEP_MIN = 60;
const DEFAULT_INTERVAL_S = 60;
const MIN_WINDOW_SAMPLES = 3;
const HR_SLEEP_BASELINE_MULT = 1.05;
const HR_REFINE_MIN_SAMPLES = 30;
const ONSET_PERSIST_EPOCHS = 3;
// Daytime false-nap guard.
const DAYTIME_BAND_START_HOUR = 11;
const DAYTIME_BAND_END_HOUR = 20;
const DAYTIME_MIN_SLEEP_MIN = 90;
const DAYTIME_RESTING_HR_MULT = 0.95;
const SECONDS_PER_DAY = 86400;

// ── Stage 1–3 constants ──
const EPOCH_S = 30;
const FEATURE_WINDOW_S = 5 * 60;
const CK_COUNT_DIVISOR = 100;
const CK_COUNT_CLIP = 300;
const MOVE_DELTA_THRESHOLD_G = 0.01;
const HR_DOG_SIGMA1_S = 120;
const HR_DOG_SIGMA2_S = 600;
// Stage-classifier percentile bands. NOOP's originals (25/70/70/65/65/50) gated deep+REM so
// tightly that on a real WHOOP 4.0 gravity night they collapsed into Light (deep 18m / rem 55m vs
// a Fitbit-confirmed 73m / 84m for the same night). Loosened here against that ground truth:
// widen the low-HR + high-HR bands and lower the parasympathetic/RRV bars so the deep/REM
// signatures actually fire. Tuned on one night — re-check as more paired nights accumulate.
const STAGE_HR_LOW_PCT = 38;
const STAGE_HR_HIGH_PCT = 62;
const STAGE_HRV_HIGH_PCT = 50;
const STAGE_HRVAR_HIGH_PCT = 60;
const STAGE_RRV_HIGH_PCT = 55;
const STAGE_RRV_LOW_PCT = 55;
const STAGE_WAKE_MOVE_FRAC = 0.15;
const STAGE_STILL_MOVE_FRAC = 0.1;
const SMOOTH_EPOCHS = 5;
const NO_REM_AFTER_ONSET_MIN = 15;
// Deep is allowed across the first DEEP_FIRST_FRACTION of the night and trimmed only in the final
// stretch (pre-wake deep is implausible — you surface through light/REM). NOOP's strict 1/3 was the
// main bug: it zeroed real deep that occurs throughout the night (deep 0–18m on full nights). 0.9
// keeps a mild pre-wake guard while letting the feature gate place deep where it actually is.
const DEEP_FIRST_FRACTION = 0.9;
// te Lindert 30 s Cole–Kripke weights [A₋₄..A₊₂]. SI = 0.001·Σ wᵢ·Aᵢ; sleep iff SI<1.
const CK_WEIGHTS = [106, 54, 58, 76, 230, 74, 67];
const CK_SCALE = 0.001;
const CK_BACK = 4;

// ── Stats helpers ──
function mean(xs: number[]): number {
  if (!xs.length) return 0;
  let s = 0;
  for (const v of xs) s += v;
  return s / xs.length;
}
function stdevPop(xs: number[]): number {
  if (!xs.length) return 0;
  const m = mean(xs);
  let ss = 0;
  for (const v of xs) { const d = v - m; ss += d * d; }
  return Math.sqrt(ss / xs.length);
}
function percentileSorted(sorted: number[], pct: number): number {
  const n = sorted.length;
  if (n === 0) return NaN;
  if (n === 1) return sorted[0];
  const pos = (pct / 100) * (n - 1);
  const lo = Math.floor(pos);
  const hi = Math.min(lo + 1, n - 1);
  return sorted[lo] + (pos - lo) * (sorted[hi] - sorted[lo]);
}
/** numpy-style percentile over finite values; null when none. */
function percentile(values: number[], pct: number): number | null {
  const vals = values.filter(Number.isFinite).sort((a, b) => a - b);
  return vals.length ? percentileSorted(vals, pct) : null;
}
function rowsBetween<T extends { ts: number }>(rows: T[], start: number, end: number): T[] {
  return rows.filter(r => r.ts >= start && r.ts <= end);
}

// ── Gravity stillness → runs ──
function gravityDeltas(grav: GravitySample[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < grav.length; i++) {
    if (i === 0) { out.push(0); continue; }
    const p = grav[i - 1], r = grav[i];
    const dx = p.x - r.x, dy = p.y - r.y, dz = p.z - r.z;
    out.push(Math.sqrt(dx * dx + dy * dy + dz * dz));
  }
  return out;
}
function medianIntervalS(times: number[]): number {
  if (times.length < 2) return DEFAULT_INTERVAL_S;
  const gaps: number[] = [];
  for (let i = 0; i < times.length - 1; i++) {
    const g = times[i + 1] - times[i];
    if (g > 0 && g < 300) gaps.push(g);
  }
  if (!gaps.length) return DEFAULT_INTERVAL_S;
  gaps.sort((a, b) => a - b);
  return Math.max(gaps[gaps.length >> 1], 1);
}
function windowSize(times: number[]): number {
  return Math.max(MIN_WINDOW_SAMPLES, Math.floor((STILL_WINDOW_MIN * 60) / medianIntervalS(times)));
}
function classifyStill(grav: GravitySample[], deltas: number[]): boolean[] {
  const n = grav.length;
  if (n < 2) return new Array(n).fill(false);
  const half = windowSize(grav.map(g => g.ts)) >> 1;
  // O(n) prefix-sum window counts (the nested loop froze the app on long nights).
  const stillPrefix = new Array<number>(n + 1).fill(0);
  for (let i = 0; i < n; i++) stillPrefix[i + 1] = stillPrefix[i] + (deltas[i] < GRAVITY_STILL_THRESHOLD_G ? 1 : 0);
  const flags: boolean[] = [];
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - half);
    const hi = Math.min(n, i + half + 1);
    flags.push((stillPrefix[hi] - stillPrefix[lo]) / (hi - lo) >= STILL_FRACTION);
  }
  return flags;
}

interface Period { stage: 'sleep' | 'active'; start: number; end: number; }

function buildRuns(grav: GravitySample[], flags: boolean[]): Period[] {
  const n = grav.length;
  if (n === 0) return [];
  const times = grav.map(g => g.ts);
  const maxGapS = MAX_GAP_MIN * 60;
  const periods: Period[] = [];
  let runStart = 0;
  for (let i = 1; i <= n; i++) {
    let close: boolean;
    if (i === n) close = true;
    else close = flags[i] !== flags[runStart] || times[i] - times[i - 1] > maxGapS;
    if (close) {
      periods.push({ stage: flags[runStart] ? 'sleep' : 'active', start: times[runStart], end: times[i - 1] });
      runStart = i;
    }
  }
  return periods;
}
function mergePeriods(periods: Period[], mergeMinutes = MERGE_MIN): Period[] {
  if (!periods.length) return [];
  const pending = periods.slice();
  const thresholdS = mergeMinutes * 60;
  const merged: Period[] = [];
  let i = 0;
  while (i < pending.length) {
    const current = pending[i];
    const tooShort = current.end - current.start < thresholdS;
    if (!tooShort) { merged.push(current); i++; continue; }
    const hasPrev = i > 0 && merged.length > 0;
    const hasNext = i + 1 < pending.length;
    const bridgesSame = hasPrev && hasNext && pending[i - 1].stage === pending[i + 1].stage;
    if (bridgesSame) {
      const prev = merged.pop()!;
      merged.push({ stage: prev.stage, start: prev.start, end: pending[i + 1].end });
      i += 2;
    } else if (hasNext) {
      pending[i + 1] = { stage: pending[i + 1].stage, start: current.start, end: pending[i + 1].end };
      i++;
    } else if (hasPrev) {
      const prev = merged.pop()!;
      merged.push({ stage: prev.stage, start: prev.start, end: current.end });
      i++;
    } else i++;
  }
  return merged;
}

// ── HR refinement ──
function hrBaseline(hr: HRSample[]): number | null {
  if (!hr.length) return null;
  return median(hr.map(h => h.bpm));
}
function confirmSleepWithHR(p: Period, hr: HRSample[], baseline: number | null): boolean {
  if (baseline == null) return true;
  const seg = rowsBetween(hr, p.start, p.end);
  if (seg.length < HR_REFINE_MIN_SAMPLES) return true;
  return mean(seg.map(s => s.bpm)) <= baseline * HR_SLEEP_BASELINE_MULT;
}
function isDaytimeCenter(p: Period, tzOffsetSeconds: number): boolean {
  const center = p.start + Math.floor((p.end - p.start) / 2);
  const local = center + tzOffsetSeconds;
  const secOfDay = ((local % SECONDS_PER_DAY) + SECONDS_PER_DAY) % SECONDS_PER_DAY;
  const hour = Math.floor(secOfDay / 3600);
  return hour >= DAYTIME_BAND_START_HOUR && hour < DAYTIME_BAND_END_HOUR;
}
function passesDaytimeGuard(p: Period, restingHR: number | null, baseline: number | null): boolean {
  if (p.end - p.start < DAYTIME_MIN_SLEEP_MIN * 60) return false;
  if (baseline == null || restingHR == null) return false;
  return restingHR <= baseline * DAYTIME_RESTING_HR_MULT;
}

// ── Epoch grid ──
interface EpochGrid {
  edges: number[];
  counts: number[]; // per-epoch summed |Δgravity|
  moveFrac: number[];
  hr: number[]; // per-epoch mean HR or NaN
  rr: number[][];
  resp: number[][];
  nEpochs: number;
}
function buildEpochGrid(
  start: number, end: number,
  gravTimes: number[], gravDeltas: number[],
  hr: HRSample[], rr: RRInterval[], resp: RespSample[],
): EpochGrid {
  if (end <= start) return { edges: [start], counts: [], moveFrac: [], hr: [], rr: [], resp: [], nEpochs: 0 };
  const nEpochs = Math.max(1, Math.ceil((end - start) / EPOCH_S));
  const edges = Array.from({ length: nEpochs + 1 }, (_, i) => start + i * EPOCH_S);
  edges[nEpochs] = Math.max(edges[nEpochs], end);

  const counts = new Array(nEpochs).fill(0);
  const moveN = new Array(nEpochs).fill(0);
  const gravN = new Array(nEpochs).fill(0);
  const hrSum = new Array(nEpochs).fill(0);
  const hrCnt = new Array(nEpochs).fill(0);
  const rrBuckets: number[][] = Array.from({ length: nEpochs }, () => []);
  const respBuckets: number[][] = Array.from({ length: nEpochs }, () => []);

  const idx = (ts: number): number | null => {
    if (ts < start || ts >= end) { return ts === end ? nEpochs - 1 : null; }
    return Math.min(Math.floor((ts - start) / EPOCH_S), nEpochs - 1);
  };
  for (let k = 0; k < gravTimes.length; k++) {
    const i = idx(gravTimes[k]);
    if (i == null) continue;
    counts[i] += gravDeltas[k];
    gravN[i]++;
    if (gravDeltas[k] >= MOVE_DELTA_THRESHOLD_G) moveN[i]++;
  }
  for (const r of hr) { const i = idx(r.ts); if (i == null) continue; hrSum[i] += r.bpm; hrCnt[i]++; }
  for (const r of rr) { const i = idx(r.ts); if (i == null) continue; rrBuckets[i].push(r.rrMs); }
  for (const r of resp) { const i = idx(r.ts); if (i == null) continue; respBuckets[i].push(r.raw); }

  const hrMean = Array.from({ length: nEpochs }, (_, i) => (hrCnt[i] > 0 ? hrSum[i] / hrCnt[i] : NaN));
  // No gravity coverage → treat as moving (conservative).
  const moveFrac = Array.from({ length: nEpochs }, (_, i) => (gravN[i] > 0 ? moveN[i] / gravN[i] : 1));
  return { edges, counts, moveFrac, hr: hrMean, rr: rrBuckets, resp: respBuckets, nEpochs };
}

// ── Cole–Kripke ──
function rescaleCounts(counts: number[]): number[] {
  return counts.map(c => Math.min(c / CK_COUNT_DIVISOR, CK_COUNT_CLIP));
}
function coleKripke(rescaled: number[]): boolean[] {
  const n = rescaled.length;
  const flags: boolean[] = [];
  for (let i = 0; i < n; i++) {
    let si = 0;
    for (let k = 0; k < CK_WEIGHTS.length; k++) {
      const j = i - CK_BACK + k;
      si += CK_WEIGHTS[k] * (j >= 0 && j < n ? rescaled[j] : 0);
    }
    flags.push(si * CK_SCALE < 1);
  }
  return flags;
}
function onsetAndFinalWake(ckFlags: boolean[]): [number, number] {
  const n = ckFlags.length;
  if (n === 0) return [0, 0];
  let onset: number | null = null;
  let run = 0;
  for (let i = 0; i < n; i++) {
    run = ckFlags[i] ? run + 1 : 0;
    if (run >= ONSET_PERSIST_EPOCHS) { onset = i - ONSET_PERSIST_EPOCHS + 1; break; }
  }
  let final: number | null = null;
  for (let i = n - 1; i >= 0; i--) if (ckFlags[i]) { final = i; break; }
  const o = onset ?? 0;
  let f = final ?? n - 1;
  if (f < o) f = n - 1;
  return [o, f];
}

// ── Walch difference-of-Gaussians HR variability ──
function gaussianKernel(sigmaS: number, dtS = EPOCH_S): number[] {
  const sigma = Math.max(sigmaS / dtS, 1e-6);
  const radius = Math.max(1, Math.ceil(3 * sigma));
  const k: number[] = [];
  for (let x = -radius; x <= radius; x++) k.push(Math.exp(-0.5 * Math.pow(x / sigma, 2)));
  const sum = k.reduce((a, b) => a + b, 0);
  return k.map(v => v / sum);
}
function convolveReflect(x: number[], kernel: number[]): number[] {
  const r = kernel.length >> 1;
  if (r === 0 || x.length === 0) return x.slice();
  const padded: number[] = [];
  for (let i = 0; i < r; i++) padded.push(x[r - i]);
  padded.push(...x);
  for (let i = 0; i < r; i++) padded.push(x[x.length - 2 - i]);
  const out: number[] = [];
  const m = kernel.length;
  for (let i = 0; i <= padded.length - m; i++) {
    let acc = 0;
    for (let j = 0; j < m; j++) acc += padded[i + j] * kernel[m - 1 - j];
    out.push(acc);
    if (out.length === x.length) break;
  }
  return out;
}
function dogHRVariability(hrPerEpoch: number[]): number[] {
  const n = hrPerEpoch.length;
  if (n === 0) return [];
  const maskIdx = [];
  for (let i = 0; i < n; i++) if (!Number.isNaN(hrPerEpoch[i])) maskIdx.push(i);
  if (!maskIdx.length) return new Array(n).fill(0);
  const first = maskIdx[0], last = maskIdx[maskIdx.length - 1];
  const filled = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i++) {
    if (!Number.isNaN(hrPerEpoch[i])) { filled[i] = hrPerEpoch[i]; continue; }
    if (i <= first) { filled[i] = hrPerEpoch[first]; continue; }
    if (i >= last) { filled[i] = hrPerEpoch[last]; continue; }
    let lo = first, hi = last;
    for (const m of maskIdx) { if (m <= i) lo = m; if (m >= i) { hi = m; break; } }
    filled[i] = hi === lo ? hrPerEpoch[lo] : hrPerEpoch[lo] + ((i - lo) / (hi - lo)) * (hrPerEpoch[hi] - hrPerEpoch[lo]);
  }
  const g1 = convolveReflect(filled, gaussianKernel(HR_DOG_SIGMA1_S));
  const g2 = convolveReflect(filled, gaussianKernel(HR_DOG_SIGMA2_S));
  return Array.from({ length: n }, (_, i) => g1[i] - g2[i]);
}

// ── Respiration rate + RRV per feature window (raw ADC) ──
function findPeaks(x: number[], distance: number, height: number): number[] {
  const n = x.length;
  if (n < 3) return [];
  const candidates: number[] = [];
  let i = 1;
  while (i < n - 1) {
    if (x[i] > x[i - 1] && x[i] >= height) {
      let j = i;
      while (j + 1 < n && x[j + 1] === x[i]) j++;
      if (j + 1 < n && x[j + 1] < x[i]) candidates.push((i + j) >> 1);
      i = j + 1;
    } else i++;
  }
  if (distance <= 1 || !candidates.length) return candidates;
  const byHeight = candidates.slice().sort((a, b) => x[b] - x[a]);
  const keep = new Map<number, boolean>(candidates.map(c => [c, true]));
  for (const p of byHeight) {
    if (!keep.get(p)) continue;
    for (const q of candidates) if (q !== p && keep.get(q) && Math.abs(q - p) < distance) keep.set(q, false);
  }
  return candidates.filter(c => keep.get(c)).sort((a, b) => a - b);
}
function respRateAndRRV(respRaw: number[], dtS = 1): [number, number] {
  const NAN: [number, number] = [NaN, NaN];
  if (respRaw.length < 8) return NAN;
  const m = mean(respRaw);
  const x = respRaw.map(v => v - m);
  if (x.every(v => Math.abs(v) < 1e-12)) return NAN;
  if (stdevPop(x) <= 0) return NAN;
  const minDistance = Math.max(2, Math.round(2 / dtS));
  const peaks = findPeaks(x, minDistance, 0);
  if (peaks.length < 3) return NAN;
  const intervals: number[] = [];
  for (let i = 1; i < peaks.length; i++) {
    const iv = (peaks[i] - peaks[i - 1]) * dtS;
    if (iv >= 1.5 && iv <= 12) intervals.push(iv);
  }
  if (intervals.length < 2) return NAN;
  return [60 / median(intervals), stdevPop(intervals)];
}

// ── Respiration rate from R-R (RSA) ──
// WHOOP stores a raw respiration ADC, but it is "resp rate computed server-side" — not a clean
// countable breathing waveform, so the raw-channel peak counter (respRateFromRaw) returns null in
// practice (the live "--"). The robust on-device path, shipped by NOOP, recovers the breathing rate
// from respiratory sinus arrhythmia (RSA): breathing modulates beat-to-beat timing, so the R-R
// tachogram oscillates at the breathing frequency. Faithful port of NOOP SleepStager.respRateFromRR.
const RSA_RESAMPLE_HZ = 4.0;          // standard HRV resample grid
const RSA_DETREND_WINDOW_S = 8.0;     // moving-mean detrend window
const RSA_MIN_PEAK_DISTANCE_S = 2.5;  // ≤24 bpm
const RSA_WINDOW_S = 300.0;           // per-window estimate length (5 min)
const RSA_MIN_BREATH_INTERVAL_S = 2.5; // 24 bpm
const RSA_MAX_BREATH_INTERVAL_S = 10.0; // 6 bpm
// Canonical plausible sleeping respiratory band (bpm); estimates outside → null (honest no-data).
export const RESP_RSA_MIN_BPM = 8.0;
export const RESP_RSA_MAX_BPM = 25.0;

/**
 * APPROXIMATE respiratory rate (breaths/min) from the R-R interval stream over an in-bed session
 * via respiratory sinus arrhythmia. An on-device ESTIMATE (tracks but does not equal a chest-band
 * rate); null when too few intervals survive or the result is outside the plausible band.
 */
export function respRateFromRR(rr: RRInterval[], start: number, end: number): number | null {
  if (end <= start) return null;
  // 1. In-bed R-R in chronological order, range-filtered (drop dropouts/ectopics).
  const inBed = rr.filter(r => r.ts >= start && r.ts <= end).sort((a, b) => a.ts - b.ts).map(r => r.rrMs);
  const filtered = rangeFilter(inBed);
  if (filtered.length < 30) return null;

  // 2. Beat times (s from session start) via cumulative sum of kept intervals.
  const beatTimes = new Array<number>(filtered.length);
  let acc = 0;
  for (let i = 0; i < filtered.length; i++) { acc += filtered[i] / 1000; beatTimes[i] = acc; }
  const totalSpanS = beatTimes[beatTimes.length - 1];
  if (totalSpanS < RSA_WINDOW_S / 2) return null;

  // 3. Resample the tachogram onto a uniform 4 Hz grid (linear interpolation).
  const dt = 1 / RSA_RESAMPLE_HZ;
  const nGrid = Math.floor(totalSpanS / dt) + 1;
  if (nGrid < 8) return null;
  const grid = new Array<number>(nGrid);
  let seg = 0;
  for (let g = 0; g < nGrid; g++) {
    const t = g * dt;
    while (seg < beatTimes.length - 2 && beatTimes[seg + 1] < t) seg++;
    const t0 = beatTimes[seg], t1 = beatTimes[seg + 1];
    const v0 = filtered[seg], v1 = filtered[seg + 1];
    grid[g] = t1 <= t0 ? v0 : v0 + Math.min(Math.max((t - t0) / (t1 - t0), 0), 1) * (v1 - v0);
  }

  // 4. Detrend: subtract a centered moving mean (removes slow LF/baseline drift).
  const halfW = Math.max(1, Math.round(RSA_DETREND_WINDOW_S * RSA_RESAMPLE_HZ / 2));
  const detrended = new Array<number>(nGrid);
  for (let i = 0; i < nGrid; i++) {
    const lo = Math.max(0, i - halfW), hi = Math.min(nGrid - 1, i + halfW);
    let sum = 0;
    for (let j = lo; j <= hi; j++) sum += grid[j];
    detrended[i] = grid[i] - sum / (hi - lo + 1);
  }
  if (stdevPop(detrended) <= 1e-9) return null; // flat → no RSA

  // 5. Per ~5-min window: peak-pick → 60/median(breath interval); median across windows.
  const minDistSamples = Math.max(2, Math.round(RSA_MIN_PEAK_DISTANCE_S * RSA_RESAMPLE_HZ));
  const windowSamples = Math.max(minDistSamples * 3, Math.round(RSA_WINDOW_S * RSA_RESAMPLE_HZ));
  const perWindowRates: number[] = [];
  let w = 0;
  while (w < nGrid) {
    const wEnd = Math.min(nGrid, w + windowSamples);
    if (wEnd - w >= minDistSamples * 3) {
      const winSeg = detrended.slice(w, wEnd);
      const peaks = findPeaks(winSeg, minDistSamples, 0);
      if (peaks.length >= 3) {
        const intervals: number[] = [];
        for (let i = 1; i < peaks.length; i++) {
          const ivS = (peaks[i] - peaks[i - 1]) * dt;
          if (ivS >= RSA_MIN_BREATH_INTERVAL_S && ivS <= RSA_MAX_BREATH_INTERVAL_S) intervals.push(ivS);
        }
        if (intervals.length >= 2) {
          const med = median(intervals);
          if (med > 0) perWindowRates.push(60 / med);
        }
      }
    }
    w += windowSamples;
  }
  if (!perWindowRates.length) return null;
  const m = median(perWindowRates);
  return (m >= RESP_RSA_MIN_BPM && m <= RESP_RSA_MAX_BPM) ? Math.round(m * 10) / 10 : null;
}

// ── Per-epoch features + classifier ──
interface EpochFeatures {
  index: number; count: number; moveFrac: number; ckSleep: boolean;
  hr: number; hrVar: number; rmssd: number; respRate: number; rrv: number; clock: number;
}
function extractFeatures(grid: EpochGrid, ckFlags: boolean[], dogHR: number[], onsetIdx: number, finalWakeIdx: number): EpochFeatures[] {
  const n = grid.nEpochs;
  const rescaled = rescaleCounts(grid.counts);
  const halfW = Math.round(FEATURE_WINDOW_S / EPOCH_S / 2);
  const span = Math.max(1, finalWakeIdx - onsetIdx);
  const feats: EpochFeatures[] = [];
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - halfW);
    const hi = Math.min(n, i + halfW + 1);
    const winHR: number[] = [];
    for (let j = lo; j < hi; j++) if (!Number.isNaN(grid.hr[j])) winHR.push(grid.hr[j]);
    const hrMean = winHR.length ? mean(winHR) : NaN;
    const winDog: number[] = [];
    for (let j = lo; j < hi; j++) winDog.push(dogHR.length ? dogHR[j] : 0);
    const hrVar = winDog.length >= 2 ? stdevPop(winDog) : NaN;
    const winRR: number[] = [];
    for (let j = lo; j < hi; j++) winRR.push(...grid.rr[j]);
    const filteredRR = rangeFilter(winRR);
    const rmssd = filteredRR.length >= 5 ? (rmssdRaw(filteredRR) ?? NaN) : NaN;
    const winResp: number[] = [];
    for (let j = lo; j < hi; j++) winResp.push(...grid.resp[j]);
    const [respRate, rrv] = respRateAndRRV(winResp);
    const clock = Math.min(1, Math.max(0, (i - onsetIdx) / span));
    feats.push({
      index: i, count: rescaled[i], moveFrac: grid.moveFrac[i],
      ckSleep: i < ckFlags.length ? ckFlags[i] : true,
      hr: hrMean, hrVar, rmssd, respRate, rrv, clock,
    });
  }
  return feats;
}
function classifyOne(
  f: EpochFeatures,
  hrLo: number | null, hrHi: number | null, rmssdHi: number | null,
  hrvarHi: number | null, rrvHi: number | null, rrvLo: number | null,
): Stage {
  const hasHR = Number.isFinite(f.hr);
  const hrLow = hasHR && hrLo != null && f.hr <= hrLo;
  const hrHigh = hasHR && hrHi != null && f.hr >= hrHi;
  // Missing per-epoch RMSSD is treated as pro-deep (sparse RR shouldn't block a real depth signature).
  const parasympOK = !Number.isFinite(f.rmssd) || (rmssdHi != null && f.rmssd >= rmssdHi);
  const hrvarHigh = Number.isFinite(f.hrVar) && hrvarHi != null && f.hrVar >= hrvarHi;
  const cardiacActivated = hrHigh || hrvarHigh;
  const rrvIrregular = Number.isFinite(f.rrv) && rrvHi != null && f.rrv >= rrvHi;
  const rrvRegular = !Number.isFinite(f.rrv) || (rrvLo != null && f.rrv <= rrvLo);
  const still = f.moveFrac <= STAGE_STILL_MOVE_FRAC;
  const moving = f.moveFrac >= STAGE_WAKE_MOVE_FRAC;
  if (moving && (cardiacActivated || !hasHR)) return 'wake';
  if (still && parasympOK && hrLow && rrvRegular) return 'deep';
  if (still && cardiacActivated && rrvIrregular) return 'rem';
  if (still && hrHigh && hrvarHigh && !Number.isFinite(f.rrv)) return 'rem';
  return 'light';
}
function classifyEpochs(features: EpochFeatures[]): Stage[] {
  if (!features.length) return [];
  const sleepFeats = features.some(f => f.ckSleep) ? features.filter(f => f.ckSleep) : features;
  const hrLo = percentile(sleepFeats.map(f => f.hr), STAGE_HR_LOW_PCT);
  const hrHi = percentile(sleepFeats.map(f => f.hr), STAGE_HR_HIGH_PCT);
  const rmssdHi = percentile(sleepFeats.map(f => f.rmssd), STAGE_HRV_HIGH_PCT);
  const hrvarHi = percentile(sleepFeats.map(f => f.hrVar), STAGE_HRVAR_HIGH_PCT);
  const rrvHi = percentile(sleepFeats.map(f => f.rrv), STAGE_RRV_HIGH_PCT);
  const rrvLo = percentile(sleepFeats.map(f => f.rrv), STAGE_RRV_LOW_PCT);
  return features.map(f => classifyOne(f, hrLo, hrHi, rmssdHi, hrvarHi, rrvHi, rrvLo));
}
function smoothLabels(labels: Stage[], window = SMOOTH_EPOCHS): Stage[] {
  const n = labels.length;
  if (n === 0 || window <= 1) return labels;
  let w = window;
  if (w % 2 === 0) w++;
  const half = w >> 1;
  const out: Stage[] = [];
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - half);
    const hi = Math.min(n, i + half + 1);
    const counts = new Map<Stage, number>();
    const order: Stage[] = [];
    for (let j = lo; j < hi; j++) {
      const s = labels[j];
      if (!counts.has(s)) order.push(s);
      counts.set(s, (counts.get(s) ?? 0) + 1);
    }
    const best = Math.max(...counts.values());
    const winners = order.filter(s => counts.get(s) === best);
    out.push(winners.includes(labels[i]) ? labels[i] : winners[0]);
  }
  return out;
}
function reimposePhysiology(labels: Stage[], features: EpochFeatures[], onsetIdx: number, finalWakeIdx: number): Stage[] {
  const out = labels.slice();
  const noREMEpochs = Math.round((NO_REM_AFTER_ONSET_MIN * 60) / EPOCH_S);
  const hasEarlyDeep = labels.some((s, i) => s === 'deep' && features[i].clock <= DEEP_FIRST_FRACTION);
  for (let i = 0; i < features.length; i++) {
    if (i < onsetIdx || i > finalWakeIdx) continue;
    if (out[i] === 'rem' && i - onsetIdx < noREMEpochs) out[i] = 'light';
    if (out[i] === 'deep' && features[i].clock > DEEP_FIRST_FRACTION && hasEarlyDeep) out[i] = 'light';
  }
  return out;
}

// ── stageSession ──
function stageSession(start: number, end: number, grav: GravitySample[], hr: HRSample[], rr: RRInterval[], resp: RespSample[]): StageSegment[] {
  const gSeg = rowsBetween(grav, start, end);
  if (gSeg.length < 2) return [{ start, end, stage: 'light' }];
  const grid = buildEpochGrid(start, end, gSeg.map(g => g.ts), gravityDeltas(gSeg), rowsBetween(hr, start, end), rowsBetween(rr, start, end), rowsBetween(resp, start, end));
  if (grid.nEpochs === 0) return [{ start, end, stage: 'light' }];
  const ckFlags = coleKripke(rescaleCounts(grid.counts));
  const [onsetIdx, finalWakeIdx] = onsetAndFinalWake(ckFlags);
  const dogHR = dogHRVariability(grid.hr);
  const feats = extractFeatures(grid, ckFlags, dogHR, onsetIdx, finalWakeIdx);
  let labels = classifyEpochs(feats);
  labels = smoothLabels(labels);
  labels = reimposePhysiology(labels, feats, onsetIdx, finalWakeIdx);
  for (let i = 0; i < labels.length; i++) if (i < onsetIdx || i > finalWakeIdx) labels[i] = 'wake';

  const segments: StageSegment[] = [];
  for (let i = 0; i < labels.length; i++) {
    const segStart = Math.round(grid.edges[i]);
    const segEnd = Math.round(grid.edges[i + 1]);
    const last = segments[segments.length - 1];
    if (last && last.stage === labels[i]) last.end = segEnd;
    else segments.push({ start: segStart, end: segEnd, stage: labels[i] });
  }
  if (segments.length) segments[segments.length - 1].end = end;
  return segments;
}

// ── Per-session HR / HRV / efficiency ──
function sessionRestingHR(start: number, end: number, hr: HRSample[]): number | null {
  const seg = rowsBetween(hr, start, end);
  if (!seg.length) return null;
  const windowS = 5 * 60;
  const means: number[] = [];
  for (let t = start; t < end; t += windowS) {
    const win = seg.filter(s => s.ts >= t && s.ts < t + windowS);
    if (win.length) means.push(mean(win.map(s => s.bpm)));
  }
  if (means.length) return Math.round(Math.min(...means));
  return Math.round(mean(seg.map(s => s.bpm)));
}
function sessionAvgHRV(start: number, end: number, rr: RRInterval[]): number | null {
  const seg = rowsBetween(rr, start, end);
  if (!seg.length) return null;
  const windowS = 5 * 60;
  const vals: number[] = [];
  for (let t = start; t < end; t += windowS) {
    const bucket = seg.filter(s => s.ts >= t && s.ts < t + windowS).map(s => s.rrMs);
    // Full clean (range + Malik ectopic) — PPG-derived RR has occasional doubled/missed beats that
    // a bare range filter lets through and that massively inflate RMSSD (the 172 ms artifact).
    const filtered = cleanRR(bucket);
    if (filtered.length >= 5) { const r = rmssdRaw(filtered); if (r != null) vals.push(r); }
  }
  return vals.length ? mean(vals) : null;
}
function efficiency(start: number, end: number, stages: StageSegment[]): number {
  const inBed = end - start;
  if (inBed <= 0) return 0;
  const wake = stages.filter(s => s.stage === 'wake').reduce((a, s) => a + (s.end - s.start), 0);
  return Math.min(1, Math.max(0, inBed - wake) / inBed);
}

export interface DetectSleepInput {
  hr?: HRSample[];
  rr?: RRInterval[];
  resp?: RespSample[];
  gravity: GravitySample[];
  tzOffsetSeconds?: number;
}

/** Detect sleep sessions from gravity + biometric streams. Empty/absent gravity → []. */
export function detectSleep({ hr = [], rr = [], resp = [], gravity, tzOffsetSeconds = 0 }: DetectSleepInput): SleepSession[] {
  const grav = gravity.slice().sort((a, b) => a.ts - b.ts);
  if (grav.length < 2) return [];
  const hrS = hr.slice().sort((a, b) => a.ts - b.ts);
  const rrS = rr.slice().sort((a, b) => a.ts - b.ts);
  const respS = resp.slice().sort((a, b) => a.ts - b.ts);

  const runs = mergePeriods(buildRuns(grav, classifyStill(grav, gravityDeltas(grav))));
  const baseline = hrBaseline(hrS);
  const minSleepS = MIN_SLEEP_MIN * 60;
  const sessions: SleepSession[] = [];
  for (const p of runs) {
    if (p.stage !== 'sleep' || p.end - p.start <= minSleepS) continue;
    if (!confirmSleepWithHR(p, hrS, baseline)) continue;
    const resting = sessionRestingHR(p.start, p.end, hrS);
    if (isDaytimeCenter(p, tzOffsetSeconds) && !passesDaytimeGuard(p, resting, baseline)) continue;
    const stages = stageSession(p.start, p.end, grav, hrS, rrS, respS);
    const respRate = respRateFromRaw(respS.filter(r => r.ts >= p.start && r.ts <= p.end));
    sessions.push({
      start: p.start, end: p.end, efficiency: efficiency(p.start, p.end, stages),
      stages, restingHR: resting, avgHRV: sessionAvgHRV(p.start, p.end, rrS), respRate,
    });
  }
  return sessions.sort((a, b) => a.start - b.start);
}

// ── HR-only fallback (legacy nights with no gravity) ──
const HR_ONLY_BRIDGE_MS = 30 * 60_000;

/**
 * Coarse sleep detection from HR (+RR) alone, for nights stored before the gravity migration.
 * Detects the main low-HR span in the night, then stages by HR/HRV percentiles (no motion).
 */
export function detectSleepHrOnly(hr: HRSample[], rr: RRInterval[] = []): SleepSession[] {
  const pts = hr.filter(h => Number.isFinite(h.bpm)).slice().sort((a, b) => a.ts - b.ts);
  if (pts.length < 10) return [];
  const sortedHr = pts.map(p => p.bpm).sort((a, b) => a - b);
  const robustMin = sortedHr[Math.floor(sortedHr.length * 0.05)];
  const threshold = Math.min(95, robustMin + 20);
  const asleep = pts.filter(p => p.bpm <= threshold).map(p => p.ts * 1000);
  if (!asleep.length) return [];
  const spans: [number, number][] = [];
  let s = asleep[0], e = asleep[0];
  for (let i = 1; i < asleep.length; i++) {
    if (asleep[i] - e <= HR_ONLY_BRIDGE_MS) e = asleep[i];
    else { spans.push([s, e]); s = asleep[i]; e = asleep[i]; }
  }
  spans.push([s, e]);
  let best: [number, number] | null = null;
  for (const [a, b] of spans) {
    if ((b - a) / 60000 < MIN_SLEEP_MIN) continue;
    if (!best || b - a > best[1] - best[0]) best = [a, b];
  }
  if (!best) return [];
  const start = Math.floor(best[0] / 1000), end = Math.floor(best[1] / 1000);
  const stages = stageSessionHrOnly(start, end, rowsBetween(pts, start, end), rowsBetween(rr, start, end));
  return [{
    start, end, efficiency: efficiency(start, end, stages),
    stages, restingHR: sessionRestingHR(start, end, pts), avgHRV: sessionAvgHRV(start, end, rr), respRate: null,
  }];
}
function stageSessionHrOnly(start: number, end: number, hr: HRSample[], rr: RRInterval[]): StageSegment[] {
  const grid = buildEpochGrid(start, end, [], [], hr, rr, []);
  if (grid.nEpochs === 0) return [{ start, end, stage: 'light' }];
  const halfW = Math.round(FEATURE_WINDOW_S / EPOCH_S / 2);
  const hrVals: number[] = [], rmssdVals: number[] = [];
  const epochHr: number[] = [], epochRmssd: number[] = [];
  for (let i = 0; i < grid.nEpochs; i++) {
    const lo = Math.max(0, i - halfW), hi = Math.min(grid.nEpochs, i + halfW + 1);
    const wh: number[] = [];
    for (let j = lo; j < hi; j++) if (!Number.isNaN(grid.hr[j])) wh.push(grid.hr[j]);
    const h = wh.length ? mean(wh) : NaN;
    const wr: number[] = [];
    for (let j = lo; j < hi; j++) wr.push(...grid.rr[j]);
    const fr = rangeFilter(wr);
    const rm = fr.length >= 5 ? (rmssdRaw(fr) ?? NaN) : NaN;
    epochHr.push(h); epochRmssd.push(rm);
    if (Number.isFinite(h)) hrVals.push(h);
    if (Number.isFinite(rm)) rmssdVals.push(rm);
  }
  const hrLo = percentile(hrVals, STAGE_HR_LOW_PCT);
  const hrHi = percentile(hrVals, STAGE_HR_HIGH_PCT);
  const rmssdHi = percentile(rmssdVals, STAGE_HRV_HIGH_PCT);
  let labels: Stage[] = epochHr.map((h, i) => {
    if (!Number.isFinite(h)) return 'wake';
    if (hrHi != null && h >= hrHi && rmssdHi != null && Number.isFinite(epochRmssd[i]) && epochRmssd[i] < rmssdHi) return 'rem';
    if (hrLo != null && h <= hrLo && (!Number.isFinite(epochRmssd[i]) || (rmssdHi != null && epochRmssd[i] >= rmssdHi))) return 'deep';
    return 'light';
  });
  labels = smoothLabels(labels);
  const segments: StageSegment[] = [];
  for (let i = 0; i < labels.length; i++) {
    const segStart = Math.round(grid.edges[i]);
    const segEnd = Math.round(grid.edges[i + 1]);
    const last = segments[segments.length - 1];
    if (last && last.stage === labels[i]) last.end = segEnd;
    else segments.push({ start: segStart, end: segEnd, stage: labels[i] });
  }
  if (segments.length) segments[segments.length - 1].end = end;
  return segments;
}

// ── Public conveniences ──
export function stageTotals(stages: Iterable<StageSegment>): Record<Stage, number> {
  const totals: Record<Stage, number> = { wake: 0, light: 0, deep: 0, rem: 0 };
  for (const s of stages) totals[s.stage] += (s.end - s.start) / 60;
  for (const k of STAGES) totals[k] = Math.round(totals[k]);
  return totals;
}

/**
 * Unified nightly entry: use the gravity stager when enough accelerometer data is present,
 * else the HR-only fallback. Returns the single best (longest) session, or null.
 */
export function analyzeNight(input: DetectSleepInput): SleepSession | null {
  const useGravity = input.gravity.length >= 120;
  const sessions = useGravity ? detectSleep(input) : detectSleepHrOnly(input.hr ?? [], input.rr ?? []);
  if (!sessions.length) return null;
  return sessions.reduce((best, s) => (s.end - s.start > best.end - best.start ? s : best));
}

/** Aggregated whole-night summary across ALL detected sessions (not just the longest). */
export interface NightSummary {
  start: number; // earliest session start
  end: number;   // latest session end
  sessions: SleepSession[];
  stages: StageSegment[]; // every session's segments, concatenated in time order (for the hypnogram)
  asleepMin: number; // total sleep time (deep + rem + light) summed across sessions
  deepMin: number;
  remMin: number;
  lightMin: number;
  wakeMin: number;
  efficiency: number;       // in-bed-weighted mean efficiency
  restingHR: number | null; // lowest resting HR across sessions
  avgHRV: number | null;    // in-bed-weighted mean HRV
  respRate: number | null;  // median of per-session RSA estimates
}

/**
 * Combine detected sessions into one night, mirroring NOOP's AnalyticsEngine.analyzeDay: a real
 * night frequently fragments into several in-bed runs (a bathroom trip, a restless stretch, or a
 * BLE/data gap > maxGapMin all split the gravity-stillness spine). Reporting only the single
 * longest run — as the old analyzeNight consumer did — undercounts a 7 h night to whichever chunk
 * happened to be longest (~3 h). Here we sum the time asleep across every run instead.
 */
export function summarizeNight(sessions: SleepSession[], rr: RRInterval[] = []): NightSummary | null {
  if (!sessions.length) return null;
  const sorted = sessions.slice().sort((a, b) => a.start - b.start);

  let deepS = 0, remS = 0, lightS = 0, wakeS = 0, inBedS = 0, effWeighted = 0;
  const stages: StageSegment[] = [];
  for (const s of sorted) {
    for (const seg of s.stages) {
      const dur = seg.end - seg.start;
      if (seg.stage === 'deep') deepS += dur;
      else if (seg.stage === 'rem') remS += dur;
      else if (seg.stage === 'light') lightS += dur;
      else wakeS += dur;
    }
    const inBed = s.end - s.start;
    inBedS += inBed;
    effWeighted += s.efficiency * inBed;
    stages.push(...s.stages);
  }

  const restingHRs = sorted.map(s => s.restingHR).filter((x): x is number => x != null);
  const restingHR = restingHRs.length ? Math.min(...restingHRs) : null;

  const hrvPairs = sorted
    .filter(s => s.avgHRV != null)
    .map(s => [s.avgHRV as number, s.end - s.start] as const);
  const hrvWeight = hrvPairs.reduce((a, [, w]) => a + w, 0);
  const avgHRV = hrvWeight > 0 ? hrvPairs.reduce((a, [v, w]) => a + v * w, 0) / hrvWeight : null;

  const resps = sorted.map(s => respRateFromRR(rr, s.start, s.end)).filter((x): x is number => x != null);
  const respRate = resps.length ? Math.round(median(resps) * 10) / 10 : null;

  return {
    start: sorted[0].start,
    end: sorted[sorted.length - 1].end,
    sessions: sorted,
    stages,
    asleepMin: Math.round((deepS + remS + lightS) / 60),
    deepMin: Math.round(deepS / 60),
    remMin: Math.round(remS / 60),
    lightMin: Math.round(lightS / 60),
    wakeMin: Math.round(wakeS / 60),
    efficiency: inBedS > 0 ? effWeighted / inBedS : 0,
    restingHR,
    avgHRV,
    respRate,
  };
}

/** Detect + aggregate the whole night into one summary (the value the dashboard rolls up). */
export function analyzeNightSummary(input: DetectSleepInput): NightSummary | null {
  const useGravity = input.gravity.length >= 120;
  const sessions = useGravity ? detectSleep(input) : detectSleepHrOnly(input.hr ?? [], input.rr ?? []);
  return summarizeNight(sessions, input.rr ?? []);
}

export function sleepPerformance(asleepMinutes: number, needMinutes: number): number {
  if (needMinutes <= 0) return 0;
  return Math.round(Math.min(100, (100 * asleepMinutes) / needMinutes) * 10) / 10;
}

export const BASE_SLEEP_MINUTES = 480;
export function sleepNeedMinutes(priorDebtMinutes: number, strainYesterday: number): number {
  const debtBump = Math.min(120, Math.max(0, priorDebtMinutes) / 2);
  const strainBump = Math.min(60, Math.max(0, strainYesterday) * 3);
  return Math.round(BASE_SLEEP_MINUTES + debtBump + strainBump);
}
