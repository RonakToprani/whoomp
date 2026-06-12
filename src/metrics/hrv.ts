// HRV — RMSSD / SDNN / pNN50 from RR intervals.
//
// Task Force (1996) definitions with a range + Malik-style ectopic cleaning pipeline:
//   1. Range filter: drop intervals outside [RR_MIN_MS, RR_MAX_MS].
//   2. Ectopic rejection (Malik 1989): drop beats deviating > 20% from a local median.
//   3. Require >= MIN_BEATS clean intervals before a trustworthy result.
//
//   RMSSD = sqrt( mean( (NN[i+1] − NN[i])^2 ) )   (successive diffs, ddof on n−1)
//   SDNN  = sample standard deviation of NN (ddof = 1)
//
// Reimplemented in TypeScript from the published methods; structurally cross-checked
// against NOOP's HRVAnalyzer (see CREDITS.md). The old 5-beat successive-difference
// filter was the main source of jumpy live HRV — this is stricter and more standard.

export const RR_MIN_MS = 300; // ≈ 200 bpm
export const RR_MAX_MS = 2000; // ≈ 30 bpm
export const MIN_BEATS = 20; // min clean intervals for a trustworthy RMSSD/SDNN
export const ECTOPIC_THRESHOLD = 0.2; // Malik: reject > 20% from local median
export const ECTOPIC_WINDOW_RADIUS = 2; // 2*r+1 = 5-beat centered window

export interface HrvResult {
  rmssd: number | null;
  sdnn: number | null;
  pnn50: number | null;
  meanNN: number | null;
  nInput: number;
  nClean: number;
}

export function median(values: number[]): number {
  const n = values.length;
  if (n === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = n >> 1;
  return n % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Keep only intervals in [RR_MIN_MS, RR_MAX_MS], preserving order. */
export function rangeFilter(rr: Iterable<number>): number[] {
  const out: number[] = [];
  for (const v of rr) if (v >= RR_MIN_MS && v <= RR_MAX_MS) out.push(v);
  return out;
}

/**
 * Malik-style ectopic rejection: drop any beat deviating from the median of a centered
 * window of 2*ECTOPIC_WINDOW_RADIUS+1 beats (excluding itself) by more than
 * ECTOPIC_THRESHOLD. Beats with too small a neighbourhood are kept.
 */
export function rejectEctopic(nn: number[]): number[] {
  const n = nn.length;
  if (n <= ECTOPIC_WINDOW_RADIUS) return nn.slice();
  const kept: number[] = [];
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - ECTOPIC_WINDOW_RADIUS);
    const hi = Math.min(n - 1, i + ECTOPIC_WINDOW_RADIUS);
    const neighbours: number[] = [];
    for (let j = lo; j <= hi; j++) if (j !== i) neighbours.push(nn[j]);
    if (neighbours.length < 2) { kept.push(nn[i]); continue; }
    const med = median(neighbours);
    if (med <= 0) { kept.push(nn[i]); continue; }
    if (Math.abs(nn[i] - med) / med <= ECTOPIC_THRESHOLD) kept.push(nn[i]);
    // else: drop as ectopic.
  }
  return kept;
}

/** Full clean: range filter → ectopic rejection. */
export function cleanRR(rr: Iterable<number>): number[] {
  return rejectEctopic(rangeFilter(rr));
}

/** Task Force RMSSD over already-clean NN intervals (ms). Null when < 2 values. */
export function rmssdRaw(nn: number[]): number | null {
  if (nn.length < 2) return null;
  let sumSq = 0;
  for (let i = 1; i < nn.length; i++) { const d = nn[i] - nn[i - 1]; sumSq += d * d; }
  return Math.sqrt(sumSq / (nn.length - 1));
}

/** Sample SD (ddof = 1) of NN intervals (ms). Null when < 2 values. */
export function sdnnRaw(nn: number[]): number | null {
  if (nn.length < 2) return null;
  const mean = nn.reduce((a, b) => a + b, 0) / nn.length;
  let ss = 0;
  for (const v of nn) { const d = v - mean; ss += d * d; }
  return Math.sqrt(ss / (nn.length - 1));
}

/** Clean RR then compute the full HRV result. Nulls when < MIN_BEATS clean beats survive. */
export function analyzeHrv(rr: Iterable<number>): HrvResult {
  const raw = Array.from(rr ?? []);
  const clean = cleanRR(raw);
  if (clean.length < MIN_BEATS) {
    // Empty/insufficient result: preserve the input count but report nClean = 0 (matches NOOP's
    // HRVResult.empty contract — "not a trustworthy result").
    return { rmssd: null, sdnn: null, pnn50: null, meanNN: null, nInput: raw.length, nClean: 0 };
  }
  let nn50 = 0;
  for (let i = 1; i < clean.length; i++) if (Math.abs(clean[i] - clean[i - 1]) > 50) nn50++;
  return {
    rmssd: rmssdRaw(clean),
    sdnn: sdnnRaw(clean),
    pnn50: (nn50 / (clean.length - 1)) * 100,
    meanNN: clean.reduce((a, b) => a + b, 0) / clean.length,
    nInput: raw.length,
    nClean: clean.length,
  };
}

// ── Back-compat thin wrappers (live screen + older call sites) ──
export function filterRr(rrMs: Iterable<number>): number[] { return cleanRR(rrMs); }
export function rmssd(rrMs: Iterable<number>): number | null { return analyzeHrv(rrMs).rmssd; }
export function sdnn(rrMs: Iterable<number>): number | null { return analyzeHrv(rrMs).sdnn; }
export function pnn50(rrMs: Iterable<number>): number | null { return analyzeHrv(rrMs).pnn50; }
