import React, { useEffect, useState } from 'react';
import { View, Text, ScrollView, StyleSheet } from 'react-native';
import RecoveryRing from '../components/RecoveryRing';
import MetricCard from '../components/MetricCard';
import HRChart from '../components/HRChart';
import { useBleContext } from '../ble/BleContext';
import { getDailyHistory } from '../storage/db';
import { recoveryScore } from '../metrics/recovery';

export default function HomeScreen() {
  const { heartRate, hrv, rr, state } = useBleContext();
  const [todayRmssd, setTodayRmssd] = useState<number | null>(null);
  const [recoveryHistory, setRecoveryHistory] = useState<(number | null)[]>([]);
  const [recovery, setRecovery] = useState<number | null>(null);

  useEffect(() => {
    getDailyHistory(14).then(rows => {
      const rmssdHistory = rows.map(r => r.rmssd);
      setRecoveryHistory(rmssdHistory);
      if (hrv != null) {
        setTodayRmssd(hrv);
        setRecovery(recoveryScore(hrv, rmssdHistory));
      }
    }).catch(() => {});
  }, [hrv]);

  const liveHrSlice = rr.slice(-300).map((_, i, arr) => {
    // convert last 300 RR intervals to a per-sample HR series
    const rrMs = arr[i];
    return rrMs > 0 ? Math.round(60000 / rrMs) : null;
  });

  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Today</Text>

      <View style={styles.ringRow}>
        <RecoveryRing score={recovery} size={180} />
      </View>

      <View style={styles.row}>
        <MetricCard label="HRV" value={hrv != null ? Math.round(hrv) : null} unit="ms" />
        <MetricCard label="HEART RATE" value={heartRate} unit="bpm" />
      </View>

      {liveHrSlice.length > 2 && (
        <View style={styles.chartContainer}>
          <Text style={styles.chartLabel}>5-MIN HR</Text>
          <HRChart data={liveHrSlice} width={340} height={56} />
        </View>
      )}

      {state !== 'connected' && (
        <Text style={styles.offline}>Not connected — recovery based on last session</Text>
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
    backgroundColor: '#111',
    borderRadius: 14,
    padding: 16,
    margin: 6,
    marginTop: 8,
  },
  chartLabel: { fontSize: 11, color: '#555', letterSpacing: 1.5, marginBottom: 10 },
  offline: { textAlign: 'center', color: '#444', fontSize: 13, marginTop: 24 },
});
