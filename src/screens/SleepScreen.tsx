import React, { useEffect, useState } from 'react';
import { View, Text, ScrollView, StyleSheet, useWindowDimensions } from 'react-native';
import { getDailyHistory, DailyRow } from '../storage/db';

const STAGE_COLORS: Record<string, string> = {
  deep: '#6366f1',
  rem: '#4ade80',
  light: '#60a5fa',
  wake: '#f87171',
};

const STAGE_LABELS: Record<string, string> = {
  deep: 'DEEP',
  rem: 'REM',
  light: 'LIGHT',
  wake: 'WAKE',
};

function LegendDot({ stage }: { stage: string }) {
  return (
    <View style={styles.legendItem}>
      <View style={[styles.dot, { backgroundColor: STAGE_COLORS[stage] }]} />
      <Text style={styles.legendLabel}>{STAGE_LABELS[stage]}</Text>
    </View>
  );
}

function SleepBar({ row }: { row: DailyRow }) {
  const { width } = useWindowDimensions();
  const barWidth = width - 80;
  const total = row.sleep_minutes ?? 0;

  if (total === 0) return null;

  // With just sleep_minutes in daily table, show a single bar.
  // Full stage breakdown requires the samples table (Phase 3 extension).
  const hours = Math.floor(total / 60);
  const mins = total % 60;

  return (
    <View style={styles.sleepRow}>
      <Text style={styles.sleepDate}>{row.date.slice(5)}</Text>
      <View style={[styles.sleepBar, { width: Math.round((total / 600) * barWidth), backgroundColor: '#60a5fa' }]} />
      <Text style={styles.sleepDuration}>{hours}h {mins}m</Text>
    </View>
  );
}

export default function SleepScreen() {
  const [rows, setRows] = useState<DailyRow[]>([]);

  useEffect(() => {
    getDailyHistory(14).then(rows => setRows(rows.filter(r => r.sleep_minutes != null && r.sleep_minutes > 0))).catch(() => {});
  }, []);

  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Sleep</Text>

      <View style={styles.legend}>
        {['deep', 'rem', 'light', 'wake'].map(s => <LegendDot key={s} stage={s} />)}
      </View>

      {rows.length === 0 ? (
        <View style={styles.emptyInner}>
          <Text style={styles.emptyText}>No sleep data yet</Text>
          <Text style={styles.emptySubtext}>Sleep tracking appears after your first overnight session</Text>
        </View>
      ) : (
        rows.map(row => <SleepBar key={row.date} row={row} />)
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { flex: 1, backgroundColor: '#000' },
  content: { padding: 16, paddingBottom: 40 },
  title: { fontSize: 28, fontWeight: '700', color: '#fff', marginBottom: 16 },
  legend: { flexDirection: 'row', gap: 16, marginBottom: 24 },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  legendLabel: { fontSize: 11, color: '#555', letterSpacing: 1 },
  sleepRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 12, gap: 10 },
  sleepDate: { fontSize: 12, color: '#555', width: 36 },
  sleepBar: { height: 20, borderRadius: 4 },
  sleepDuration: { fontSize: 12, color: '#888', marginLeft: 8 },
  emptyInner: { alignItems: 'center', marginTop: 60 },
  emptyText: { fontSize: 18, color: '#555', fontWeight: '600' },
  emptySubtext: { fontSize: 13, color: '#333', marginTop: 8, textAlign: 'center', paddingHorizontal: 32 },
});
