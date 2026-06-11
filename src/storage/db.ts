import * as SQLite from 'expo-sqlite';

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
