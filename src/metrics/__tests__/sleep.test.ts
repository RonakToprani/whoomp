import { describe, it, expect } from 'vitest';
import {
  detectSleep, detectSleepHrOnly, analyzeNight, analyzeNightSummary, summarizeNight,
  respRateFromRR, stageTotals,
  type HRSample, type RRInterval, type RespSample, type GravitySample,
} from '../sleep';

// Synthetic overnight: 30 min active → 4 h still sleep (low HR) → 30 min active, at 1 Hz.
function buildNight() {
  const hr: HRSample[] = [], rr: RRInterval[] = [], resp: RespSample[] = [], gravity: GravitySample[] = [];
  const SLEEP_START = 1800, SLEEP_END = 1800 + 4 * 3600, TOTAL = SLEEP_END + 1800;
  for (let t = 0; t < TOTAL; t++) {
    const asleep = t >= SLEEP_START && t < SLEEP_END;
    const bpm = asleep ? Math.round(50 + 4 * Math.sin(t / 300)) : 80 + Math.round(5 * Math.sin(t / 50));
    hr.push({ ts: t, bpm });
    rr.push({ ts: t, rrMs: Math.round(60000 / bpm) + Math.round(20 * Math.sin(t / 4)) });
    resp.push({ ts: t, raw: Math.round(1000 + 50 * Math.sin(t * (2 * Math.PI / 4))) }); // ~0.25 Hz ≈ 15 brpm
    if (asleep) gravity.push({ ts: t, x: 0, y: 0, z: 1 + 0.001 * Math.sin(t / 600) }); // still
    else gravity.push({ ts: t, x: 0.3 * Math.sin(t / 3), y: 0.2 * Math.cos(t / 3), z: 0.9 }); // moving
  }
  return { hr, rr, resp, gravity, SLEEP_START, SLEEP_END };
}

describe('sleep stager (structural sanity)', () => {
  const night = buildNight();

  it('detects a multi-hour sleep session from gravity stillness', () => {
    const sessions = detectSleep({ hr: night.hr, rr: night.rr, resp: night.resp, gravity: night.gravity });
    expect(sessions.length).toBeGreaterThanOrEqual(1);
    const s = sessions.reduce((a, b) => (b.end - b.start > a.end - a.start ? b : a));
    expect(s.end - s.start).toBeGreaterThanOrEqual(3 * 3600); // ≥ 3 h of the 4 h block
    expect(s.efficiency).toBeGreaterThan(0);
    expect(s.efficiency).toBeLessThanOrEqual(1);
    expect(s.restingHR).not.toBeNull();
    expect(s.restingHR!).toBeLessThan(60); // sleep HR floor
    if (s.respRate != null) { expect(s.respRate).toBeGreaterThan(4); expect(s.respRate).toBeLessThan(40); }
  });

  it('stage segments tile the session contiguously', () => {
    const s = detectSleep({ hr: night.hr, rr: night.rr, resp: night.resp, gravity: night.gravity })
      .reduce((a, b) => (b.end - b.start > a.end - a.start ? b : a));
    expect(s.stages[0].start).toBe(s.start);
    expect(s.stages[s.stages.length - 1].end).toBe(s.end);
    for (let i = 1; i < s.stages.length; i++) expect(s.stages[i].start).toBe(s.stages[i - 1].end);
    const totals = stageTotals(s.stages);
    const sum = totals.wake + totals.light + totals.deep + totals.rem;
    expect(sum).toBeCloseTo(Math.round((s.end - s.start) / 60), 0);
  });

  it('HR-only fallback finds a window without gravity', () => {
    const sessions = detectSleepHrOnly(night.hr, night.rr);
    expect(sessions.length).toBe(1);
    expect(sessions[0].end - sessions[0].start).toBeGreaterThanOrEqual(3 * 3600);
  });

  it('analyzeNight uses gravity path when accelerometer is present', () => {
    const s = analyzeNight({ hr: night.hr, rr: night.rr, resp: night.resp, gravity: night.gravity });
    expect(s).not.toBeNull();
    expect(s!.respRate == null || (s!.respRate > 4 && s!.respRate < 40)).toBe(true);
  });

  it('empty gravity → no gravity sessions', () => {
    expect(detectSleep({ gravity: [] })).toEqual([]);
  });
});

// A two-block night: 2.5 h still sleep → 30 min up-and-about → 3 h still sleep. The 30-min active
// gap fragments the gravity spine into TWO sleep sessions (a bathroom trip / restless stretch does
// this in reality). The old "longest single session" consumer reported only ~3 h; the aggregate
// must report ≈ the whole 5.5 h asleep.
function buildFragmentedNight() {
  const hr: HRSample[] = [], rr: RRInterval[] = [], resp: RespSample[] = [], gravity: GravitySample[] = [];
  const segs: Array<[number, number, boolean]> = [
    [0, 1800, false],          // 30 min active
    [1800, 1800 + 9000, true], // 2.5 h sleep
    [10800, 12600, false],     // 30 min active (the gap)
    [12600, 23400, true],      // 3 h sleep
    [23400, 25200, false],     // 30 min active
  ];
  for (const [s, e, asleep] of segs) {
    for (let t = s; t < e; t++) {
      const bpm = asleep ? Math.round(50 + 4 * Math.sin(t / 300)) : 80 + Math.round(5 * Math.sin(t / 50));
      hr.push({ ts: t, bpm });
      rr.push({ ts: t, rrMs: Math.round(60000 / bpm) + Math.round(20 * Math.sin(t / 4)) });
      resp.push({ ts: t, raw: Math.round(1000 + 50 * Math.sin(t * (2 * Math.PI / 4))) });
      if (asleep) gravity.push({ ts: t, x: 0, y: 0, z: 1 + 0.001 * Math.sin(t / 600) });
      else gravity.push({ ts: t, x: 0.3 * Math.sin(t / 3), y: 0.2 * Math.cos(t / 3), z: 0.9 });
    }
  }
  return { hr, rr, resp, gravity };
}

describe('whole-night aggregation', () => {
  const night = buildFragmentedNight();

  it('sums sleep across fragmented sessions instead of keeping only the longest', () => {
    const sessions = detectSleep(night);
    expect(sessions.length).toBeGreaterThanOrEqual(2); // the 30-min active gap splits the night

    const longest = sessions.reduce((a, b) => (b.end - b.start > a.end - a.start ? b : a));
    const longestAsleep = (() => { const t = stageTotals(longest.stages); return t.deep + t.rem + t.light; })();

    const summary = analyzeNightSummary(night)!;
    expect(summary).not.toBeNull();
    // Aggregate asleep must exceed the single longest block — that is the whole point of the fix.
    expect(summary.asleepMin).toBeGreaterThan(longestAsleep + 60); // ≥ ~1 h more than one block
    expect(summary.asleepMin).toBeGreaterThanOrEqual(4 * 60);      // ≈ the full ~5.5 h asleep
    // Combined hypnogram spans the first block's onset to the last block's end.
    expect(summary.start).toBe(sessions[0].start);
    expect(summary.end).toBe(sessions[sessions.length - 1].end);
    expect(summary.efficiency).toBeGreaterThan(0);
    expect(summary.efficiency).toBeLessThanOrEqual(1);
  });

  it('summarizeNight([]) is null', () => {
    expect(summarizeNight([])).toBeNull();
  });
});

describe('respiration from RSA (R-R)', () => {
  // RR tachogram modulated by breathing: RR = base + amp·sin(2π·f·t). f = 0.25 Hz ⇒ 15 breaths/min.
  function rsaRR(beats: number, fResp: number, baseRR = 1000, amp = 40): RRInterval[] {
    const out: RRInterval[] = [];
    let tMs = 0;
    for (let i = 0; i < beats; i++) {
      const rrMs = Math.round(baseRR + amp * Math.sin(2 * Math.PI * fResp * (tMs / 1000)));
      out.push({ ts: Math.round(tMs / 1000), rrMs });
      tMs += rrMs;
    }
    return out;
  }

  it('recovers ~15 br/min from a 0.25 Hz RSA modulation', () => {
    const rr = rsaRR(600, 0.25);
    const end = rr[rr.length - 1].ts + 1;
    const r = respRateFromRR(rr, 0, end);
    expect(r).not.toBeNull();
    expect(r!).toBeGreaterThan(12);
    expect(r!).toBeLessThan(18);
  });

  it('returns null for a flat (no-RSA) R-R series', () => {
    const rr = Array.from({ length: 600 }, (_, i) => ({ ts: i, rrMs: 1000 }));
    expect(respRateFromRR(rr, 0, 600)).toBeNull();
  });

  it('returns null with too few beats', () => {
    expect(respRateFromRR(rsaRR(20, 0.25), 0, 25)).toBeNull();
  });

  it('rejects an out-of-band rate (0.5 Hz ⇒ 30 br/min)', () => {
    const rr = rsaRR(600, 0.5);
    expect(respRateFromRR(rr, 0, rr[rr.length - 1].ts + 1)).toBeNull();
  });
});
