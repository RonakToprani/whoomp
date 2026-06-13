import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { colors, radii, withAlpha } from '../theme';

export interface StageRow { key: string; label: string; min: number; color: string; }
interface Props { rows: StageRow[]; }

function fmt(min: number): string {
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return h > 0 ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`;
}

// WHOOP-style horizontal stage breakdown: a labeled, colored bar per stage with its share (%) and
// duration. Bar widths are relative to the total of all rows, so they sum to the full track.
export default function StageBars({ rows }: Props) {
  const total = rows.reduce((a, r) => a + Math.max(0, r.min), 0);
  return (
    <View style={styles.wrap}>
      {rows.map(r => {
        const pct = total > 0 ? r.min / total : 0;
        return (
          <View key={r.key} style={styles.row}>
            <View style={styles.head}>
              <View style={[styles.dot, { backgroundColor: r.color }]} />
              <Text style={styles.label}>{r.label}</Text>
              <Text style={[styles.pct, { color: r.color }]}>{Math.round(pct * 100)}%</Text>
            </View>
            <View style={styles.track}>
              <View style={[styles.fill, { width: `${Math.max(1.5, pct * 100)}%`, backgroundColor: r.color }]} />
            </View>
            <Text style={styles.dur}>{fmt(r.min)}</Text>
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 14 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  head: { width: 96, flexDirection: 'row', alignItems: 'center', gap: 6 },
  dot: { width: 9, height: 9, borderRadius: 5 },
  label: { color: colors.text, fontSize: 13, fontWeight: '600' },
  pct: { fontSize: 11, fontWeight: '600' },
  track: { flex: 1, height: 8, borderRadius: radii.pill, backgroundColor: colors.surfaceAlt, overflow: 'hidden' },
  fill: { height: 8, borderRadius: radii.pill },
  dur: { width: 58, textAlign: 'right', color: colors.textDim, fontSize: 12, fontVariant: ['tabular-nums'] },
});
