import React, { useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, useWindowDimensions } from 'react-native';
import { useBleContext } from '../ble/BleContext';
import { zoneForHr, maxHr } from '../metrics/zones';
import { getProfile, NEUTRAL_AGE } from '../storage/settings';
import HRChart from '../components/HRChart';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, spacing, radii, zoneColors, zoneNames, restColor } from '../theme';

// Strip cells: a leading "Rest" band (below Z1) then Z1–Z5. Fixes the gap where a
// resting HR (below 50% max) lit nothing.
const CELLS = [
  { key: 'rest', label: 'Rest', short: 'REST', color: restColor },
  ...zoneNames.map((name, i) => ({ key: `z${i + 1}`, label: name, short: `Z${i + 1}`, color: zoneColors[i] })),
];

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export default function LiveScreen() {
  const { heartRate, battery, hrv, hrBuffer60, sessionStartUnix, calories, disconnect } = useBleContext();
  const [age, setAge] = useState(NEUTRAL_AGE);
  const [elapsed, setElapsed] = useState(0);
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();

  useEffect(() => { getProfile().then(p => setAge(p.age)).catch(() => {}); }, []);

  useEffect(() => {
    if (sessionStartUnix == null) { setElapsed(0); return; }
    const tick = () => setElapsed(Math.floor(Date.now() / 1000) - sessionStartUnix);
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [sessionStartUnix]);

  const mhr = maxHr(age);
  const zone = heartRate != null ? zoneForHr(heartRate, mhr) : null;
  // activeKey: 'rest' when HR present but below Z1, else zN.
  const activeKey = heartRate == null ? null : zone == null ? 'rest' : `z${zone}`;
  const chartWidth = width - 64;

  return (
    <View style={styles.container}>
      {battery != null && <Text style={[styles.battery, { top: insets.top + 4 }]}>{Math.round(battery)}%</Text>}

      <Text style={[styles.bpm, heartRate == null && styles.dim]}>{heartRate ?? '--'}</Text>
      <Text style={styles.unit}>BPM</Text>

      <View style={styles.zoneStrip}>
        {CELLS.map(({ key, short, color }) => {
          const active = activeKey === key;
          return (
            <View key={key} style={[styles.zoneCell, active && { backgroundColor: color + '22', borderColor: color }]}>
              <View style={[styles.zoneDot, { backgroundColor: active ? color : colors.surfaceAlt }]} />
              <Text style={[styles.zoneNum, { color: active ? color : colors.textGhost }]}>{short}</Text>
            </View>
          );
        })}
      </View>

      <View style={styles.hrvRow}>
        <Text style={styles.hrvLabel}>HRV</Text>
        <Text style={[styles.hrvValue, hrv == null && styles.dim]}>{hrv != null ? Math.round(hrv) : '--'}</Text>
        <Text style={styles.hrvUnit}>ms</Text>
      </View>

      {hrBuffer60.length > 2 && (
        <View style={[styles.sparklineBox, { width: chartWidth }]}>
          <HRChart data={hrBuffer60} width={chartWidth} height={40} />
        </View>
      )}

      {(sessionStartUnix != null || calories > 0) && (
        <View style={styles.statsRow}>
          {sessionStartUnix != null && (
            <View style={styles.statItem}>
              <Text style={styles.statValue}>{formatDuration(elapsed)}</Text>
              <Text style={styles.statLabel}>SESSION</Text>
            </View>
          )}
          {calories > 0 && (
            <View style={styles.statItem}>
              <Text style={styles.statValue}>{Math.round(calories)}</Text>
              <Text style={styles.statLabel}>KCAL</Text>
            </View>
          )}
        </View>
      )}

      <TouchableOpacity style={styles.button} onPress={() => disconnect()}>
        <Text style={styles.buttonText}>Disconnect</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center' },
  battery: { position: 'absolute', top: 60, right: 24, fontSize: 16, color: colors.textDim },
  bpm: { fontSize: 110, fontWeight: '700', color: colors.text, lineHeight: 120 },
  dim: { color: colors.textGhost },
  unit: { fontSize: 22, color: colors.textDim, marginTop: 2 },
  zoneStrip: { flexDirection: 'row', marginTop: 20, gap: 5, paddingHorizontal: spacing.lg },
  zoneCell: {
    flex: 1, alignItems: 'center', paddingVertical: 9, borderRadius: radii.sm,
    borderWidth: 1, borderColor: colors.borderFaint, backgroundColor: colors.surface, gap: 5,
  },
  zoneDot: { width: 6, height: 6, borderRadius: 3 },
  zoneNum: { fontSize: 10, fontWeight: '700', letterSpacing: 0.3 },
  hrvRow: { flexDirection: 'row', alignItems: 'baseline', marginTop: spacing.xxl, gap: 8 },
  hrvLabel: { fontSize: 14, color: colors.textDim, letterSpacing: 1 },
  hrvValue: { fontSize: 38, fontWeight: '600', color: colors.text },
  hrvUnit: { fontSize: 14, color: colors.textDim },
  sparklineBox: { marginTop: 18, height: 40 },
  statsRow: { flexDirection: 'row', gap: 48, marginTop: spacing.xxl },
  statItem: { alignItems: 'center', gap: 4 },
  statValue: { fontSize: 20, fontWeight: '600', color: colors.text },
  statLabel: { fontSize: 10, color: colors.textFaint, letterSpacing: 1.5 },
  button: { marginTop: 40, borderWidth: 1, borderColor: colors.border, paddingHorizontal: 32, paddingVertical: 14, borderRadius: radii.md },
  buttonText: { fontSize: 16, color: colors.textDim },
});
