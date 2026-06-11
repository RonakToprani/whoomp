import React from 'react';
import { View, Text, StyleSheet } from 'react-native';

interface Props {
  label: string;
  value: string | number | null;
  unit?: string;
  trend?: number | null; // positive = better, negative = worse
}

export default function MetricCard({ label, value, unit, trend }: Props) {
  const trendSymbol = trend == null ? null : trend > 0 ? '↑' : trend < 0 ? '↓' : null;
  const trendColor = trend == null ? '#555' : trend > 0 ? '#4ade80' : '#f87171';

  return (
    <View style={styles.card}>
      <Text style={styles.label}>{label}</Text>
      <View style={styles.row}>
        <Text style={styles.value}>{value ?? '--'}</Text>
        {unit ? <Text style={styles.unit}>{unit}</Text> : null}
        {trendSymbol ? <Text style={[styles.trend, { color: trendColor }]}>{trendSymbol}</Text> : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    flex: 1,
    backgroundColor: '#111',
    borderRadius: 14,
    padding: 16,
    margin: 6,
  },
  label: { fontSize: 11, color: '#555', letterSpacing: 1.5, marginBottom: 8 },
  row: { flexDirection: 'row', alignItems: 'baseline', gap: 4 },
  value: { fontSize: 28, fontWeight: '600', color: '#fff' },
  unit: { fontSize: 13, color: '#555' },
  trend: { fontSize: 16, marginLeft: 4 },
});
