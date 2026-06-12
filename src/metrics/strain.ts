// Strain — cardiovascular load on a 0–21 logarithmic scale.
//
// Pipeline:
//   1. Karvonen %HRR = (HR − RHR) / (HRmax − RHR) × 100, clamped 0..100.
//   2. TRIMP accumulated over the day:
//        • Edwards 5-zone (default): each sample adds its zone weight (1..5 at
//          50/60/70/80/90 %HRR) × its duration in minutes.
//        • Banister exponential: each sample adds duration × x × 0.64 × e^(b·x).
//   3. Log-compress to [0, 21]:  21 × ln(TRIMP+1) / ln(D),  D = STRAIN_DENOMINATOR.
//
// D = 7201 maps a theoretical 24 h at the top zone weight (1440 min × weight 5 = 7200 TRIMP,
// +1) onto exactly 21.0. Independent implementation of published methods (Karvonen 1957; Edwards 1993;
// Banister 1991; Tanaka 2001) — WHOOP-*like*, not the proprietary algorithm. Cross-checked
// against NOOP's StrainScorer. Because %HRR is used (not %HRmax), resting/light activity
// below 50 %HRR contributes nothing, so a non-workout day scores low — as intended.

export const MAX_STRAIN = 21.0;
/** Log-map denominator. Calibratable via fitStrainDenominator() against real WHOOP strain. */
export const STRAIN_DENOMINATOR = 7201.0;
export const MIN_READINGS = 600; // ≈10 min at 1 Hz before a score is trusted
export const DEFAULT_AGE = 30;
export const DEFAULT_RESTING_HR = 60;
export const HRMAX_MIN_SAMPLES = 600;
export const HRMAX_PERCENTILE = 99.5;
export const BANISTER_SCALE = 0.64;
export const BANISTER_B_MEN = 1.92;
export const BANISTER_B_WOMEN = 1.67;
/** Default per-sample duration (minutes) — 1 s at 1 Hz. */
export const SAMPLE_MINUTES_1HZ = 1 / 60;

export type StrainMethod = 'edwards' | 'banister';
export type Sex = 'M' | 'F' | null;

// Edwards zone cut-offs as [%HRR threshold, weight], highest-first.
const EDWARDS_ZONES: [number, number][] = [
  [90, 5], [80, 4], [70, 3], [60, 2], [50, 1],
];

/** Tanaka (2001): HRmax = 208 − 0.7 × age (gender-independent). */
export function tanakaHRmax(age: number): number { return 208 - 0.7 * age; }

/** Classic 220 − age. Last-resort fallback only. */
export function defaultMaxHR(age = DEFAULT_AGE): number { return 220 - age; }

/** numpy-style linearly-interpolated percentile of an already-sorted array. */
function percentile(sorted: number[], pct: number): number {
  const n = sorted.length;
  if (n === 0) return 0;
  if (n === 1) return sorted[0];
  const pos = (pct / 100) * (n - 1);
  const lo = Math.floor(pos);
  const hi = Math.min(lo + 1, n - 1);
  const frac = pos - lo;
  return sorted[lo] + frac * (sorted[hi] - sorted[lo]);
}

export interface HRmaxEstimate { hrmax: number; source: 'observed' | 'tanaka' | 'unknown'; }

/**
 * Personalized HRmax from a trailing HR series: the observed 99.5th-percentile once there
 * are enough samples (and it exceeds Tanaka), else Tanaka, else unknown. Matches the user's
 * "learn from my data" choice with a 191 bpm (Tanaka, age 24) floor until history accrues.
 */
export function estimateHRmax(hrHistory: number[], age: number | null): HRmaxEstimate {
  const n = hrHistory.length;
  const tanaka = age != null ? tanakaHRmax(age) : null;
  if (n >= HRMAX_MIN_SAMPLES) {
    const observed = percentile([...hrHistory].sort((a, b) => a - b), HRMAX_PERCENTILE);
    if (tanaka == null) return { hrmax: observed, source: 'observed' };
    return observed >= tanaka ? { hrmax: observed, source: 'observed' } : { hrmax: tanaka, source: 'tanaka' };
  }
  if (tanaka != null) return { hrmax: tanaka, source: 'tanaka' };
  return { hrmax: 0, source: 'unknown' };
}

/** Karvonen %HRR, clamped [0, 100]. */
function pctHRR(bpm: number, restingHR: number, hrReserve: number): number {
  const pct = ((bpm - restingHR) / hrReserve) * 100;
  return pct < 0 ? 0 : pct > 100 ? 100 : pct;
}

/** Edwards 5-zone weight (0–5) from %HRR. */
function zoneWeight(bpm: number, restingHR: number, hrReserve: number): number {
  const pct = ((bpm - restingHR) / hrReserve) * 100;
  for (const [threshold, weight] of EDWARDS_ZONES) if (pct >= threshold) return weight;
  return 0;
}

/** Map accumulated TRIMP onto [0, 21] (2 dp). TRIMP ≤ 0 → 0. */
export function trimpToStrain(trimp: number, denominator = STRAIN_DENOMINATOR): number {
  if (trimp <= 0) return 0;
  const value = (MAX_STRAIN * Math.log(trimp + 1)) / Math.log(denominator);
  return Math.round(value * 100) / 100;
}

export interface StrainOpts {
  maxHR?: number | null;
  restingHR?: number | null;
  method?: StrainMethod;
  sex?: Sex;
  denominator?: number;
  /** Minutes represented by each HR sample (1 Hz → 1/60). */
  sampleMinutes?: number;
}

/**
 * Cardiovascular strain (0–21) from a 1 Hz HR series. Returns null when there are fewer than
 * MIN_READINGS samples or HRmax ≤ RHR (invalid reserve).
 */
export function strainScore(hrBpm: ReadonlyArray<number | null | undefined>, opts: StrainOpts = {}): number | null {
  const method = opts.method ?? 'edwards';
  const sex = opts.sex ?? 'M';
  const denominator = opts.denominator ?? STRAIN_DENOMINATOR;
  const sampleMinutes = opts.sampleMinutes ?? SAMPLE_MINUTES_1HZ;
  const restingHR = opts.restingHR && opts.restingHR > 20 ? opts.restingHR : DEFAULT_RESTING_HR;
  const maxHR = opts.maxHR ?? defaultMaxHR();

  const samples: number[] = [];
  for (const h of hrBpm) if (h != null && h >= 30 && h <= 230) samples.push(h);
  if (samples.length < MIN_READINGS || maxHR <= restingHR) return null;

  const hrReserve = maxHR - restingHR;
  let trimp = 0;
  if (method === 'banister') {
    const b = sex === 'F' ? BANISTER_B_WOMEN : BANISTER_B_MEN;
    for (const s of samples) {
      const x = pctHRR(s, restingHR, hrReserve) / 100;
      if (x > 0) trimp += sampleMinutes * x * BANISTER_SCALE * Math.exp(b * x);
    }
  } else {
    let weighted = 0;
    for (const s of samples) weighted += zoneWeight(s, restingHR, hrReserve);
    trimp = weighted * sampleMinutes;
  }
  return trimpToStrain(trimp, denominator);
}

/**
 * Calibrate D from (TRIMP, referenceStrain) pairs via the through-origin least-squares line:
 * ln(D) = 21 × Σ(x²) / Σ(xy), x = ln(TRIMP+1). Returns null with < 2 usable pairs. Lets the
 * user later tune strain to their real WHOOP numbers if they ever obtain them.
 */
export function fitStrainDenominator(pairs: { trimp: number; strain: number }[]): number | null {
  const usable = pairs.filter(p => p.trimp > 0 && p.strain > 0);
  if (usable.length < 2) return null;
  let sumXX = 0, sumXY = 0;
  for (const { trimp, strain } of usable) {
    const x = Math.log(trimp + 1);
    sumXX += x * x;
    sumXY += x * strain;
  }
  if (sumXY <= 0 || sumXX <= 0) return null;
  return Math.exp((MAX_STRAIN * sumXX) / sumXY);
}

export interface AcwrResult { ratio: number; acute: number; chronic: number; }

/** Acute:chronic workload ratio (injury-risk proxy). strainSeries newest-first. */
export function acwr(
  strainSeries: ReadonlyArray<number | null | undefined>,
  { acuteDays = 7, chronicDays = 28, minSamples = 5 }: { acuteDays?: number; chronicDays?: number; minSamples?: number } = {},
): AcwrResult | null {
  if (!Array.isArray(strainSeries)) return null;
  const acute = (strainSeries.slice(0, acuteDays) as (number | null | undefined)[]).filter((v): v is number => v != null);
  const chronic = (strainSeries.slice(0, chronicDays) as (number | null | undefined)[]).filter((v): v is number => v != null);
  if (acute.length < minSamples || chronic.length < minSamples) return null;
  const acuteMean = acute.reduce((a, b) => a + b, 0) / acute.length;
  const chronicMean = chronic.reduce((a, b) => a + b, 0) / chronic.length;
  if (!chronicMean) return null;
  return { ratio: acuteMean / chronicMean, acute: acuteMean, chronic: chronicMean };
}
