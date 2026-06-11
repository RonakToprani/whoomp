import React, { useEffect, useState } from 'react';
import { View, Text, ScrollView, StyleSheet, useWindowDimensions } from 'react-native';
import Svg, { Polyline, Line } from 'react-native-svg';
import { getDailyHistory, DailyRow } from '../storage/db';

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function dayLabel(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  return DAY_LABELS[new Date(y, m - 1, d).getDay()];
}

function TrendChart({
  data,
  width,
  height,
  color,
}: {
  data: (number | null)[];
  width: number;
  height: number;
  color: string;
}) {
  const valid = data.filter((v): v is number => v != null);
  if (valid.length < 2) {
    return (
      <View style={{ width, height, alignItems: 'center', justifyContent: 'center' }}>
        <Text style={{ color: '#333', fontSize: 12 }}>not enough data</Text>
      </View>
    );
  }
  const min = Math.min(...valid) * 0.95;
  const max = Math.max(...valid) * 1.05;
  const range = Math.max(max - min, 1);
  const step = width / Math.max(data.length - 1, 1);
  const avg = valid.reduce((a, b) => a + b, 0) / valid.length;
  const avgY = height - ((avg - min) / range) * height;

  const points = data
    .map((v, i) => {
      if (v == null) return null;
      return `${(i * step).toFixed(1)},${(height - ((v - min) / range) * height).toFixed(1)}`;
    })
    .filter(Boolean)
    .join(' ');

  return (
    <Svg width={width} height={height}>
      {/* Average reference line */}
      <Line
        x1={0} y1={avgY} x2={width} y2={avgY}
        stroke="#2a2a2a" strokeWidth={1} strokeDasharray="4 4"
      />
      <Polyline points={points} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" />
    </Svg>
  );
}

function TrendSection({
  label, rows, getValue, unit, color,
}: {
  label: string;
  rows: DailyRow[];
  getValue: (r: DailyRow) => number | null;
  unit: string;
  color: string;
}) {
  const { width } = useWindowDimensions();
  const chartWidth = width - 48;
  // rows are newest-first; reverse for chart (left=oldest, right=today)
  const ordered = [...rows].reverse();
  const data = ordered.map(getValue);
  const valid = data.filter((v): v is number => v != null);
  const latest = valid[valid.length - 1] ?? null;
  const avg = valid.length > 0 ? valid.reduce((a, b) => a + b, 0) / valid.length : null;

  // Day labels: show every other to avoid crowding
  const tickRows = ordered.filter((_, i) => i % 2 === 0);

  return (
    <View style={styles.section}>
      <View style={styles.sectionHeader}>
        <Text style={styles.sectionLabel}>{label}</Text>
        <View style={styles.sectionValues}>
          {avg != null && (
            <Text style={styles.avgText}>avg {Math.round(avg * 10) / 10}</Text>
          )}
          <Text style={styles.sectionValue}>
            {latest != null ? `${Math.round(latest * 10) / 10} ${unit}` : '--'}
          </Text>
        </View>
      </View>
      <TrendChart data={data} width={chartWidth} height={72} color={color} />
      {tickRows.length > 0 && (
        <View style={[styles.axisRow, { width: chartWidth }]}>
          {tickRows.map((r, i) => (
            <Text key={r.date} style={styles.axisLabel}>{dayLabel(r.date)}</Text>
          ))}
        </View>
      )}
    </View>
  );
}

export default function TrendsScreen() {
  const [rows, setRows] = useState<DailyRow[]>([]);

  useEffect(() => {
    getDailyHistory(14).then(setRows).catch(() => {});
  }, []);

  if (rows.length === 0) {
    return (
      <View style={styles.empty}>
        <Text style={styles.emptyTitle}>No history yet</Text>
        <Text style={styles.emptyText}>Trends appear after your first connected session</Text>
      </View>
    );
  }

  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Trends</Text>
      <TrendSection label="HRV (RMSSD)" rows={rows} getValue={r => r.rmssd} unit="ms" color="#4ade80" />
      <TrendSection label="RESTING HR" rows={rows} getValue={r => r.rhr} unit="bpm" color="#f87171" />
      <TrendSection label="STRAIN" rows={rows} getValue={r => r.strain} unit="" color="#60a5fa" />
      <TrendSection label="RECOVERY" rows={rows} getValue={r => r.recovery} unit="%" color="#a78bfa" />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { flex: 1, backgroundColor: '#000' },
  content: { padding: 16, paddingBottom: 40 },
  title: { fontSize: 28, fontWeight: '700', color: '#fff', marginBottom: 24 },
  section: { backgroundColor: '#111', borderRadius: 14, padding: 16, marginBottom: 12 },
  sectionHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 },
  sectionLabel: { fontSize: 11, color: '#555', letterSpacing: 1.5 },
  sectionValues: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  avgText: { fontSize: 12, color: '#444' },
  sectionValue: { fontSize: 16, fontWeight: '600', color: '#fff' },
  axisRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 8 },
  axisLabel: { fontSize: 10, color: '#444' },
  empty: { flex: 1, backgroundColor: '#000', alignItems: 'center', justifyContent: 'center', padding: 32 },
  emptyTitle: { fontSize: 18, color: '#555', fontWeight: '600' },
  emptyText: { fontSize: 13, color: '#333', marginTop: 8, textAlign: 'center' },
});
