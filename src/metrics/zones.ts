export const ZONE_BOUNDS: [string, number, number][] = [
  ['z1', 0.50, 0.60],
  ['z2', 0.60, 0.70],
  ['z3', 0.70, 0.80],
  ['z4', 0.80, 0.90],
  ['z5', 0.90, 1.20],
];

export function maxHr(age: number, override: number | null = null): number {
  if (override) return Math.trunc(override);
  return Math.max(120, 220 - Math.max(1, Math.trunc(age)));
}

export function zoneForHr(hr: number | null | undefined, maxBpm: number): number | null {
  if (hr === null || hr === undefined || maxBpm <= 0) return null;
  const frac = hr / maxBpm;
  for (let idx = 0; idx < ZONE_BOUNDS.length; idx++) {
    const [, lo, hi] = ZONE_BOUNDS[idx];
    if (frac >= lo && frac < hi) return idx + 1;
  }
  return null;
}

export function zoneSecondsFromHrSeries(hrPerSecond: (number | null | undefined)[], maxBpm: number): number[] {
  const counts = [0, 0, 0, 0, 0];
  for (const hr of hrPerSecond) {
    const z = zoneForHr(hr ?? 0, maxBpm);
    if (z !== null) counts[z - 1] += 1;
  }
  return counts;
}

export function caloriesPerMinute(hr: number | null | undefined, age: number, weightKg: number | null, sex: 'M' | 'F' | null): number {
  if (hr === null || hr === undefined || hr < 30 || hr > 230) return 0.0;
  const w = weightKg && weightKg > 0 ? weightKg : 70.0;
  const a = age && age > 0 ? age : 30;
  const male = (-55.0969 + 0.6309 * hr + 0.1988 * w + 0.2017 * a) / 4.184;
  const female = (-20.4022 + 0.4472 * hr - 0.1263 * w + 0.0740 * a) / 4.184;
  let kpm: number;
  if (sex === 'M') kpm = male;
  else if (sex === 'F') kpm = female;
  else kpm = (male + female) / 2;
  return Math.max(0.0, kpm);
}

export function caloriesFromHrSeries(hrPerSecond: (number | null | undefined)[], age: number, weightKg: number | null, sex: 'M' | 'F' | null): number {
  if (!hrPerSecond || hrPerSecond.length === 0) return 0.0;
  const w = weightKg && weightKg > 0 ? weightKg : 70.0;
  let total = 0.0;
  for (const hr of hrPerSecond) {
    if (hr === null || hr === undefined || hr < 30) {
      total += 1.0 / 60.0;
      continue;
    }
    total += caloriesPerMinute(hr, age, w, sex) / 60.0;
  }
  return Math.round(total * 10) / 10;
}
