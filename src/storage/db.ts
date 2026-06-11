import * as SQLite from 'expo-sqlite';
import { rmssd, filterRr } from '../metrics/hrv';
import { strainScore } from '../metrics/strain';
import { recoveryScore } from '../metrics/recovery';

let _db: SQLite.SQLiteDatabase | null = null;

export async function getDb(): Promise<SQLite.SQLiteDatabase> {
  if (_db) return _db;
  _db = await SQLite.openDatabaseAsync('whoomp.db');
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
  `);
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
    'INSERT INTO samples (unix, hr, rr_json, flash_index, source) VALUES (?, ?, ?, ?, ?)',
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

// Roll up all samples for a given date into the daily table.
// dateStr defaults to today in local time. age used for strain estimate.
export async function rollupDay(dateStr?: string, age = 30): Promise<void> {
  const now = new Date();
  const date = dateStr ?? [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('-');

  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startUnix = Math.floor(midnight.getTime() / 1000);
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

  // Resting HR: 5th-percentile of all readings (proxy for overnight min)
  const sortedHr = [...hrSeries].sort((a, b) => a - b);
  const rhr = sortedHr.length > 0 ? sortedHr[Math.floor(sortedHr.length * 0.05)] : null;

  const strain = hrSeries.length > 0 ? strainScore(hrSeries, age) : null;

  // Load prior history to compute recovery z-score
  const history = await db.getAllAsync<{ rmssd: number | null }>(
    "SELECT rmssd FROM daily WHERE date < ? ORDER BY date DESC LIMIT 14",
    date,
  );
  const rmssdHistory = history.map(r => r.rmssd);
  const recovery = recoveryScore(todayRmssd, rmssdHistory);

  await upsertDaily({ date, rmssd: todayRmssd, rhr, strain, sleep_minutes: null, recovery });
}

export async function getRecentRrIntervals(sinceUnix: number): Promise<number[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<{ rr_json: string | null }>(
    'SELECT rr_json FROM samples WHERE unix >= ? AND rr_json IS NOT NULL ORDER BY unix ASC',
    sinceUnix,
  );
  const out: number[] = [];
  for (const row of rows) {
    if (row.rr_json) {
      const arr = JSON.parse(row.rr_json) as number[];
      out.push(...arr);
    }
  }
  return out;
}
