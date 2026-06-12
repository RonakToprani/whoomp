import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
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
  /** Optional value color (e.g. recovery band). */
  accent?: string;
}

export default function MetricCard({ label, value, unit, z, goodWhen = 'higher', sub, accent }: Props) {
  let caption: React.ReactNode = null;
  if (z != null && Number.isFinite(z)) {
    const small = Math.abs(z) < 0.5;
    const good = goodWhen === 'lower' ? z < 0 : z > 0;
    const color = small ? colors.textDim : good ? colors.green : colors.red;
    const text = small ? '• typical' : `${z >= 0 ? '↑' : '↓'} ${Math.abs(z).toFixed(1)}σ ${z >= 0 ? 'above base' : 'below base'}`;
    caption = <Text style={[styles.caption, { color }]}>{text}</Text>;
  } else if (sub) {
    caption = <Text style={styles.captionDim}>{sub}</Text>;
  }

  return (
    <View style={styles.card}>
      <Text style={styles.label}>{label}</Text>
      <View style={styles.row}>
        <Text style={[styles.value, accent ? { color: accent } : null]}>{value ?? '--'}</Text>
        {unit ? <Text style={styles.unit}>{unit}</Text> : null}
      </View>
      {caption}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { flex: 1, backgroundColor: colors.surface, borderRadius: radii.lg, padding: spacing.lg, margin: 6 },
  label: { fontSize: 11, color: colors.textFaint, letterSpacing: 1.5, marginBottom: spacing.sm },
  row: { flexDirection: 'row', alignItems: 'baseline', gap: 4 },
  value: { fontSize: 28, fontWeight: '600', color: colors.text },
  unit: { fontSize: 13, color: colors.textFaint },
  caption: { fontSize: 11, marginTop: 6, fontWeight: '500' },
  captionDim: { fontSize: 11, marginTop: 6, color: colors.textFaint },
});
