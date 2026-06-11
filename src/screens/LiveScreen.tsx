import React, { useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, useWindowDimensions } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useBleContext } from '../ble/BleContext';
import { zoneForHr, maxHr } from '../metrics/zones';
import HRChart from '../components/HRChart';

const AGE_KEY = '@whoomp/age';

const ZONES = [
  { z: 1, name: 'Recovery',  color: '#60a5fa' },
  { z: 2, name: 'Aerobic',   color: '#34d399' },
  { z: 3, name: 'Tempo',     color: '#fbbf24' },
  { z: 4, name: 'Threshold', color: '#f97316' },
  { z: 5, name: 'Max',       color: '#ef4444' },
];

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export default function LiveScreen() {
  const { heartRate, battery, hrv, hrBuffer60, sessionStartUnix, calories, disconnect } = useBleContext();
  const [age, setAge] = useState(30);
  const [elapsed, setElapsed] = useState(0);
  const { width } = useWindowDimensions();

  useEffect(() => {
    AsyncStorage.getItem(AGE_KEY).then(v => {
      const n = v ? parseInt(v, 10) : NaN;
      if (Number.isFinite(n) && n > 0) setAge(n);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (sessionStartUnix == null) { setElapsed(0); return; }
    const tick = () => setElapsed(Math.floor(Date.now() / 1000) - sessionStartUnix);
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [sessionStartUnix]);

  const mhr = maxHr(age);
  const zone = heartRate != null ? zoneForHr(heartRate, mhr) : null;
  const activeZone = zone != null ? ZONES[zone - 1] : null;
  // sparkline: content 32px padding, no box margin/padding in LiveScreen
  const chartWidth = width - 64;

  return (
    <View style={styles.container}>
      {battery != null && (
        <Text style={styles.battery}>{Math.round(battery)}%</Text>
      )}

      <Text style={[styles.bpm, heartRate == null && styles.dim]}>
        {heartRate ?? '--'}
      </Text>
      <Text style={styles.unit}>BPM</Text>

      {/* Zone strip */}
      <View style={styles.zoneStrip}>
        {ZONES.map(({ z, name, color }) => {
          const active = zone === z;
          return (
            <View key={z} style={[styles.zoneCell, active && { backgroundColor: color + '22', borderColor: color }]}>
              <View style={[styles.zoneDot, { backgroundColor: active ? color : '#2a2a2a' }]} />
              <Text style={[styles.zoneNum, { color: active ? color : '#444' }]}>Z{z}</Text>
              <Text style={[styles.zoneName, { color: active ? color : '#333' }]}>{name}</Text>
            </View>
          );
        })}
      </View>

      <View style={styles.hrvRow}>
        <Text style={styles.hrvLabel}>HRV</Text>
        <Text style={[styles.hrvValue, hrv == null && styles.dim]}>
          {hrv != null ? Math.round(hrv) : '--'}
        </Text>
        <Text style={styles.hrvUnit}>ms</Text>
      </View>

      {hrBuffer60.length > 2 && (
        <View style={[styles.sparklineBox, { width: chartWidth }]}>
          <HRChart data={hrBuffer60} width={chartWidth} height={40} />
        </View>
      )}

      {(sessionStartUnix != null || calories > 0) && (
        <View style={styles.statsRow}>
          {sessionStartUnix != null && (
            <View style={styles.statItem}>
              <Text style={styles.statValue}>{formatDuration(elapsed)}</Text>
              <Text style={styles.statLabel}>SESSION</Text>
            </View>
          )}
          {calories > 0 && (
            <View style={styles.statItem}>
              <Text style={styles.statValue}>{Math.round(calories)}</Text>
              <Text style={styles.statLabel}>KCAL</Text>
            </View>
          )}
        </View>
      )}

      <TouchableOpacity style={styles.button} onPress={() => disconnect()}>
        <Text style={styles.buttonText}>Disconnect</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1, backgroundColor: '#000', alignItems: 'center', justifyContent: 'center',
  },
  battery: {
    position: 'absolute', top: 60, right: 24, fontSize: 16, color: '#888',
  },
  bpm: { fontSize: 110, fontWeight: '700', color: '#fff', lineHeight: 120 },
  dim: { color: '#444' },
  unit: { fontSize: 22, color: '#888', marginTop: 2 },
  zoneStrip: {
    flexDirection: 'row', marginTop: 20, gap: 6, paddingHorizontal: 16,
  },
  zoneCell: {
    flex: 1, alignItems: 'center', paddingVertical: 10, borderRadius: 10,
    borderWidth: 1, borderColor: '#1a1a1a', backgroundColor: '#0d0d0d', gap: 4,
  },
  zoneDot: { width: 6, height: 6, borderRadius: 3 },
  zoneNum: { fontSize: 11, fontWeight: '700', letterSpacing: 0.5 },
  zoneName: { fontSize: 9, letterSpacing: 0.3 },
  hrvRow: { flexDirection: 'row', alignItems: 'baseline', marginTop: 28, gap: 8 },
  hrvLabel: { fontSize: 14, color: '#666', letterSpacing: 1 },
  hrvValue: { fontSize: 38, fontWeight: '600', color: '#fff' },
  hrvUnit: { fontSize: 14, color: '#666' },
  sparklineBox: { marginTop: 18, height: 40 },
  statsRow: { flexDirection: 'row', gap: 48, marginTop: 28 },
  statItem: { alignItems: 'center', gap: 4 },
  statValue: { fontSize: 20, fontWeight: '600', color: '#fff' },
  statLabel: { fontSize: 10, color: '#555', letterSpacing: 1.5 },
  button: {
    marginTop: 40, borderWidth: 1, borderColor: '#444',
    paddingHorizontal: 32, paddingVertical: 14, borderRadius: 12,
  },
  buttonText: { fontSize: 16, color: '#888' },
});
