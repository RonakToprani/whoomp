import { describe, it, expect } from 'vitest';
import {
  detectSleep, detectSleepHrOnly, analyzeNight, stageTotals,
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
