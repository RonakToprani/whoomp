import { useState, useEffect, useRef, useCallback } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { WhoopClient, ClientState } from './WhoopClient';
import { insertSample, rollupDay } from '../storage/db';
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

  useEffect(() => {
    // Roll up any samples already in DB from previous sessions (today + yesterday)
    getAge().then(age => {
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      const yStr = [
        yesterday.getFullYear(),
        String(yesterday.getMonth() + 1).padStart(2, '0'),
        String(yesterday.getDate()).padStart(2, '0'),
      ].join('-');
      rollupDay(yStr, age).catch(() => {});
      rollupDay(undefined, age).catch(() => {});
    });

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
      // After flash drain completes, re-roll up today (+ yesterday in case drain crossed midnight)
      client.on<{ samples: number }>('historyComplete', () => {
        getAge().then(age => {
          const yesterday = new Date();
          yesterday.setDate(yesterday.getDate() - 1);
          const yStr = [
            yesterday.getFullYear(),
            String(yesterday.getMonth() + 1).padStart(2, '0'),
            String(yesterday.getDate()).padStart(2, '0'),
          ].join('-');
          rollupDay(yStr, age).catch(() => {});
          rollupDay(undefined, age).catch(() => {});
        });
      }),
      client.on<number>('battery', setBattery),
    ];
    return () => { off.forEach(fn => fn()); client.destroy(); };
  }, []);

  const scan = useCallback(() => clientRef.current?.scan(), []);
  const disconnect = useCallback(() => clientRef.current?.disconnect(), []);

  return { state, heartRate, rr, battery, hrv, scan, disconnect };
}
