import { useState, useEffect, useRef, useCallback } from 'react';
import { WhoopClient, ClientState } from './WhoopClient';
import { insertSample, rollupAllDays, getRecentRrIntervals, getSourceCounts, getHistoricalRange } from '../storage/db';
import { analyzeHrv, rangeFilter, median } from '../metrics/hrv';
import { caloriesFromHrSeries } from '../metrics/zones';
import { getProfile, type UserProfile } from '../storage/settings';

const RR_WINDOW = 300;   // ~5 min of RR intervals
const HR_BUFFER = 60;    // 60-second live sparkline
const SYNC_LOG_MAX = 30; // rolling sync-diagnostic log lines kept for the Settings panel

export interface SyncStatus {
  state: 'idle' | 'syncing' | 'done' | 'error';
  lastSyncAt: number | null;   // ms epoch of last completed sync
  lastFrames: number | null;   // frames in the last/current drain
  realtime: number;            // DB realtime sample count
  historical: number;          // DB historical sample count (gravity-bearing)
  withGravity: number;         // DB samples carrying gravity
  strapRange: { startUnix: number; endUnix: number } | null; // GET_DATA_RANGE (what the strap has)
  histRange: { minUnix: number; maxUnix: number } | null;    // span of historical data in the DB
  consoleOnlyStreak: number; // consecutive drains that completed with 0 sensor frames (NOOP's clock-lost signal)
  strapRtc: { raw: number; valid: boolean; savingBlocked: boolean } | null; // strap RTC scraped from console logs
  lastError: string | null;
  log: string[];
}

const INITIAL_SYNC: SyncStatus = {
  state: 'idle', lastSyncAt: null, lastFrames: null, realtime: 0, historical: 0,
  withGravity: 0, strapRange: null, histRange: null, consoleOnlyStreak: 0, strapRtc: null, lastError: null, log: [],
};

function hhmmss(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

export function useBLE() {
  const clientRef = useRef<WhoopClient | null>(null);
  const [state, setState] = useState<ClientState>('disconnected');
  const [heartRate, setHeartRate] = useState<number | null>(null);
  const [rr, setRr] = useState<number[]>([]);
  const [battery, setBattery] = useState<number | null>(null);
  const [hrv, setHrv] = useState<number | null>(null);
  const [hrBuffer60, setHrBuffer60] = useState<(number | null)[]>([]);
  const [sessionStartUnix, setSessionStartUnix] = useState<number | null>(null);
  const [calories, setCalories] = useState<number>(0);
  const [syncStatus, setSyncStatus] = useState<SyncStatus>(INITIAL_SYNC);

  // Accumulate today's HR series for calorie estimate (persists across re-renders)
  const hrTodayRef = useRef<number[]>([]);
  const profileRef = useRef<UserProfile | null>(null);
  const hrRecentRef = useRef<number[]>([]); // last few raw HR for spike rejection

  const pushLog = (log: string[], line: string): string[] =>
    [...log.slice(-(SYNC_LOG_MAX - 1)), `${hhmmss(Date.now())}  ${line}`];

  // Refresh DB-derived sync counters (realtime vs historical, gravity coverage, historical span).
  const refreshSyncCounts = useCallback(async () => {
    try {
      const [c, hr] = await Promise.all([getSourceCounts(), getHistoricalRange()]);
      setSyncStatus(s => ({ ...s, realtime: c.realtime, historical: c.historical, withGravity: c.withGravity, histRange: hr }));
    } catch {}
  }, []);

  useEffect(() => {
    rollupAllDays().catch(() => {});
    getProfile().then(p => { profileRef.current = p; }).catch(() => {});

    const client = new WhoopClient();
    clientRef.current = client;
    const off = [
      client.on<ClientState>('state', setState),

      client.on<{ heartRateBpm: number | null; rrIntervalsMs: number[]; receivedAt: number }>(
        'realtime',
        ({ heartRateBpm, rrIntervalsMs, receivedAt }) => {
          // RR window for HRV (analyzeHrv applies range + Malik ectopic cleaning).
          setRr(prev => {
            const next = [...prev.slice(-RR_WINDOW), ...rrIntervalsMs];
            setHrv(analyzeHrv(next).rmssd);
            return next;
          });

          if (heartRateBpm != null) {
            // The strap's PPG HR byte momentarily spikes (e.g. 62→104→61) when wrist contact is
            // imperfect — the "random ~100". Two defenses before display:
            //  1. Cross-check against beat-to-beat timing in the SAME packet: with ≥2 R-R intervals,
            //     60000/median(RR) is an independent HR estimate; when the byte disagrees by >25 bpm
            //     it's a PPG artifact, so prefer the RR-derived value.
            //  2. median-of-5 over recent readings rejects residual single/double spikes without
            //     lagging a genuine change (which persists ≥3 samples).
            // The raw byte is still stored below for fidelity.
            const rrClean = rangeFilter(rrIntervalsMs);
            const rrHr = rrClean.length >= 2 ? Math.round(60000 / median(rrClean)) : null;
            const candidate = (rrHr != null && rrHr >= 30 && rrHr <= 220 && Math.abs(heartRateBpm - rrHr) > 25)
              ? rrHr : heartRateBpm;
            const r = hrRecentRef.current;
            r.push(candidate);
            if (r.length > 5) r.shift();
            const shownHr = [...r].sort((a, b) => a - b)[r.length >> 1];
            setHeartRate(shownHr);
            setHrBuffer60(prev => [...prev.slice(-(HR_BUFFER - 1)), shownHr]);

            hrTodayRef.current.push(shownHr);
            const p = profileRef.current;
            setCalories(caloriesFromHrSeries(hrTodayRef.current, p?.age ?? 30, p?.weightKg ?? null, p?.sex ?? null));
          } else {
            setHeartRate(null);
          }

          insertSample({
            unix: Math.floor(receivedAt / 1000),
            hr: heartRateBpm, // raw, for fidelity
            rrIntervals: rrIntervalsMs,
            source: 'realtime',
          }).catch(() => {});
        }
      ),

      client.on<{
        unix: number; heartRateBpm: number | null; rrIntervalsMs: number[]; flashIndex: number;
        gravity?: { x: number; y: number; z: number }; respRaw?: number;
        spo2Red?: number; spo2Ir?: number; skinTempRaw?: number; skinContact?: number;
      }>(
        'historicalSample',
        ({ unix, heartRateBpm, rrIntervalsMs, flashIndex, gravity, respRaw, spo2Red, spo2Ir, skinTempRaw, skinContact }) => {
          insertSample({
            unix, hr: heartRateBpm, rrIntervals: rrIntervalsMs, flashIndex,
            source: 'historical',
            gravity, respRaw, spo2Red, spo2Ir, skinTempRaw, skinContact,
          }).catch(() => {});
        }
      ),

      // ── Historical flash-drain diagnostics (Settings sync panel) ──
      client.on('historyStart', () => {
        setSyncStatus(s => ({ ...s, state: 'syncing', lastFrames: 0, lastError: null, log: pushLog(s.log, 'sync started → SEND_HISTORICAL_DATA') }));
      }),
      client.on<{ samples: number; trim: number }>('historyProgress', ({ samples, trim }) => {
        setSyncStatus(s => ({ ...s, lastFrames: samples, log: pushLog(s.log, `chunk acked · ${samples} frames so far (trim ${trim})`) }));
      }),
      client.on<{ samples: number }>('historyComplete', ({ samples }) => {
        setSyncStatus(s => ({
          ...s, state: 'done', lastFrames: samples, lastSyncAt: Date.now(),
          consoleOnlyStreak: samples === 0 ? s.consoleOnlyStreak + 1 : 0,
          log: pushLog(s.log, `COMPLETE · ${samples} frames this drain`),
        }));
        rollupAllDays().then(refreshSyncCounts).catch(() => {});
      }),
      client.on<Error>('historyError', (e) => {
        const msg = e?.message ?? String(e);
        setSyncStatus(s => ({ ...s, state: 'error', lastError: msg, log: pushLog(s.log, `ERROR · ${msg}`) }));
        refreshSyncCounts();
      }),
      client.on<{ startUnix: number; endUnix: number }>('dataRange', (r) => {
        setSyncStatus(s => ({ ...s, strapRange: r }));
      }),
      client.on<{ raw: number; valid: boolean; savingBlocked: boolean }>('strapRtc', (rtc) => {
        setSyncStatus(s => ({ ...s, strapRtc: rtc }));
      }),
      client.on<string>('log', (text) => {
        setSyncStatus(s => ({ ...s, log: pushLog(s.log, text) }));
      }),

      client.on<number>('battery', setBattery),
    ];
    refreshSyncCounts();
    return () => { off.forEach(fn => fn()); client.destroy(); };
  }, [refreshSyncCounts]);

  // Seed HRV + mark session start when BLE connects
  useEffect(() => {
    if (state !== 'connected') return;
    setSessionStartUnix(Math.floor(Date.now() / 1000));
    // New session → reset the in-session calorie counter.
    hrTodayRef.current = [];
    setCalories(0);
    const sinceUnix = Math.floor(Date.now() / 1000) - 300;
    getRecentRrIntervals(sinceUnix).then(intervals => {
      if (intervals.length >= 5) {
        setRr(intervals.slice(-RR_WINDOW));
        setHrv(analyzeHrv(intervals).rmssd);
      }
    }).catch(() => {});

    // Re-roll daily aggregates while connected so live samples persist into the
    // tables the dashboard reads (Home / Trends / Sleep) without needing a
    // reconnect or app restart.
    const rollupTimer = setInterval(() => { rollupAllDays().catch(() => {}); }, 120_000);
    return () => clearInterval(rollupTimer);
  }, [state]);

  const scan = useCallback(() => clientRef.current?.scan(), []);
  const disconnect = useCallback(() => clientRef.current?.disconnect(), []);

  // Manually kick a flash drain (Settings → "Sync history now"): refresh the strap's data range,
  // then request the historical offload. Surfaces everything through syncStatus for diagnosis.
  const syncNow = useCallback(async () => {
    const c = clientRef.current;
    if (!c) return;
    setSyncStatus(s => ({ ...s, log: [...s.log.slice(-(SYNC_LOG_MAX - 1)), `${hhmmss(Date.now())}  manual sync requested`] }));
    try { await c.getDataRange(); } catch {}
    try { await c.downloadHistory(); } catch {}
  }, []);

  return {
    state, heartRate, rr, battery, hrv, hrBuffer60, sessionStartUnix, calories, scan, disconnect,
    syncStatus, syncNow, refreshSyncCounts,
  };
}
