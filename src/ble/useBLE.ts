import { useState, useEffect, useRef, useCallback } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { WhoopClient, ClientState } from './WhoopClient';
import { insertSample, rollupAllDays, getRecentRrIntervals } from '../storage/db';
import { rmssd, filterRr } from '../metrics/hrv';

const RR_WINDOW = 300;
const AGE_KEY = '@whoomp/age';

async function getAge(): Promise<number> {
  try {
    const v = await AsyncStorage.getItem(AGE_KEY);
    const n = v ? parseInt(v, 10) : NaN;
    return Number.isFinite(n) && n > 0 ? n : 30;
  } catch {
    return 30;
  }
}

export function useBLE() {
  const clientRef = useRef<WhoopClient | null>(null);
  const [state, setState] = useState<ClientState>('disconnected');
  const [heartRate, setHeartRate] = useState<number | null>(null);
  const [rr, setRr] = useState<number[]>([]);
  const [battery, setBattery] = useState<number | null>(null);
  const [hrv, setHrv] = useState<number | null>(null);

  // On launch: roll up all days that have samples but no daily row yet
  useEffect(() => {
    getAge().then(age => rollupAllDays(age)).catch(() => {});

    const client = new WhoopClient();
    clientRef.current = client;
    const off = [
      client.on<ClientState>('state', setState),

      client.on<{ heartRateBpm: number | null; rrIntervalsMs: number[]; receivedAt: number }>(
        'realtime',
        ({ heartRateBpm, rrIntervalsMs, receivedAt }) => {
          setHeartRate(heartRateBpm);
          setRr(prev => {
            const next = [...prev.slice(-RR_WINDOW), ...rrIntervalsMs];
            setHrv(rmssd(filterRr(next)));
            return next;
          });
          insertSample({
            unix: Math.floor(receivedAt / 1000),
            hr: heartRateBpm,
            rrIntervals: rrIntervalsMs,
            source: 'realtime',
          }).catch(() => {});
        }
      ),

      client.on<{ unix: number; heartRateBpm: number | null; rrIntervalsMs: number[]; flashIndex: number }>(
        'historicalSample',
        ({ unix, heartRateBpm, rrIntervalsMs, flashIndex }) => {
          insertSample({
            unix,
            hr: heartRateBpm,
            rrIntervals: rrIntervalsMs,
            flashIndex,
            source: 'historical',
          }).catch(() => {});
        }
      ),

      // Flash drain finished — roll up every day that now has new data
      client.on<{ samples: number }>('historyComplete', () => {
        getAge().then(age => rollupAllDays(age)).catch(() => {});
      }),

      client.on<number>('battery', setBattery),
    ];
    return () => { off.forEach(fn => fn()); client.destroy(); };
  }, []);

  // When BLE connects, seed HRV from the last 5 min of stored RR intervals
  // so the metric isn't blank while waiting for the first live packets
  useEffect(() => {
    if (state !== 'connected') return;
    const sinceUnix = Math.floor(Date.now() / 1000) - 300;
    getRecentRrIntervals(sinceUnix).then(intervals => {
      if (intervals.length >= 5) {
        setRr(intervals.slice(-RR_WINDOW));
        setHrv(rmssd(filterRr(intervals)));
      }
    }).catch(() => {});
  }, [state]);

  const scan = useCallback(() => clientRef.current?.scan(), []);
  const disconnect = useCallback(() => clientRef.current?.disconnect(), []);

  return { state, heartRate, rr, battery, hrv, scan, disconnect };
}
