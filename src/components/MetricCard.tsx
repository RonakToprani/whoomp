import React, { useState } from 'react';
import { View, Text, StyleSheet, LayoutChangeEvent } from 'react-native';
import Sparkline from './Sparkline';
import { colors, radii, spacing } from '../theme';

interface Props {
  label: string;
  value: string | number | null;
  unit?: string;
  /** Robust z vs personal baseline (positive = above baseline); renders an ↑/↓ caption. */
  z?: number | null;
  /** Which direction is physiologically good — drives the caption color. */
  goodWhen?: 'higher' | 'lower';
  /** Free-text caption shown when no z is given. */
  sub?: string;
  /** Explicit value color override (e.g. recovery band). Falls back to `color`. */
  accent?: string;
  /** Metric hue — colors the value and the sparkline. */
  color?: string;
  /** Up-to-14-point series for the in-card trend line. */
  trend?: (number | null)[];
}

export default function MetricCard({ label, value, unit, z, goodWhen = 'higher', sub, accent, color, trend }: Props) {
  const [w, setW] = useState(0);
  const valueColor = value == null ? colors.textGhost : (accent ?? color ?? colors.text);

  let caption: React.ReactNode = null;
  if (z != null && Number.isFinite(z)) {
    const az = Math.abs(z);
    const small = az < 0.5;
    const good = goodWhen === 'lower' ? z < 0 : z > 0;
    const capColor = small ? colors.textDim : good ? colors.green : colors.red;
    const arrow = z >= 0 ? '↑' : '↓';
    const where = z >= 0 ? 'above base' : 'below base';
    const text = small ? '• typical' : az >= 3 ? `${arrow} well ${where}` : `${arrow} ${az.toFixed(1)}σ ${where}`;
    caption = <Text style={[styles.caption, { color: capColor }]}>{text}</Text>;
  } else if (sub) {
    caption = <Text style={styles.captionDim}>{sub}</Text>;
  }

  const sparkWidth = w - spacing.lg * 2;
  const showSpark = !!trend && trend.filter(v => v != null).length >= 2 && sparkWidth > 24;

  return (
    <View style={styles.card} onLayout={(e: LayoutChangeEvent) => setW(e.nativeEvent.layout.width)}>
      <Text style={styles.label}>{label}</Text>
      <View style={styles.row}>
        <Text style={[styles.value, { color: valueColor }]}>{value ?? '--'}</Text>
        {unit ? <Text style={styles.unit}>{unit}</Text> : null}
      </View>
      {caption}
      {showSpark && (
        <View style={styles.spark}>
          <Sparkline data={trend!} width={sparkWidth} height={28} color={color ?? valueColor} />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { flex: 1, backgroundColor: colors.surface, borderRadius: radii.lg, padding: spacing.lg, margin: 6 },
  label: { fontSize: 11, color: colors.textFaint, letterSpacing: 1.5, marginBottom: spacing.sm },
  row: { flexDirection: 'row', alignItems: 'baseline', gap: 4 },
  value: { fontSize: 26, fontWeight: '700' },
  unit: { fontSize: 13, color: colors.textFaint },
  caption: { fontSize: 11, marginTop: 6, fontWeight: '500' },
  captionDim: { fontSize: 11, marginTop: 6, color: colors.textFaint },
  spark: { marginTop: 10, alignItems: 'flex-start' },
});
