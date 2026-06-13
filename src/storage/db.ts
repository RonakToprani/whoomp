import * as SQLite from 'expo-sqlite';
import { strainScore, tanakaHRmax } from '../metrics/strain';
import { recoveryBreakdown } from '../metrics/recovery';
import { foldHistory, hrvCfg, restingHrCfg, respCfg } from '../metrics/baselines';
import { analyzeNightSummary, type HRSample, type RRInterval, type RespSample, type GravitySample } from '../metrics/sleep';
import { caloriesFromHrSeries } from '../metrics/zones';
import { getProfile, type UserProfile } from './settings';

let _db: SQLite.SQLiteDatabase | null = null;

function localDateStr(d: Date): string {
  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0'),
  ].join('-');
}

function midnightUnix(dateStr: string): number {
  const [y, m, d] = dateStr.split('-').map(Number);
  return Math.floor(new Date(y, m - 1, d, 0, 0, 0, 0).getTime() / 1000);
}

export async function getDb(): Promise<SQLite.SQLiteDatabase> {
  if (_db) return _db;
  _db = await SQLite.openDatabaseAsync('whoomp.db');

  // Bootstrap tables
  await _db.execAsync(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS samples (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      unix        INTEGER NOT NULL,
      hr          INTEGER,
      rr_json     TEXT,
      flash_index INTEGER,
      source      TEXT
    );
    CREATE INDEX IF NOT EXISTS samples_unix ON samples (unix);
    CREATE TABLE IF NOT EXISTS daily (
      date          TEXT PRIMARY KEY,
      rmssd         REAL,
      rhr           REAL,
      strain        REAL,
      sleep_minutes INTEGER,
      recovery      REAL
    );
    CREATE TABLE IF NOT EXISTS schema_version (v INTEGER PRIMARY KEY);
  `);

  const row = await _db.getFirstAsync<{ v: number } | null>(
    'SELECT v FROM schema_version ORDER BY v DESC LIMIT 1',
  );
  const version = row?.v ?? 0;

  if (version < 1) {
    // Dedup historical samples (keep earliest row per unix+flash_index pair)
    await _db.execAsync(`
      DELETE FROM samples
        WHERE flash_index IS NOT NULL
          AND id NOT IN (
            SELECT MIN(id) FROM samples
            WHERE flash_index IS NOT NULL
            GROUP BY unix, flash_index
          );
      CREATE UNIQUE INDEX IF NOT EXISTS samples_dedup
        ON samples (unix, flash_index);
      INSERT OR IGNORE INTO schema_version (v) VALUES (1);
    `);
  }

  if (version < 2) {
    // Add calories column to daily rollup. ALTER fails if it already exists; ignore.
    try { await _db.execAsync('ALTER TABLE daily ADD COLUMN calories REAL'); } catch {}
    await _db.execAsync('INSERT OR IGNORE INTO schema_version (v) VALUES (2)');
  }

  if (version < 3) {
    // Per-stage sleep minutes for the Sleep screen breakdown.
    for (const col of ['deep_min', 'rem_min', 'light_min', 'awake_min']) {
      try { await _db.execAsync(`ALTER TABLE daily ADD COLUMN ${col} INTEGER`); } catch {}
    }
    await _db.execAsync('INSERT OR IGNORE INTO schema_version (v) VALUES (3)');
  }

  if (version < 4) {
    // v3 → v4: the WHOOP 4.0 V24 historical frame carries gravity/accelerometer, raw
    // respiration, SpO2 and skin-temperature ADCs alongside HR/RR. Persist them per sample so
    // the rewritten engine can stage sleep (gravity), score recovery (resp), etc.
    for (const col of [
      'gx REAL', 'gy REAL', 'gz REAL',
      'resp_raw INTEGER', 'spo2_red INTEGER', 'spo2_ir INTEGER',
      'skin_temp_raw INTEGER', 'skin_contact INTEGER',
    ]) {
      try { await _db.execAsync(`ALTER TABLE samples ADD COLUMN ${col}`); } catch {}
    }
    // Nightly engine outputs + the personal baselines (as of that day) so Trends can draw
    // deviation bands and the dashboard can show calibration status without recomputing.
    for (const col of [
      'resp_rate REAL', 'sleep_efficiency REAL',
      'hrv_baseline REAL', 'hrv_spread REAL',
      'rhr_baseline REAL', 'rhr_spread REAL',
      'recovery_state TEXT', 'sleep_stages TEXT',
    ]) {
      try { await _db.execAsync(`ALTER TABLE daily ADD COLUMN ${col}`); } catch {}
    }
    // The v2 rollup computed daily.rmssd as an all-day figure; the v3 engine measures it during
    // sleep. `daily` is fully derived from the preserved `samples` table, so clear it and let the
    // next rollupAllDays() rebuild every day with the new engine — avoids mixed semantics polluting
    // the baselines/trends during the transition.
    await _db.execAsync('DELETE FROM daily');
    await _db.execAsync('INSERT OR IGNORE INTO schema_version (v) VALUES (4)');
  }

  if (version < 5) {
    // v4 computed nightly sleep HRV without ectopic rejection, inflating RMSSD (the 172 ms
    // artifact). Rebuild the derived daily table from the preserved samples so every night uses
    // the corrected cleaning.
    await _db.execAsync('DELETE FROM daily');
    await _db.execAsync('INSERT OR IGNORE INTO schema_version (v) VALUES (5)');
  }

  if (version < 6) {
    // v5 rolled up only the single longest in-bed run per night (undercounting fragmented nights)
    // and derived respiration from the raw ADC channel (which yields no rate → "--"). The engine now
    // aggregates the WHOLE night across all sessions and derives respiration from R-R (RSA). Rebuild
    // the derived daily table from the preserved samples so every past night reflects both fixes.
    await _db.execAsync('DELETE FROM daily');
    await _db.execAsync('INSERT OR IGNORE INTO schema_version (v) VALUES (6)');
  }

  if (version < 7) {
    // Sleep-stage classifier was re-tuned against Fitbit ground truth (deep/REM no longer collapse
    // into Light). Rebuild the derived daily table so every night re-stages with the new thresholds.
    await _db.execAsync('DELETE FROM daily');
    await _db.execAsync('INSERT OR IGNORE INTO schema_version (v) VALUES (7)');
  }

  return _db;
}

export interface SampleInsert {
  unix: number;
  hr: number | null;
  rrIntervals: number[];
  flashIndex?: number | null;
  source: 'realtime' | 'historical';
  // V24/V12 biometric channels (historical only; null on realtime + generic frames).
  gravity?: { x: number; y: number; z: number } | null;
  respRaw?: number | null;
  spo2Red?: number | null;
  spo2Ir?: number | null;
  skinTempRaw?: number | null;
  skinContact?: number | null;
}

const MIN_VALID_UNIX = 1577836800; // 2020-01-01

export async function insertSample(s: SampleInsert): Promise<void> {
  // Guard against corrupt timestamps (e.g. a strap whose RTC hasn't synced yet)
  // landing in — and poisoning — the day buckets the dashboard rolls up.
  const nowUnix = Math.floor(Date.now() / 1000);
  if (!Number.isFinite(s.unix) || s.unix < MIN_VALID_UNIX || s.unix > nowUnix + 86400) return;
  const db = await getDb();
  const g = s.gravity ?? null;
  await db.runAsync(
    `INSERT OR IGNORE INTO samples
       (unix, hr, rr_json, flash_index, source, gx, gy, gz, resp_raw, spo2_red, spo2_ir, skin_temp_raw, skin_contact)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    s.unix,
    s.hr ?? null,
    s.rrIntervals.length > 0 ? JSON.stringify(s.rrIntervals) : null,
    s.flashIndex ?? null,
    s.source,
    g ? g.x : null,
    g ? g.y : null,
    g ? g.z : null,
    s.respRaw ?? null,
    s.spo2Red ?? null,
    s.spo2Ir ?? null,
    s.skinTempRaw ?? null,
    s.skinContact ?? null,
  );
}

export interface DailyRow {
  date: string;
  rmssd: number | null;
  rhr: number | null;
  strain: number | null;
  sleep_minutes: number | null;
  recovery: number | null;
  calories: number | null;
  deep_min: number | null;
  rem_min: number | null;
  light_min: number | null;
  awake_min: number | null;
  resp_rate?: number | null;
  sleep_efficiency?: number | null;
  hrv_baseline?: number | null;
  hrv_spread?: number | null;
  rhr_baseline?: number | null;
  rhr_spread?: number | null;
  recovery_state?: string | null;
  sleep_stages?: string | null; // JSON [{start,end,stage}] for the hypnogram
}

export async function upsertDaily(row: DailyRow): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `INSERT INTO daily (date, rmssd, rhr, strain, sleep_minutes, recovery, calories, deep_min, rem_min, light_min, awake_min,
                        resp_rate, sleep_efficiency, hrv_baseline, hrv_spread, rhr_baseline, rhr_spread, recovery_state, sleep_stages)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(date) DO UPDATE SET
       rmssd = excluded.rmssd,
       rhr = excluded.rhr,
       strain = excluded.strain,
       sleep_minutes = excluded.sleep_minutes,
       recovery = excluded.recovery,
       calories = excluded.calories,
       deep_min = excluded.deep_min,
       rem_min = excluded.rem_min,
       light_min = excluded.light_min,
       awake_min = excluded.awake_min,
       resp_rate = excluded.resp_rate,
       sleep_efficiency = excluded.sleep_efficiency,
       hrv_baseline = excluded.hrv_baseline,
       hrv_spread = excluded.hrv_spread,
       rhr_baseline = excluded.rhr_baseline,
       rhr_spread = excluded.rhr_spread,
       recovery_state = excluded.recovery_state,
       sleep_stages = excluded.sleep_stages`,
    row.date, row.rmssd, row.rhr, row.strain, row.sleep_minutes, row.recovery, row.calories,
    row.deep_min, row.rem_min, row.light_min, row.awake_min,
    row.resp_rate ?? null, row.sleep_efficiency ?? null,
    row.hrv_baseline ?? null, row.hrv_spread ?? null,
    row.rhr_baseline ?? null, row.rhr_spread ?? null,
    row.recovery_state ?? null, row.sleep_stages ?? null,
  );
}

export async function getDailyHistory(days: number): Promise<DailyRow[]> {
  const db = await getDb();
  return db.getAllAsync<DailyRow>(
    'SELECT * FROM daily ORDER BY date DESC LIMIT ?',
    days,
  );
}

export async function getRecentRrIntervals(sinceUnix: number): Promise<number[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<{ rr_json: string | null }>(
    'SELECT rr_json FROM samples WHERE unix >= ? AND rr_json IS NOT NULL ORDER BY unix ASC',
    sinceUnix,
  );
  const out: number[] = [];
  for (const row of rows) {
    if (row.rr_json) out.push(...(JSON.parse(row.rr_json) as number[]));
  }
  return out;
}

// Observed 99.5th-percentile HR over a trailing window, via a cheap SQL tail query (avoids
// loading the full series). Null when there aren't enough samples to trust it.
async function observedHrMaxP995(db: SQLite.SQLiteDatabase, sinceUnix: number): Promise<number | null> {
  const cnt = await db.getFirstAsync<{ n: number }>(
    'SELECT COUNT(*) AS n FROM samples WHERE unix >= ? AND hr IS NOT NULL AND hr >= 30 AND hr <= 230',
    sinceUnix,
  );
  const n = cnt?.n ?? 0;
  if (n < 600) return null;
  const k = Math.floor(n * 0.005) + 1; // the k-th highest ≈ the 99.5th percentile
  const rows = await db.getAllAsync<{ hr: number }>(
    'SELECT hr FROM samples WHERE unix >= ? AND hr IS NOT NULL AND hr >= 30 AND hr <= 230 ORDER BY hr DESC LIMIT ?',
    sinceUnix, k,
  );
  return rows.length ? rows[rows.length - 1].hr : null;
}

// Roll up one calendar day from raw samples → daily table. The daily row for date D holds:
//   • recovery + nightly HRV/RHR/resp measured during the sleep of night D-1→D (morning readiness),
//   • day-cumulative strain + calories over D's waking hours,
//   • the 4-class sleep stage breakdown for that night.
export async function rollupDay(dateStr?: string, profileArg?: UserProfile): Promise<void> {
  const date = dateStr ?? localDateStr(new Date());
  const profile = profileArg ?? await getProfile();
  const startUnix = midnightUnix(date);
  const endUnix = startUnix + 86400;
  const db = await getDb();

  // ── Day HR (strain + calories). Dedup to 1 Hz so overlapping realtime + historical
  //    samples don't double-count (both assume 1 Hz). ──
  const dayRows = await db.getAllAsync<{ unix: number; hr: number }>(
    'SELECT unix, hr FROM samples WHERE unix >= ? AND unix < ? AND hr IS NOT NULL ORDER BY unix ASC',
    startUnix, endUnix,
  );
  const hrBySecond = new Map<number, number>();
  for (const r of dayRows) hrBySecond.set(r.unix, r.hr);
  const hrSeries = [...hrBySecond.values()];

  // ── Night window (8pm prior day → 11am this day): sleep staging + nightly HRV/RHR/resp ──
  const [y, m, d] = date.split('-').map(Number);
  const nightStart = Math.floor(new Date(y, m - 1, d - 1, 20, 0, 0).getTime() / 1000);
  const nightEnd = Math.floor(new Date(y, m - 1, d, 11, 0, 0).getTime() / 1000);
  const nightRows = await db.getAllAsync<{
    unix: number; hr: number | null; rr_json: string | null;
    gx: number | null; gy: number | null; gz: number | null; resp_raw: number | null;
  }>(
    'SELECT unix, hr, rr_json, gx, gy, gz, resp_raw FROM samples WHERE unix >= ? AND unix < ? ORDER BY unix ASC',
    nightStart, nightEnd,
  );

  const hrN: HRSample[] = [];
  const rrN: RRInterval[] = [];
  const respN: RespSample[] = [];
  const gravN: GravitySample[] = [];
  for (const r of nightRows) {
    if (r.hr != null && r.hr >= 20 && r.hr <= 250) hrN.push({ ts: r.unix, bpm: r.hr });
    if (r.rr_json) for (const v of JSON.parse(r.rr_json) as number[]) rrN.push({ ts: r.unix, rrMs: v });
    if (r.resp_raw != null) respN.push({ ts: r.unix, raw: r.resp_raw });
    if (r.gx != null && r.gy != null && r.gz != null) gravN.push({ ts: r.unix, x: r.gx, y: r.gy, z: r.gz });
  }
  // Local UTC offset for the daytime-nap guard (positive east of UTC).
  if (dayRows.length === 0 && nightRows.length === 0) return; // nothing to roll up

  const tzOffsetSeconds = -new Date(startUnix * 1000).getTimezoneOffset() * 60;
  // Aggregate the WHOLE night (all in-bed runs), not just the longest — a fragmented night
  // (bathroom trip / restless stretch / data gap) otherwise reports only one chunk.
  const night = hrN.length >= 10 || gravN.length >= 120
    ? analyzeNightSummary({ hr: hrN, rr: rrN, resp: respN, gravity: gravN, tzOffsetSeconds })
    : null;

  const nightlyHrv = night?.avgHRV ?? null;
  const nightlyRhr = night?.restingHR ?? null;
  const nightlyResp = night?.respRate ?? null;
  const sleepEff = night?.efficiency ?? null;

  let sleep_minutes: number | null = null;
  let deep_min: number | null = null, rem_min: number | null = null, light_min: number | null = null, awake_min: number | null = null;
  if (night) {
    deep_min = night.deepMin; rem_min = night.remMin; light_min = night.lightMin; awake_min = night.wakeMin;
    sleep_minutes = night.asleepMin > 0 ? night.asleepMin : Math.round((night.end - night.start) / 60);
  }

  // ── Personalized HRmax: observed 99.5th-pct over the trailing 30 days, else Tanaka (≈191 @ age 24) ──
  const tanaka = tanakaHRmax(profile.age);
  const observed = await observedHrMaxP995(db, endUnix - 30 * 86400);
  const maxHR = observed != null && observed >= tanaka ? observed : tanaka;

  // ── Strain (day-cumulative) + calories ──
  const strain = hrSeries.length > 0
    ? strainScore(hrSeries, { maxHR, restingHR: nightlyRhr, sex: profile.sex, method: 'edwards' })
    : null;
  const calories = hrSeries.length > 0
    ? caloriesFromHrSeries(hrSeries, profile.age, profile.weightKg, profile.sex)
    : null;

  // ── Baselines folded from PRIOR nights only (causal) → recovery vs personal baseline ──
  const prior = await db.getAllAsync<{ rmssd: number | null; rhr: number | null; resp_rate: number | null }>(
    'SELECT rmssd, rhr, resp_rate FROM daily WHERE date < ? ORDER BY date ASC',
    date,
  );
  const hrvBaseline = foldHistory(prior.map(r => r.rmssd), hrvCfg);
  const rhrBaseline = foldHistory(prior.map(r => r.rhr), restingHrCfg);
  const respBaseline = foldHistory(prior.map(r => r.resp_rate), respCfg);

  let recovery: number | null = null;
  if (nightlyHrv != null && nightlyRhr != null) {
    recovery = recoveryBreakdown({
      hrv: nightlyHrv, rhr: nightlyRhr, resp: nightlyResp,
      hrvBaseline, rhrBaseline, respBaseline, sleepPerf: sleepEff,
    }).total;
  }

  await upsertDaily({
    date, rmssd: nightlyHrv, rhr: nightlyRhr, strain, sleep_minutes, recovery, calories,
    deep_min, rem_min, light_min, awake_min,
    resp_rate: nightlyResp, sleep_efficiency: sleepEff,
    hrv_baseline: hrvBaseline.baseline, hrv_spread: hrvBaseline.spread,
    rhr_baseline: rhrBaseline.baseline, rhr_spread: rhrBaseline.spread,
    recovery_state: hrvBaseline.status,
    sleep_stages: night ? JSON.stringify(night.stages) : null,
  });
}

// Roll up every distinct calendar day that has samples and either:
//   - has no row in daily yet, OR
//   - is today or yesterday (re-roll to capture freshly arrived data)
let _rollupRunning: Promise<void> | null = null;

// Coalesces concurrent callers (Home timer, BLE timer, screen mounts, history
// sync) onto a single run so they can't pile up or race on the daily table.
export function rollupAllDays(): Promise<void> {
  if (_rollupRunning) return _rollupRunning;
  const run = _rollupAllDaysImpl().finally(() => {
    if (_rollupRunning === run) _rollupRunning = null;
  });
  _rollupRunning = run;
  return run;
}

async function _rollupAllDaysImpl(): Promise<void> {
  const profile = await getProfile();
  const db = await getDb();
  const today = localDateStr(new Date());
  const yesterday = localDateStr(new Date(Date.now() - 86400_000));

  const dates = await db.getAllAsync<{ date: string }>(
    `SELECT DISTINCT date(unix, 'unixepoch', 'localtime') AS date
     FROM samples
     WHERE date(unix, 'unixepoch', 'localtime') IS NOT NULL
       AND (
         date(unix, 'unixepoch', 'localtime') NOT IN (SELECT date FROM daily)
         OR date(unix, 'unixepoch', 'localtime') = ?
         OR date(unix, 'unixepoch', 'localtime') = ?
       )
     ORDER BY date ASC`,
    today, yesterday,
  );

  for (const { date } of dates) {
    await rollupDay(date, profile);
  }
}

export async function getSampleCount(): Promise<number> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ n: number }>('SELECT COUNT(*) AS n FROM samples');
  return row?.n ?? 0;
}

// Sync diagnostics: how many samples came from realtime vs the historical flash drain, and the
// time span of the historical (gravity-bearing) data. Used by the Settings sync panel to make the
// flash-drain visible — historical=0 means the strap's 14-day store has never reached the phone.
export async function getSourceCounts(): Promise<{ realtime: number; historical: number; withGravity: number }> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ rt: number; hist: number; grav: number }>(
    `SELECT
       SUM(CASE WHEN source='realtime'   THEN 1 ELSE 0 END) AS rt,
       SUM(CASE WHEN source='historical' THEN 1 ELSE 0 END) AS hist,
       SUM(CASE WHEN gx IS NOT NULL      THEN 1 ELSE 0 END) AS grav
     FROM samples`,
  );
  return { realtime: row?.rt ?? 0, historical: row?.hist ?? 0, withGravity: row?.grav ?? 0 };
}

export async function getHistoricalRange(): Promise<{ minUnix: number; maxUnix: number } | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ lo: number | null; hi: number | null }>(
    `SELECT MIN(unix) AS lo, MAX(unix) AS hi FROM samples WHERE source='historical'`,
  );
  return row?.lo != null && row?.hi != null ? { minUnix: row.lo, maxUnix: row.hi } : null;
}

// Local date (YYYY-MM-DD) of the most recent sample, or null if none.
export async function getLatestSampleDate(): Promise<string | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ date: string | null }>(
    `SELECT date(MAX(unix), 'unixepoch', 'localtime') AS date FROM samples`,
  );
  return row?.date ?? null;
}

export interface IntradayPoint { minute: number; hr: number }

// Bucketed mean HR across one calendar day, for the intraday Trends chart.
export async function getIntradayHr(dateStr: string, bucketMin = 10): Promise<IntradayPoint[]> {
  const db = await getDb();
  const startUnix = midnightUnix(dateStr);
  const endUnix = startUnix + 86400;
  const rows = await db.getAllAsync<{ unix: number; hr: number }>(
    'SELECT unix, hr FROM samples WHERE unix >= ? AND unix < ? AND hr IS NOT NULL AND hr >= 30 AND hr <= 220 ORDER BY unix ASC',
    startUnix, endUnix,
  );
  const sums = new Map<number, { sum: number; n: number }>();
  const bucketSec = bucketMin * 60;
  for (const r of rows) {
    const bucket = Math.floor((r.unix - startUnix) / bucketSec);
    const acc = sums.get(bucket) ?? { sum: 0, n: 0 };
    acc.sum += r.hr; acc.n += 1;
    sums.set(bucket, acc);
  }
  return [...sums.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([bucket, acc]) => ({ minute: bucket * bucketMin, hr: Math.round(acc.sum / acc.n) }));
}

export interface ExportSampleRow {
  unix: number;
  hr: number | null;
  rr_json: string | null;
  source: string | null;
  gx: number | null;
  gy: number | null;
  gz: number | null;
  resp_raw: number | null;
  skin_contact: number | null;
}

export async function getAllSamples(): Promise<ExportSampleRow[]> {
  const db = await getDb();
  return db.getAllAsync<ExportSampleRow>(
    'SELECT unix, hr, rr_json, source, gx, gy, gz, resp_raw, skin_contact FROM samples ORDER BY unix ASC',
  );
}
