export const RECOVERY_BASELINE_DAYS = 14;

export const RECOVERY_WEIGHTS = Object.freeze({
  hrv: 0.4,
  rhr: 0.2,
  sleep: 0.3,
  strain: 0.1,
});

const MIN_BASELINE_SAMPLES = 3;
const STRAIN_MAX = 21.0;

function isNum(v: unknown): v is number {
  return v !== null && v !== undefined && typeof v === 'number' && !Number.isNaN(v as number);
}

function mean(values: number[]): number {
  let s = 0;
  for (let i = 0; i < values.length; i++) s += values[i];
  return s / values.length;
}

function pstdev(values: number[]): number {
  if (values.length === 0) return 0;
  const m = mean(values);
  let sq = 0;
  for (let i = 0; i < values.length; i++) {
    const dev = values[i] - m;
    sq += dev * dev;
  }
  return Math.sqrt(sq / values.length);
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

function zToScore(
  value: number | null | undefined,
  history: ReadonlyArray<number | null | undefined>,
  inverted = false,
): number | null {
  const cleaned: number[] = [];
  for (const v of history ?? []) {
    if (isNum(v) && (v as number) > 0) cleaned.push(v as number);
  }
  if (!isNum(value) || cleaned.length < MIN_BASELINE_SAMPLES) return null;
  const mu = mean(cleaned);
  const sigma = pstdev(cleaned) || 1.0;
  let z = ((value as number) - mu) / sigma;
  if (inverted) z = -z;
  if (z > 3.0) z = 3.0;
  if (z < -3.0) z = -3.0;
  return round1(50.0 + (z / 3.0) * 50.0);
}

export function recoveryScore(
  todayRmssd: number | null | undefined,
  historyRmssd: ReadonlyArray<number | null | undefined>,
): number | null {
  return zToScore(todayRmssd, historyRmssd, false);
}

export interface RecoveryBreakdownResult {
  hrv: number | null;
  rhr: number | null;
  sleep: number | null;
  strain: number | null;
  total: number | null;
}

export function recoveryBreakdown({
  todayRmssd,
  rmssdHistory,
  todayRhr,
  rhrHistory,
  sleepPerformancePct,
  yesterdayStrain,
}: {
  todayRmssd?: number | null;
  rmssdHistory?: ReadonlyArray<number | null | undefined>;
  todayRhr?: number | null;
  rhrHistory?: ReadonlyArray<number | null | undefined>;
  sleepPerformancePct?: number | null;
  yesterdayStrain?: number | null;
}): RecoveryBreakdownResult {
  const hrv = zToScore(todayRmssd, rmssdHistory ?? [], false);
  const rhr = zToScore(todayRhr, rhrHistory ?? [], true);
  const sleep = isNum(sleepPerformancePct) ? round1(sleepPerformancePct as number) : null;
  let strain: number | null = null;
  if (isNum(yesterdayStrain)) {
    const raw = 100.0 - ((yesterdayStrain as number) * 100.0) / STRAIN_MAX;
    const clamped = Math.max(0.0, Math.min(100.0, raw));
    strain = round1(clamped);
  }

  const components = { hrv, rhr, sleep, strain };
  const used = Object.entries(components).filter(([, v]) => v !== null) as [string, number][];
  if (used.length === 0) {
    return { ...components, total: null };
  }
  let weightSum = 0;
  let weighted = 0;
  for (const [k, v] of used) {
    const w = RECOVERY_WEIGHTS[k as keyof typeof RECOVERY_WEIGHTS];
    weightSum += w;
    weighted += v * w;
  }
  return { ...components, total: round1(weighted / weightSum) };
}
