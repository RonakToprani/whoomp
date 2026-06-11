import React, { useEffect, useState } from 'react';
import { View, Text, ScrollView, StyleSheet, useWindowDimensions } from 'react-native';
import HRChart from '../components/HRChart';
import { getDailyHistory, DailyRow } from '../storage/db';

function TrendSection({ label, data, unit, color }: { label: string; data: (number | null)[]; unit: string; color: string }) {
  const { width } = useWindowDimensions();
  const chartWidth = width - 48;
  const valid = data.filter((v): v is number => v != null);
  const latest = valid[0] ?? null;

  return (
    <View style={styles.section}>
      <View style={styles.sectionHeader}>
        <Text style={styles.sectionLabel}>{label}</Text>
        <Text style={styles.sectionValue}>
          {latest != null ? `${Math.round(latest * 10) / 10} ${unit}` : '--'}
        </Text>
      </View>
      <HRChart data={[...data].reverse()} width={chartWidth} height={64} color={color} />
      <View style={styles.axisRow}>
        <Text style={styles.axisLabel}>14d ago</Text>
        <Text style={styles.axisLabel}>Today</Text>
      </View>
    </View>
  );
}

export default function TrendsScreen() {
  const [rows, setRows] = useState<DailyRow[]>([]);

  useEffect(() => {
    getDailyHistory(14).then(setRows).catch(() => {});
  }, []);

  const rmssdSeries = rows.map(r => r.rmssd);
  const rhrSeries = rows.map(r => r.rhr);
  const strainSeries = rows.map(r => r.strain);

  if (rows.length === 0) {
    return (
      <View style={styles.empty}>
        <Text style={styles.emptyText}>No history yet</Text>
        <Text style={styles.emptySubtext}>Trends appear after your first connected session</Text>
      </View>
    );
  }

  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Trends</Text>
      <TrendSection label="HRV (RMSSD)" data={rmssdSeries} unit="ms" color="#4ade80" />
      <TrendSection label="RESTING HR" data={rhrSeries} unit="bpm" color="#f87171" />
      <TrendSection label="STRAIN" data={strainSeries} unit="" color="#60a5fa" />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { flex: 1, backgroundColor: '#000' },
  content: { padding: 16, paddingBottom: 40 },
  title: { fontSize: 28, fontWeight: '700', color: '#fff', marginBottom: 24 },
  section: {
    backgroundColor: '#111',
    borderRadius: 14,
    padding: 16,
    marginBottom: 12,
  },
  sectionHeader: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 12 },
  sectionLabel: { fontSize: 11, color: '#555', letterSpacing: 1.5 },
  sectionValue: { fontSize: 16, fontWeight: '600', color: '#fff' },
  axisRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 6 },
  axisLabel: { fontSize: 10, color: '#444' },
  empty: { flex: 1, backgroundColor: '#000', alignItems: 'center', justifyContent: 'center' },
  emptyText: { fontSize: 18, color: '#555', fontWeight: '600' },
  emptySubtext: { fontSize: 13, color: '#333', marginTop: 8, textAlign: 'center', paddingHorizontal: 32 },
});
