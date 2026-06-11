import React, { useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, useWindowDimensions } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useBleContext } from '../ble/BleContext';
import { zoneForHr, maxHr } from '../metrics/zones';
import HRChart from '../components/HRChart';

const AGE_KEY = '@whoomp/age';

const ZONE_META: Record<number, { label: string; color: string }> = {
  1: { label: 'Z1', color: '#60a5fa' },
  2: { label: 'Z2', color: '#34d399' },
  3: { label: 'Z3', color: '#fbbf24' },
  4: { label: 'Z4', color: '#f97316' },
  5: { label: 'Z5', color: '#ef4444' },
};

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

  const zone = heartRate != null ? zoneForHr(heartRate, maxHr(age)) : null;
  const zoneMeta = zone != null ? ZONE_META[zone] : null;
  const chartWidth = width - 64;

  return (
    <View style={styles.container}>
      {battery != null && (
        <Text style={styles.battery}>{Math.round(battery)}%</Text>
      )}

      {zoneMeta && (
        <View style={[styles.zoneBadge, { borderColor: zoneMeta.color }]}>
          <Text style={[styles.zoneText, { color: zoneMeta.color }]}>{zoneMeta.label}</Text>
        </View>
      )}

      <Text style={[styles.bpm, heartRate == null && styles.dim]}>
        {heartRate ?? '--'}
      </Text>
      <Text style={styles.unit}>BPM</Text>

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
  zoneBadge: {
    position: 'absolute', top: 60, left: 24,
    borderWidth: 1, borderRadius: 8,
    paddingHorizontal: 10, paddingVertical: 4,
  },
  zoneText: { fontSize: 13, fontWeight: '700', letterSpacing: 1 },
  bpm: { fontSize: 120, fontWeight: '700', color: '#fff', lineHeight: 130 },
  dim: { color: '#444' },
  unit: { fontSize: 24, color: '#888', marginTop: 4 },
  hrvRow: { flexDirection: 'row', alignItems: 'baseline', marginTop: 32, gap: 8 },
  hrvLabel: { fontSize: 14, color: '#666', letterSpacing: 1 },
  hrvValue: { fontSize: 40, fontWeight: '600', color: '#fff' },
  hrvUnit: { fontSize: 14, color: '#666' },
  sparklineBox: { marginTop: 20, height: 40 },
  statsRow: { flexDirection: 'row', gap: 48, marginTop: 32 },
  statItem: { alignItems: 'center', gap: 4 },
  statValue: { fontSize: 22, fontWeight: '600', color: '#fff' },
  statLabel: { fontSize: 10, color: '#555', letterSpacing: 1.5 },
  button: {
    marginTop: 48, borderWidth: 1, borderColor: '#444',
    paddingHorizontal: 32, paddingVertical: 14, borderRadius: 12,
  },
  buttonText: { fontSize: 16, color: '#888' },
});
