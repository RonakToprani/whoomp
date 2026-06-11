import * as SQLite from 'expo-sqlite';
import { rmssd, filterRr } from '../metrics/hrv';
import { strainScore } from '../metrics/strain';
import { recoveryScore } from '../metrics/recovery';
import { detectSleepWindow } from '../metrics/sleep';

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

  return _db;
}

export interface SampleInsert {
  unix: number;
  hr: number | null;
  rrIntervals: number[];
  flashIndex?: number | null;
  source: 'realtime' | 'historical';
}

export async function insertSample(s: SampleInsert): Promise<void> {
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
}

export async function upsertDaily(row: DailyRow): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `INSERT INTO daily (date, rmssd, rhr, strain, sleep_minutes, recovery)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(date) DO UPDATE SET
       rmssd = excluded.rmssd,
       rhr = excluded.rhr,
       strain = excluded.strain,
       sleep_minutes = excluded.sleep_minutes,
       recovery = excluded.recovery`,
    row.date, row.rmssd, row.rhr, row.strain, row.sleep_minutes, row.recovery,
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
export async function rollupDay(dateStr?: string, age = 30): Promise<void> {
  const date = dateStr ?? localDateStr(new Date());
  const startUnix = midnightUnix(date);
  const endUnix = startUnix + 86400;

  const db = await getDb();
  const rows = await db.getAllAsync<{ hr: number | null; rr_json: string | null }>(
    'SELECT hr, rr_json FROM samples WHERE unix >= ? AND unix < ? ORDER BY unix ASC',
    startUnix, endUnix,
  );
  if (rows.length === 0) return;

  const hrSeries: number[] = [];
  const allRr: number[] = [];
  for (const row of rows) {
    if (row.hr != null) hrSeries.push(row.hr);
    if (row.rr_json) allRr.push(...(JSON.parse(row.rr_json) as number[]));
  }

  const todayRmssd = rmssd(filterRr(allRr));
  const sortedHr = [...hrSeries].sort((a, b) => a - b);
  const rhr = sortedHr.length > 0 ? sortedHr[Math.floor(sortedHr.length * 0.05)] : null;
  const strain = hrSeries.length > 0 ? strainScore(hrSeries, age) : null;

  const history = await db.getAllAsync<{ rmssd: number | null }>(
    'SELECT rmssd FROM daily WHERE date < ? ORDER BY date DESC LIMIT 14',
    date,
  );
  const recovery = recoveryScore(todayRmssd, history.map(r => r.rmssd));

  // Detect sleep from the night preceding this date (8pm prior day → 11am this day)
  const [y, m, d] = date.split('-').map(Number);
  const nightStart = Math.floor(new Date(y, m - 1, d - 1, 20, 0, 0).getTime() / 1000);
  const nightEnd   = Math.floor(new Date(y, m - 1, d,     11, 0, 0).getTime() / 1000);
  const nightRows = await db.getAllAsync<{ unix: number; hr: number | null; rr_json: string | null }>(
    'SELECT unix, hr, rr_json FROM samples WHERE unix >= ? AND unix < ? ORDER BY unix ASC',
    nightStart, nightEnd,
  );
  let sleep_minutes: number | null = null;
  if (nightRows.length >= 10) {
    const sleepSamples = nightRows.map(r => ({
      ts_utc: new Date(r.unix * 1000).toISOString(),
      heart_rate_bpm: r.hr,
      rr_interval_ms: r.rr_json ? (JSON.parse(r.rr_json) as number[])[0] ?? null : null,
    }));
    const window = detectSleepWindow(sleepSamples, date);
    if (window) {
      sleep_minutes = Math.round((window[1].getTime() - window[0].getTime()) / 60_000);
    }
  }

  await upsertDaily({ date, rmssd: todayRmssd, rhr, strain, sleep_minutes, recovery });
}

// Roll up every distinct calendar day that has samples and either:
//   - has no row in daily yet, OR
//   - is today or yesterday (re-roll to capture freshly arrived data)
export async function rollupAllDays(age = 30): Promise<void> {
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
