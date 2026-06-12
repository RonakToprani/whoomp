import * as SQLite from 'expo-sqlite';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { rmssd, filterRr } from '../metrics/hrv';
import { strainScore } from '../metrics/strain';
import { recoveryScore } from '../metrics/recovery';
import { detectSleepWindow, classifyStages, stageTotals } from '../metrics/sleep';
import { caloriesFromHrSeries } from '../metrics/zones';

const AGE_KEY = '@whoomp/age';

let _db: SQLite.SQLiteDatabase | null = null;

async function storedAge(): Promise<number> {
  try {
    const v = await AsyncStorage.getItem(AGE_KEY);
    const n = v ? parseInt(v, 10) : NaN;
    return Number.isFinite(n) && n > 0 ? n : 30;
  } catch {
    return 30;
  }
}

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

  return _db;
}

export interface SampleInsert {
  unix: number;
  hr: number | null;
  rrIntervals: number[];
  flashIndex?: number | null;
  source: 'realtime' | 'historical';
}

const MIN_VALID_UNIX = 1577836800; // 2020-01-01

export async function insertSample(s: SampleInsert): Promise<void> {
  // Guard against corrupt timestamps (e.g. a strap whose RTC hasn't synced yet)
  // landing in — and poisoning — the day buckets the dashboard rolls up.
  const nowUnix = Math.floor(Date.now() / 1000);
  if (!Number.isFinite(s.unix) || s.unix < MIN_VALID_UNIX || s.unix > nowUnix + 86400) return;
  const db = await getDb();
  await db.runAsync(
    'INSERT OR IGNORE INTO samples (unix, hr, rr_json, flash_index, source) VALUES (?, ?, ?, ?, ?)',
    s.unix,
    s.hr ?? null,
    s.rrIntervals.length > 0 ? JSON.stringify(s.rrIntervals) : null,
    s.flashIndex ?? null,
    s.source,
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
}

export async function upsertDaily(row: DailyRow): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `INSERT INTO daily (date, rmssd, rhr, strain, sleep_minutes, recovery, calories, deep_min, rem_min, light_min, awake_min)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
       awake_min = excluded.awake_min`,
    row.date, row.rmssd, row.rhr, row.strain, row.sleep_minutes, row.recovery, row.calories,
    row.deep_min, row.rem_min, row.light_min, row.awake_min,
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

// Roll up one calendar day from raw samples → daily table.
export async function rollupDay(dateStr?: string, ageArg?: number): Promise<void> {
  const date = dateStr ?? localDateStr(new Date());
  const age = ageArg ?? await storedAge();
  const startUnix = midnightUnix(date);
  const endUnix = startUnix + 86400;

  const db = await getDb();
  const rows = await db.getAllAsync<{ unix: number; hr: number | null; rr_json: string | null }>(
    'SELECT unix, hr, rr_json FROM samples WHERE unix >= ? AND unix < ? ORDER BY unix ASC',
    startUnix, endUnix,
  );
  if (rows.length === 0) return;

  // Dedupe HR to one value per second so overlapping realtime + historical
  // samples don't double-count toward strain / calories (both assume 1 Hz).
  const hrBySecond = new Map<number, number>();
  const allRr: number[] = [];
  for (const row of rows) {
    if (row.hr != null) hrBySecond.set(row.unix, row.hr);
    if (row.rr_json) allRr.push(...(JSON.parse(row.rr_json) as number[]));
  }
  const hrSeries = [...hrBySecond.values()];

  const todayRmssd = rmssd(filterRr(allRr));

  // RHR: use overnight window (8pm prior night → 8am this day) for true resting state
  // Falls back to all-day 5th percentile when overnight data is missing
  const [y, m, d] = date.split('-').map(Number);
  const nightStart = Math.floor(new Date(y, m - 1, d - 1, 20, 0, 0).getTime() / 1000);
  const nightEnd   = Math.floor(new Date(y, m - 1, d,     11, 0, 0).getTime() / 1000);
  const overnightHrRows = await db.getAllAsync<{ hr: number }>(
    'SELECT hr FROM samples WHERE unix >= ? AND unix < ? AND hr IS NOT NULL AND hr >= 30 AND hr <= 120 ORDER BY unix ASC',
    nightStart, Math.floor(new Date(y, m - 1, d, 8, 0, 0).getTime() / 1000),
  );
  const overnightHr = overnightHrRows.map(r => r.hr).sort((a, b) => a - b);
  const fallbackHr = [...hrSeries.filter(h => h >= 30 && h <= 120)].sort((a, b) => a - b);
  const rhrSource = overnightHr.length >= 20 ? overnightHr : fallbackHr;
  const rhr = rhrSource.length > 0 ? rhrSource[Math.floor(rhrSource.length * 0.05)] : null;

  const strain = hrSeries.length > 0 ? strainScore(hrSeries, age, rhr) : null;
  const calories = hrSeries.length > 0 ? caloriesFromHrSeries(hrSeries, age, null, null) : null;

  const history = await db.getAllAsync<{ rmssd: number | null }>(
    'SELECT rmssd FROM daily WHERE date < ? ORDER BY date DESC LIMIT 14',
    date,
  );
  const recovery = recoveryScore(todayRmssd, history.map(r => r.rmssd));

  // Sleep: detect window in the night preceding this date (8pm prior day → 11am this day)
  const nightRows = await db.getAllAsync<{ unix: number; hr: number | null; rr_json: string | null }>(
    'SELECT unix, hr, rr_json FROM samples WHERE unix >= ? AND unix < ? ORDER BY unix ASC',
    nightStart, nightEnd,
  );
  let sleep_minutes: number | null = null;
  let deep_min: number | null = null;
  let rem_min: number | null = null;
  let light_min: number | null = null;
  let awake_min: number | null = null;
  if (nightRows.length >= 10) {
    const sleepSamples = nightRows.map(r => ({
      ts_utc: new Date(r.unix * 1000).toISOString(),
      // Drop physiologically-impossible-for-sleep HR so a stray spike can't
      // inflate the threshold and fragment the night.
      heart_rate_bpm: (r.hr != null && r.hr >= 30 && r.hr <= 120) ? r.hr : null,
      rr_interval_ms: r.rr_json ? (JSON.parse(r.rr_json) as number[])[0] ?? null : null,
    }));
    const window = detectSleepWindow(sleepSamples, date);
    if (window) {
      const totals = stageTotals(classifyStages(sleepSamples, window));
      deep_min = totals.deep;
      rem_min = totals.rem;
      light_min = totals.light;
      awake_min = totals.wake;
      const asleep = totals.deep + totals.rem + totals.light;
      // Time asleep (wake within the window excluded); fall back to window span.
      sleep_minutes = asleep > 0 ? asleep : Math.round((window[1].getTime() - window[0].getTime()) / 60_000);
    }
  }

  await upsertDaily({
    date, rmssd: todayRmssd, rhr, strain, sleep_minutes, recovery, calories,
    deep_min, rem_min, light_min, awake_min,
  });
}

// Roll up every distinct calendar day that has samples and either:
//   - has no row in daily yet, OR
//   - is today or yesterday (re-roll to capture freshly arrived data)
let _rollupRunning: Promise<void> | null = null;

// Coalesces concurrent callers (Home timer, BLE timer, screen mounts, history
// sync) onto a single run so they can't pile up or race on the daily table.
export function rollupAllDays(ageArg?: number): Promise<void> {
  if (_rollupRunning) return _rollupRunning;
  const run = _rollupAllDaysImpl(ageArg).finally(() => {
    if (_rollupRunning === run) _rollupRunning = null;
  });
  _rollupRunning = run;
  return run;
}

async function _rollupAllDaysImpl(ageArg?: number): Promise<void> {
  const age = ageArg ?? await storedAge();
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
    await rollupDay(date, age);
  }
}

export async function getSampleCount(): Promise<number> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ n: number }>('SELECT COUNT(*) AS n FROM samples');
  return row?.n ?? 0;
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
}

export async function getAllSamples(): Promise<ExportSampleRow[]> {
  const db = await getDb();
  return db.getAllAsync<ExportSampleRow>(
    'SELECT unix, hr, rr_json, source FROM samples ORDER BY unix ASC',
  );
}
