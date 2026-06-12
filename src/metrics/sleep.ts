export const EPOCH_SECONDS = 30;
export const MIN_SLEEP_BLOCK_MINUTES = 30;
export const NIGHT_WINDOW_LOCAL = { startHour: 20, endHour: 11 };
export const STAGES = ['wake', 'light', 'deep', 'rem'] as const;
export type Stage = typeof STAGES[number];
export const BASE_SLEEP_MINUTES = 480;

export interface SampleRow {
  ts_utc: string;
  heart_rate_bpm?: number | null;
  rr_interval_ms?: number | null;
  accel_x?: number | null;
  accel_y?: number | null;
  accel_z?: number | null;
}

export interface StageSegment {
  start_utc: string;
  end_utc: string;
  stage: Stage;
  source: string;
}

function motionMagnitude(row: SampleRow): number {
  return Math.abs(row.accel_x || 0) + Math.abs(row.accel_y || 0) + Math.abs(row.accel_z || 0);
}

function parseTs(row: SampleRow): Date { return new Date(row.ts_utc); }

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  let s = 0;
  for (const v of values) s += v;
  return s / values.length;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function pstdev(values: number[]): number {
  if (values.length === 0) return 0;
  const m = mean(values);
  let sq = 0;
  for (const v of values) { const d = v - m; sq += d * d; }
  return Math.sqrt(sq / values.length);
}

// Bridge arousals / sparse overnight logging up to this many minutes so a
// real night stays one span instead of fragmenting into sub-blocks.
export const BRIDGE_MINUTES = 30;

export function detectSleepWindow(samples: SampleRow[], _nightOf: string): [Date, Date] | null {
  if (!samples || samples.length === 0) return null;

  // (time, hr) for every sample that carries a usable HR.
  const pts: { t: number; hr: number }[] = [];
  for (const r of samples) {
    if (r.heart_rate_bpm != null) {
      const t = parseTs(r).getTime();
      if (Number.isFinite(t)) pts.push({ t, hr: r.heart_rate_bpm });
    }
  }
  if (pts.length < 10) return null;
  pts.sort((a, b) => a.t - b.t);

  // Robust asleep threshold: low percentile of HR + headroom for light/REM
  // elevation. Percentile (not mean) so a few high samples can't drag it up.
  const sortedHr = pts.map(p => p.hr).sort((a, b) => a - b);
  const robustMin = sortedHr[Math.floor(sortedHr.length * 0.05)];
  const threshold = Math.min(95, robustMin + 20);

  // Timestamps that look asleep, merged into spans by TIME — a gap (arousal or
  // missing data) up to BRIDGE_MINUTES stays inside the same span.
  const bridgeMs = BRIDGE_MINUTES * 60_000;
  const asleep = pts.filter(p => p.hr <= threshold).map(p => p.t);
  if (asleep.length === 0) return null;

  const spans: [number, number][] = [];
  let spanStart = asleep[0];
  let spanEnd = asleep[0];
  for (let i = 1; i < asleep.length; i++) {
    if (asleep[i] - spanEnd <= bridgeMs) {
      spanEnd = asleep[i];
    } else {
      spans.push([spanStart, spanEnd]);
      spanStart = asleep[i];
      spanEnd = asleep[i];
    }
  }
  spans.push([spanStart, spanEnd]);

  // Longest span that clears the minimum block and is centred in the night.
  const { startHour: nightStartH, endHour: nightEndH } = NIGHT_WINDOW_LOCAL;
  let best: [number, number] | null = null;
  for (const [s, e] of spans) {
    if ((e - s) / 60_000 < MIN_SLEEP_BLOCK_MINUTES) continue;
    const midH = new Date(s + (e - s) / 2).getHours();
    const inWindow = midH >= nightStartH || midH < nightEndH;
    if (!inWindow) continue;
    if (best === null || (e - s) > (best[1] - best[0])) best = [s, e];
  }
  if (best === null) return null;
  return [new Date(best[0]), new Date(best[1])];
}

function bucketIntoEpochs(samples: SampleRow[], start: Date, end: Date): SampleRow[][] {
  const epochs: SampleRow[][] = [];
  let bucketEndMs = start.getTime() + EPOCH_SECONDS * 1000;
  let cur: SampleRow[] = [];
  const startMs = start.getTime();
  const endMs = end.getTime();
  for (const r of samples) {
    const t = parseTs(r).getTime();
    if (t < startMs || t >= endMs) continue;
    while (t >= bucketEndMs) { epochs.push(cur); cur = []; bucketEndMs += EPOCH_SECONDS * 1000; }
    cur.push(r);
  }
  if (cur.length > 0) epochs.push(cur);
  return epochs;
}

function rmssdQuick(rr: (number | null | undefined)[]): number | null {
  const filtered = rr.filter((v): v is number => v != null && v > 250 && v < 2000);
  if (filtered.length < 3) return null;
  let sumSq = 0;
  const n = filtered.length - 1;
  for (let i = 0; i < n; i++) { const d = filtered[i + 1] - filtered[i]; sumSq += d * d; }
  return Math.sqrt(sumSq / n);
}

export function classifyStages(samples: SampleRow[], window: [Date, Date]): StageSegment[] {
  const [start, end] = window;
  const epochs = bucketIntoEpochs(samples, start, end);
  if (epochs.length === 0) return [];
  const epochStats = epochs.map((ep) => {
    if (ep.length === 0) return { hr: null, motion: null, rmssd: null };
    const hrs: number[] = [], rrs: (number | null | undefined)[] = [], motions: number[] = [];
    for (const r of ep) {
      if (r.heart_rate_bpm != null) hrs.push(r.heart_rate_bpm);
      if (r.rr_interval_ms != null) rrs.push(r.rr_interval_ms);
      motions.push(motionMagnitude(r));
    }
    return { hr: hrs.length > 0 ? mean(hrs) : null, motion: motions.length > 0 ? mean(motions) : null, rmssd: rmssdQuick(rrs) };
  });
  const hrVals = epochStats.filter(e => e.hr != null).map(e => e.hr as number);
  const rmssdVals = epochStats.filter(e => e.rmssd != null).map(e => e.rmssd as number);
  if (hrVals.length === 0) return [];
  // Robust HR floor (5th percentile) so one stray low reading can't define "deep".
  const sortedHr = [...hrVals].sort((a, b) => a - b);
  const hrFloor = sortedHr[Math.floor(sortedHr.length * 0.05)];
  const hrBaseline = median(hrVals);
  const rmssdBaseline = rmssdVals.length > 0 ? median(rmssdVals) : 30.0;
  // Physiology: deep (SWS) = lowest HR + highest HRV; REM = elevated HR + lower
  // HRV; wake = clearly elevated HR; everything else is light. Movement would
  // refine this, but the WHOOP BLE stream doesn't expose parsed accelerometer
  // data — so staging here is HR + HRV only.
  const rawStages: Stage[] = epochStats.map(({ hr, rmssd }) => {
    if (hr == null) return 'wake';
    if (hr > hrBaseline + 10) return 'wake';
    if (hr <= hrFloor + 4 && (rmssd == null || rmssd >= rmssdBaseline)) return 'deep';
    if (rmssd != null && rmssd < rmssdBaseline && hr >= hrFloor + 5) return 'rem';
    return 'light';
  });
  const smoothed = rawStages.slice();
  for (let i = 1; i < smoothed.length - 1; i++) {
    if (smoothed[i] === 'wake' && smoothed[i - 1] !== 'wake' && smoothed[i + 1] !== 'wake') smoothed[i] = 'light';
  }
  const out: StageSegment[] = [];
  let curStage = smoothed[0];
  let curStartMs = start.getTime();
  const startMs = start.getTime();
  for (let i = 1; i < smoothed.length; i++) {
    if (smoothed[i] !== curStage) {
      const segEndMs = startMs + EPOCH_SECONDS * 1000 * i;
      out.push({ start_utc: new Date(curStartMs).toISOString(), end_utc: new Date(segEndMs).toISOString(), stage: curStage, source: 'heuristic-v1' });
      curStage = smoothed[i]; curStartMs = segEndMs;
    }
  }
  out.push({ start_utc: new Date(curStartMs).toISOString(), end_utc: new Date(end.getTime()).toISOString(), stage: curStage, source: 'heuristic-v1' });
  return out;
}

export function stageTotals(stages: Iterable<StageSegment>): Record<Stage, number> {
  const totals: Record<string, number> = { wake: 0, light: 0, deep: 0, rem: 0 };
  for (const seg of stages) {
    totals[seg.stage] += (new Date(seg.end_utc).getTime() - new Date(seg.start_utc).getTime()) / 60_000;
  }
  const out: Record<string, number> = {};
  for (const k of STAGES) out[k] = Math.round(totals[k]);
  return out as Record<Stage, number>;
}

export function sleepNeedMinutes(priorDebtMinutes: number, strainYesterday: number): number {
  const debtBump = Math.min(120.0, Math.max(0.0, priorDebtMinutes) / 2.0);
  const strainBump = Math.min(60.0, Math.max(0.0, strainYesterday) * 3.0);
  return Math.round(BASE_SLEEP_MINUTES + debtBump + strainBump);
}

export function sleepPerformance(asleepMinutes: number, needMinutes: number): number {
  if (needMinutes <= 0) return 0.0;
  return Math.round(Math.min(100.0, (100.0 * asleepMinutes) / needMinutes) * 10) / 10;
}

export function sleepDebtMinutes7d(asleepHistory: number[], needHistory: number[]): number {
  let debt = 0;
  const n = Math.min(7, asleepHistory.length, needHistory.length);
  for (let i = 0; i < n; i++) debt += Math.max(0, (needHistory[i] || 0) - (asleepHistory[i] || 0));
  return debt;
}

export function sleepConsistencyPct(bedtimesLocal: Date[], waketimesLocal: Date[]): number | null {
  if (bedtimesLocal.length < 3 || waketimesLocal.length < 3) return null;
  const bedMinutes = (dt: Date) => { let m = dt.getHours() * 60 + dt.getMinutes() + dt.getSeconds() / 60; if (m < 720) m += 1440; return m; };
  const wakeMinutes = (dt: Date) => dt.getHours() * 60 + dt.getMinutes() + dt.getSeconds() / 60;
  const sigma = (pstdev(bedtimesLocal.map(bedMinutes)) + pstdev(waketimesLocal.map(wakeMinutes))) / 2;
  return Math.round(Math.max(0.0, Math.min(100.0, 100.0 - sigma / 1.2)) * 10) / 10;
}

export function bedWakeTimesLocal(stages: StageSegment[]): [Date | null, Date | null] {
  if (!stages || stages.length === 0) return [null, null];
  const asleep = stages.filter(s => s.stage !== 'wake');
  if (asleep.length === 0) return [null, null];
  return [new Date(asleep[0].start_utc), new Date(asleep[asleep.length - 1].end_utc)];
}
