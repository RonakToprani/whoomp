export function strainScore(
  hrBpm: ReadonlyArray<number | null | undefined>,
  age = 30,
  restingHr: number | null = null,
): number {
  if (!hrBpm || hrBpm.length === 0) return 0.0;
  const samples: number[] = [];
  for (const h of hrBpm) {
    if (h !== null && h !== undefined && h >= 30 && h <= 230) {
      samples.push(h);
    }
  }
  if (samples.length === 0) return 0.0;
  const maxHr = 220 - age;
  const rest = restingHr ? restingHr : Math.min(...samples);
  if (maxHr <= rest) return 0.0;
  const minutes = samples.length / 60.0;
  let sumSq = 0.0;
  for (const h of samples) {
    const intensity = Math.max(0.0, (h - rest) / (maxHr - rest));
    sumSq += intensity * intensity;
  }
  const load = sumSq * ((minutes / Math.max(samples.length, 1)) * 60);
  return Math.round(21.0 * (1.0 - Math.exp(-load / 100.0)) * 100) / 100;
}

export interface AcwrResult {
  ratio: number;
  acute: number;
  chronic: number;
}

export function acwr(
  strainSeries: ReadonlyArray<number | null | undefined>,
  { acuteDays = 7, chronicDays = 21, minSamples = 5 }: { acuteDays?: number; chronicDays?: number; minSamples?: number } = {},
): AcwrResult | null {
  if (!Array.isArray(strainSeries)) return null;
  const acute = (strainSeries.slice(0, acuteDays) as (number | null | undefined)[]).filter((v): v is number => v != null);
  const chronic = (strainSeries.slice(acuteDays, acuteDays + chronicDays) as (number | null | undefined)[]).filter((v): v is number => v != null);
  if (acute.length < minSamples || chronic.length < minSamples) return null;
  const acuteMean = acute.reduce((a, b) => a + b, 0) / acute.length;
  const chronicMean = chronic.reduce((a, b) => a + b, 0) / chronic.length;
  if (!chronicMean) return null;
  return { ratio: acuteMean / chronicMean, acute: acuteMean, chronic: chronicMean };
}
