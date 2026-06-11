import { useState, useEffect, useRef } from 'react';
import { WhoopClient, ClientState } from './WhoopClient';

export function useBLE() {
  const clientRef = useRef<WhoopClient | null>(null);
  const [state, setState] = useState<ClientState>('disconnected');
  const [heartRate, setHeartRate] = useState<number | null>(null);
  const [rr, setRr] = useState<number[]>([]);
  const [battery, setBattery] = useState<number | null>(null);

  useEffect(() => {
    const client = new WhoopClient();
    clientRef.current = client;
    const off = [
      client.on<ClientState>('state', setState),
      client.on<{ heartRateBpm: number | null; rrIntervalsMs: number[] }>(
        'realtime',
        ({ heartRateBpm, rrIntervalsMs }) => {
          setHeartRate(heartRateBpm);
          setRr(prev => [...prev.slice(-300), ...rrIntervalsMs]);
        }
      ),
      client.on<number>('battery', setBattery),
    ];
    return () => { off.forEach(fn => fn()); client.destroy(); };
  }, []);

  return {
    state,
    heartRate,
    rr,
    battery,
    scan:       () => clientRef.current?.scan(),
    disconnect: () => clientRef.current?.disconnect(),
  };
}
