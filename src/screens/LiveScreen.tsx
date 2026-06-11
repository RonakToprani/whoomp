import React, { useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useBleContext } from '../ble/BleContext';
import { zoneForHr, maxHr } from '../metrics/zones';

const AGE_KEY = '@whoomp/age';

const ZONE_META: Record<number, { label: string; color: string }> = {
  1: { label: 'Z1', color: '#60a5fa' },
  2: { label: 'Z2', color: '#34d399' },
  3: { label: 'Z3', color: '#fbbf24' },
  4: { label: 'Z4', color: '#f97316' },
  5: { label: 'Z5', color: '#ef4444' },
};

export default function LiveScreen() {
  const { heartRate, battery, hrv, disconnect } = useBleContext();
  const [age, setAge] = useState(30);

  useEffect(() => {
    AsyncStorage.getItem(AGE_KEY).then(v => {
      const n = v ? parseInt(v, 10) : NaN;
      if (Number.isFinite(n) && n > 0) setAge(n);
    }).catch(() => {});
  }, []);

  const zone = heartRate != null ? zoneForHr(heartRate, maxHr(age)) : null;
  const zoneMeta = zone != null ? ZONE_META[zone] : null;

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
  button: {
    marginTop: 64, borderWidth: 1, borderColor: '#444',
    paddingHorizontal: 32, paddingVertical: 14, borderRadius: 12,
  },
  buttonText: { fontSize: 16, color: '#888' },
});
