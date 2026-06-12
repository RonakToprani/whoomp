import { useState, useEffect, useRef, useCallback } from 'react';
import { WhoopClient, ClientState } from './WhoopClient';
import { insertSample, rollupAllDays, getRecentRrIntervals } from '../storage/db';
import { analyzeHrv } from '../metrics/hrv';
import { caloriesFromHrSeries } from '../metrics/zones';
import { getProfile, type UserProfile } from '../storage/settings';

const RR_WINDOW = 300;   // ~5 min of RR intervals
const HR_BUFFER = 60;    // 60-second live sparkline

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

  // Accumulate today's HR series for calorie estimate (persists across re-renders)
  const hrTodayRef = useRef<number[]>([]);
  const profileRef = useRef<UserProfile | null>(null);

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
          setHeartRate(heartRateBpm);

          // RR window for HRV
          setRr(prev => {
            const next = [...prev.slice(-RR_WINDOW), ...rrIntervalsMs];
            setHrv(analyzeHrv(next).rmssd);
            return next;
          });

          // 60-second HR sparkline
          if (heartRateBpm != null) {
            setHrBuffer60(prev => [...prev.slice(-(HR_BUFFER - 1)), heartRateBpm]);

            // Running calorie total — accumulate all HR readings since mount (Keytel w/ profile)
            hrTodayRef.current.push(heartRateBpm);
            const p = profileRef.current;
            setCalories(caloriesFromHrSeries(hrTodayRef.current, p?.age ?? 30, p?.weightKg ?? null, p?.sex ?? null));
          }

          insertSample({
            unix: Math.floor(receivedAt / 1000),
            hr: heartRateBpm,
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

      client.on<{ samples: number }>('historyComplete', () => {
        rollupAllDays().catch(() => {});
      }),

      client.on<number>('battery', setBattery),
    ];
    return () => { off.forEach(fn => fn()); client.destroy(); };
  }, []);

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

  return { state, heartRate, rr, battery, hrv, hrBuffer60, sessionStartUnix, calories, scan, disconnect };
}
