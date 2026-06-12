/// <reference types="node" />
// Offline replay harness — diagnose sleep staging against a real exported night.
//
// Not part of the normal suite: skips unless NIGHT_CSV points at a whoomp "Export all samples (CSV)"
// file (the extended one with gx/gy/gz/resp_raw). Optionally NIGHT_START/NIGHT_END (unix seconds)
// window a single night; otherwise every detected session is printed.
//
//   NIGHT_CSV=/path/whoomp-samples.csv npx vitest run replayNight
//
// Prints: data coverage, gravity-stillness noise floor, HR/RR density, and the staged split per
// session vs the Fitbit ground truth (deep 79 / rem 131 / light 237 / wake 3 min for the 2026-06-12
// night), so the deep/REM collapse can be tuned with data instead of guessed.

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import {
  detectSleep,
  type HRSample, type RRInterval, type RespSample, type GravitySample,
} from '../sleep';

// L2 magnitude of each consecutive gravity change (mirrors sleep.ts gravityDeltas, leading 0 dropped).
function gravDeltas(g: GravitySample[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < g.length; i++) {
    const dx = g[i - 1].x - g[i].x, dy = g[i - 1].y - g[i].y, dz = g[i - 1].z - g[i].z;
    out.push(Math.sqrt(dx * dx + dy * dy + dz * dz));
  }
  return out;
}
const stillFraction = (g: GravitySample[]): number => {
  const d = gravDeltas(g);
  return d.length ? d.filter(x => x < 0.01).length / d.length : 0;
};

const CSV = process.env.NIGHT_CSV;
const RUN = CSV ? describe : describe.skip;

interface Row {
  unix: number; hr: number | null; rr: number[]; source: string;
  g: { x: number; y: number; z: number } | null; resp: number | null;
}

function parse(text: string): Row[] {
  const lines = text.split('\n').filter(l => l.trim().length);
  const header = lines[0].split(',');
  const col = (name: string) => header.indexOf(name);
  const cU = col('unix'), cH = col('hr_bpm'), cR = col('rr_intervals_ms'), cS = col('source');
  const cgx = col('gx'), cgy = col('gy'), cgz = col('gz'), cResp = col('resp_raw');
  const out: Row[] = [];
  for (let i = 1; i < lines.length; i++) {
    const f = lines[i].split(',');
    const unix = Number(f[cU]);
    if (!Number.isFinite(unix)) continue;
    const hr = f[cH] !== '' ? Number(f[cH]) : null;
    const rr = f[cR] ? f[cR].split('|').map(Number).filter(Number.isFinite) : [];
    const gx = cgx >= 0 && f[cgx] !== '' ? Number(f[cgx]) : NaN;
    const gy = cgy >= 0 && f[cgy] !== '' ? Number(f[cgy]) : NaN;
    const gz = cgz >= 0 && f[cgz] !== '' ? Number(f[cgz]) : NaN;
    const g = Number.isFinite(gx) && Number.isFinite(gy) && Number.isFinite(gz) ? { x: gx, y: gy, z: gz } : null;
    const resp = cResp >= 0 && f[cResp] !== '' ? Number(f[cResp]) : null;
    out.push({ unix, hr, rr, source: cS >= 0 ? f[cS] : '', g, resp });
  }
  return out;
}

function stats(xs: number[]): Record<string, number> {
  if (!xs.length) return { n: 0 };
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))];
  return { n: s.length, min: s[0], p05: q(0.05), p25: q(0.25), median: q(0.5), p75: q(0.75), p95: q(0.95), max: s[s.length - 1] };
}

const minutes = (s: number) => Math.round(s / 60);

RUN('replay night', () => {
  it('diagnose staging vs ground truth', () => {
    const all = parse(fs.readFileSync(CSV!, 'utf8'));
    const lo = process.env.NIGHT_START ? Number(process.env.NIGHT_START) : -Infinity;
    const hi = process.env.NIGHT_END ? Number(process.env.NIGHT_END) : Infinity;
    const rows = all.filter(r => r.unix >= lo && r.unix <= hi);

    const hr: HRSample[] = [], rr: RRInterval[] = [], resp: RespSample[] = [], gravity: GravitySample[] = [];
    for (const r of rows) {
      if (r.hr != null && r.hr >= 20 && r.hr <= 250) hr.push({ ts: r.unix, bpm: r.hr });
      for (const v of r.rr) rr.push({ ts: r.unix, rrMs: v });
      if (r.resp != null) resp.push({ ts: r.unix, raw: r.resp });
      if (r.g) gravity.push({ ts: r.unix, x: r.g.x, y: r.g.y, z: r.g.z });
    }

    const span = rows.length ? (rows[rows.length - 1].unix - rows[0].unix) : 0;
    console.log('\n===== COVERAGE =====');
    console.log(`rows ${rows.length} (of ${all.length})  span ${(span / 3600).toFixed(2)} h`);
    console.log(`first ${new Date(rows[0]?.unix * 1000).toISOString()}  last ${new Date(rows[rows.length - 1]?.unix * 1000).toISOString()}`);
    console.log(`hr ${hr.length}  rr-intervals ${rr.length} (${(rr.length / Math.max(1, span / 60)).toFixed(1)}/min)  resp ${resp.length}  gravity ${gravity.length}`);

    // Gravity stillness noise floor: the staging "still" gate is |Δgravity| < 0.01 g.
    const gSorted = gravity.slice().sort((a, b) => a.ts - b.ts);
    const deltas = gravDeltas(gSorted);
    const dStats = stats(deltas);
    const stillFrac = deltas.length ? deltas.filter(d => d < 0.01).length / deltas.length : 0;
    console.log('\n===== GRAVITY Δ (still gate = 0.01 g) =====');
    console.log(dStats);
    console.log(`fraction below 0.01 g (still): ${(stillFrac * 100).toFixed(1)}%`);

    console.log('\n===== HR (bpm) =====');
    console.log(stats(hr.map(h => h.bpm)));

    // Detect + per-session staging split.
    const sessions = detectSleep({ hr, rr, resp, gravity });
    console.log(`\n===== ${sessions.length} SESSION(S) =====`);
    const FITBIT = { deep: 79, rem: 131, light: 237, wake: 3, total: 448 };
    let aggDeep = 0, aggRem = 0, aggLight = 0, aggWake = 0;
    for (const s of sessions) {
      const t = { wake: 0, light: 0, deep: 0, rem: 0 } as Record<string, number>;
      for (const seg of s.stages) t[seg.stage] += seg.end - seg.start;
      aggDeep += t.deep; aggRem += t.rem; aggLight += t.light; aggWake += t.wake;
      const sf = stillFraction(gSorted.filter(g => g.ts >= s.start && g.ts <= s.end));
      console.log(
        `${new Date(s.start * 1000).toISOString()} → ${new Date(s.end * 1000).toISOString()} ` +
        `dur ${minutes(s.end - s.start)}m eff ${(s.efficiency * 100).toFixed(0)}% rHR ${s.restingHR} ` +
        `| deep ${minutes(t.deep)} rem ${minutes(t.rem)} light ${minutes(t.light)} wake ${minutes(t.wake)} ` +
        `| still ${(sf * 100).toFixed(0)}%`,
      );
    }
    console.log('\n===== AGGREGATE vs FITBIT =====');
    console.log(`whoomp  deep ${minutes(aggDeep)}  rem ${minutes(aggRem)}  light ${minutes(aggLight)}  wake ${minutes(aggWake)}  asleep ${minutes(aggDeep + aggRem + aggLight)}`);
    console.log(`fitbit  deep ${FITBIT.deep}  rem ${FITBIT.rem}  light ${FITBIT.light}  wake ${FITBIT.wake}  asleep ${FITBIT.total}`);

    expect(true).toBe(true);
  });
});
