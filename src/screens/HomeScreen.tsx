import React, { useEffect, useState, useCallback } from 'react';
import { View, Text, ScrollView, StyleSheet, useWindowDimensions, AppState } from 'react-native';
import RecoveryRing from '../components/RecoveryRing';
import MetricCard from '../components/MetricCard';
import HRChart from '../components/HRChart';
import { useBleContext } from '../ble/BleContext';
import { getDailyHistory, DailyRow } from '../storage/db';

export default function HomeScreen() {
  const { heartRate, hrv, rr, state } = useBleContext();
  const [today, setToday] = useState<DailyRow | null>(null);
  const { width } = useWindowDimensions();

  const refresh = useCallback(() => {
    getDailyHistory(1).then(rows => setToday(rows[0] ?? null)).catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
    // Re-read daily table when app comes to foreground (rollup may have run in BLE hook)
    const sub = AppState.addEventListener('change', s => { if (s === 'active') refresh(); });
    return () => sub.remove();
  }, [refresh]);

  // Also refresh whenever BLE state changes (reconnect → historyComplete → rollup)
  useEffect(() => { refresh(); }, [state, refresh]);

  // Live HRV wins over the stored daily value while connected (more current)
  const displayHrv = hrv ?? today?.rmssd ?? null;
  const recovery = today?.recovery ?? null;
  const strain = today?.strain ?? null;
  const rhr = today?.rhr ?? null;

  const liveHrSlice = rr.slice(-300).map(rrMs => (rrMs > 0 ? Math.round(60000 / rrMs) : null));
  const chartWidth = width - 48;

  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Today</Text>

      <View style={styles.ringRow}>
        <RecoveryRing score={recovery} size={180} />
      </View>

      <View style={styles.row}>
        <MetricCard label="HRV" value={displayHrv != null ? Math.round(displayHrv) : null} unit="ms" />
        <MetricCard label="HEART RATE" value={heartRate} unit="bpm" />
      </View>

      <View style={styles.row}>
        <MetricCard label="RESTING HR" value={rhr != null ? Math.round(rhr) : null} unit="bpm" />
        <MetricCard label="STRAIN" value={strain != null ? (Math.round(strain * 10) / 10) : null} unit="/ 21" />
      </View>

      {liveHrSlice.length > 2 && (
        <View style={styles.chartContainer}>
          <Text style={styles.chartLabel}>5-MIN HR</Text>
          <HRChart data={liveHrSlice} width={chartWidth} height={56} />
        </View>
      )}

      {state !== 'connected' && (
        <Text style={styles.offline}>Not connected — showing last recorded session</Text>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { flex: 1, backgroundColor: '#000' },
  content: { padding: 16, paddingBottom: 40 },
  title: { fontSize: 28, fontWeight: '700', color: '#fff', marginBottom: 24 },
  ringRow: { alignItems: 'center', marginBottom: 24 },
  row: { flexDirection: 'row', marginBottom: 8 },
  chartContainer: {
    backgroundColor: '#111', borderRadius: 14, padding: 16, margin: 6, marginTop: 8,
  },
  chartLabel: { fontSize: 11, color: '#555', letterSpacing: 1.5, marginBottom: 10 },
  offline: { textAlign: 'center', color: '#444', fontSize: 13, marginTop: 24 },
});
