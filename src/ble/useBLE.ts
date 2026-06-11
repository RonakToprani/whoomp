import { useState, useEffect, useRef, useCallback } from 'react';
import { WhoopClient, ClientState } from './WhoopClient';
import { insertSample } from '../storage/db';
import { rmssd, filterRr } from '../metrics/hrv';

const RR_WINDOW = 300;

export function useBLE() {
  const clientRef = useRef<WhoopClient | null>(null);
  const [state, setState] = useState<ClientState>('disconnected');
  const [heartRate, setHeartRate] = useState<number | null>(null);
  const [rr, setRr] = useState<number[]>([]);
  const [battery, setBattery] = useState<number | null>(null);
  const [hrv, setHrv] = useState<number | null>(null);

  useEffect(() => {
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
      client.on<number>('battery', setBattery),
    ];
    return () => { off.forEach(fn => fn()); client.destroy(); };
  }, []);

  const scan = useCallback(() => clientRef.current?.scan(), []);
  const disconnect = useCallback(() => clientRef.current?.disconnect(), []);

  return { state, heartRate, rr, battery, hrv, scan, disconnect };
}
