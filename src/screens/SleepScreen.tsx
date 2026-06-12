import React, { useEffect, useState } from 'react';
import { View, Text, ScrollView, StyleSheet, useWindowDimensions } from 'react-native';
import { getDailyHistory, rollupAllDays, DailyRow } from '../storage/db';

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

const STAGE_ORDER = ['deep', 'rem', 'light', 'wake'] as const;
type StageKey = typeof STAGE_ORDER[number];

function localDateStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function dateHeadline(dateStr: string): string {
  if (dateStr === localDateStr(new Date())) return 'Today';
  if (dateStr === localDateStr(new Date(Date.now() - 86400_000))) return 'Yesterday';
  return dateStr.slice(5);
}

function fmt(min: number): string {
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function stageMin(row: DailyRow, s: StageKey): number | null {
  return s === 'deep' ? row.deep_min : s === 'rem' ? row.rem_min : s === 'light' ? row.light_min : row.awake_min;
}

function LegendDot({ stage }: { stage: string }) {
  return (
    <View style={styles.legendItem}>
      <View style={[styles.dot, { backgroundColor: STAGE_COLORS[stage] }]} />
      <Text style={styles.legendLabel}>{STAGE_LABELS[stage]}</Text>
    </View>
  );
}

function SleepNight({ row }: { row: DailyRow }) {
  const { width } = useWindowDimensions();
  const barWidth = width - 64;
  const total = row.sleep_minutes ?? 0;
  if (total === 0) return null;

  const stageTotal = STAGE_ORDER.reduce((a, s) => a + (stageMin(row, s) ?? 0), 0);
  const hasStages = stageTotal > 0;

  return (
    <View style={styles.nightCard}>
      <View style={styles.nightHeader}>
        <Text style={styles.nightDate}>{dateHeadline(row.date)}</Text>
        <Text style={styles.nightTotal}>{fmt(total)} asleep</Text>
      </View>

      {hasStages ? (
        <View style={[styles.stageBar, { width: barWidth }]}>
          {STAGE_ORDER.map(s => {
            const m = stageMin(row, s) ?? 0;
            if (m <= 0) return null;
            return <View key={s} style={{ width: (m / stageTotal) * barWidth, backgroundColor: STAGE_COLORS[s] }} />;
          })}
        </View>
      ) : (
        <View style={[styles.stageBar, { width: barWidth }]}>
          <View style={{ width: Math.min(barWidth, (total / 600) * barWidth), backgroundColor: '#60a5fa' }} />
        </View>
      )}

      {hasStages && (
        <View style={styles.stageStats}>
          {STAGE_ORDER.map(s => {
            const m = stageMin(row, s);
            return (
              <View key={s} style={styles.stageStat}>
                <View style={[styles.dot, { backgroundColor: STAGE_COLORS[s] }]} />
                <Text style={styles.stageStatLabel}>{STAGE_LABELS[s]}</Text>
                <Text style={styles.stageStatVal}>{m != null ? fmt(m) : '--'}</Text>
              </View>
            );
          })}
        </View>
      )}
    </View>
  );
}

export default function SleepScreen() {
  const [rows, setRows] = useState<DailyRow[]>([]);

  useEffect(() => {
    (async () => {
      try {
        await rollupAllDays();
        const all = await getDailyHistory(14);
        setRows(all.filter(r => r.sleep_minutes != null && r.sleep_minutes > 0));
      } catch {}
    })();
  }, []);

  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Sleep</Text>

      <View style={styles.legend}>
        {STAGE_ORDER.map(s => <LegendDot key={s} stage={s} />)}
      </View>

      {rows.length === 0 ? (
        <View style={styles.emptyInner}>
          <Text style={styles.emptyText}>No sleep data yet</Text>
          <Text style={styles.emptySubtext}>Sleep tracking appears after an overnight session synced to the app</Text>
        </View>
      ) : (
        rows.map(row => <SleepNight key={row.date} row={row} />)
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { flex: 1, backgroundColor: '#000' },
  content: { padding: 16, paddingBottom: 40 },
  title: { fontSize: 28, fontWeight: '700', color: '#fff', marginBottom: 16 },
  legend: { flexDirection: 'row', gap: 16, marginBottom: 20 },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  legendLabel: { fontSize: 11, color: '#555', letterSpacing: 1 },
  nightCard: { backgroundColor: '#111', borderRadius: 14, padding: 16, marginBottom: 12 },
  nightHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 },
  nightDate: { fontSize: 15, color: '#fff', fontWeight: '600' },
  nightTotal: { fontSize: 14, color: '#888' },
  stageBar: { flexDirection: 'row', height: 22, borderRadius: 5, overflow: 'hidden', backgroundColor: '#1a1a1a' },
  stageStats: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 14 },
  stageStat: { alignItems: 'center', gap: 4, flex: 1 },
  stageStatLabel: { fontSize: 10, color: '#555', letterSpacing: 1 },
  stageStatVal: { fontSize: 13, color: '#ccc', fontWeight: '500' },
  emptyInner: { alignItems: 'center', marginTop: 60 },
  emptyText: { fontSize: 18, color: '#555', fontWeight: '600' },
  emptySubtext: { fontSize: 13, color: '#333', marginTop: 8, textAlign: 'center', paddingHorizontal: 32 },
});
