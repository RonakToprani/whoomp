import React, { useEffect, useState } from 'react';
import { View, Text, ScrollView, StyleSheet, useWindowDimensions } from 'react-native';
import { getDailyHistory, rollupAllDays, DailyRow } from '../storage/db';
import Hypnogram from '../components/Hypnogram';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, spacing, radii, stageColors, stageLabels } from '../theme';

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

interface Seg { start: number; end: number; stage: string; }
function parseStages(json: string | null | undefined): Seg[] {
  if (!json) return [];
  try {
    const arr = JSON.parse(json);
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

function NightStat({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.nightStat}>
      <Text style={styles.nightStatVal}>{value}</Text>
      <Text style={styles.nightStatLabel}>{label}</Text>
    </View>
  );
}

function SleepNight({ row }: { row: DailyRow }) {
  const { width } = useWindowDimensions();
  const cardWidth = width - 64;
  const total = row.sleep_minutes ?? 0;
  if (total === 0) return null;

  const stages = parseStages(row.sleep_stages);
  const effPct = row.sleep_efficiency != null ? Math.round(row.sleep_efficiency * 100) : null;
  const stageTotal = STAGE_ORDER.reduce((a, s) => a + (stageMin(row, s) ?? 0), 0);

  return (
    <View style={styles.nightCard}>
      <View style={styles.nightHeader}>
        <Text style={styles.nightDate}>{dateHeadline(row.date)}</Text>
        <Text style={styles.nightTotal}>{fmt(total)}{effPct != null && effPct < 99 ? ` · ${effPct}% eff` : ''}</Text>
      </View>

      {stages.length > 0 ? (
        <Hypnogram stages={stages} width={cardWidth} height={128} />
      ) : stageTotal > 0 ? (
        <View style={[styles.fallbackBar, { width: cardWidth }]}>
          {STAGE_ORDER.map(s => {
            const m = stageMin(row, s) ?? 0;
            if (m <= 0) return null;
            return <View key={s} style={{ width: (m / stageTotal) * cardWidth, backgroundColor: stageColors[s] }} />;
          })}
        </View>
      ) : null}

      {stageTotal > 0 && (
        <View style={styles.stageStats}>
          {STAGE_ORDER.map(s => (
            <View key={s} style={styles.stageStat}>
              <View style={[styles.dot, { backgroundColor: stageColors[s] }]} />
              <Text style={styles.stageStatLabel}>{stageLabels[s]}</Text>
              <Text style={styles.stageStatVal}>{stageMin(row, s) != null ? fmt(stageMin(row, s)!) : '--'}</Text>
            </View>
          ))}
        </View>
      )}

      <View style={styles.nightStatsRow}>
        <NightStat label="RESTING HR" value={row.rhr != null ? `${Math.round(row.rhr)}` : '--'} />
        <NightStat label="HRV" value={row.rmssd != null ? `${Math.round(row.rmssd)}` : '--'} />
        <NightStat label="RESP" value={row.resp_rate != null ? `${Math.round(row.resp_rate * 10) / 10}` : '--'} />
      </View>
    </View>
  );
}

export default function SleepScreen() {
  const [rows, setRows] = useState<DailyRow[]>([]);
  const insets = useSafeAreaInsets();

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
    <ScrollView style={styles.scroll} contentContainerStyle={[styles.content, { paddingTop: insets.top + spacing.sm }]}>
      <Text style={styles.title}>Sleep</Text>

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
  scroll: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.lg, paddingBottom: 40 },
  title: { fontSize: 28, fontWeight: '700', color: colors.text, marginBottom: spacing.lg },
  nightCard: { backgroundColor: colors.surface, borderRadius: radii.lg, padding: spacing.lg, marginBottom: spacing.md },
  nightHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: spacing.md },
  nightDate: { fontSize: 15, color: colors.text, fontWeight: '600' },
  nightTotal: { fontSize: 14, color: colors.textDim },
  fallbackBar: { flexDirection: 'row', height: 22, borderRadius: 5, overflow: 'hidden', backgroundColor: colors.surfaceAlt },
  stageStats: { flexDirection: 'row', justifyContent: 'space-between', marginTop: spacing.md },
  stageStat: { alignItems: 'center', gap: 4, flex: 1 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  stageStatLabel: { fontSize: 10, color: colors.textFaint, letterSpacing: 1 },
  stageStatVal: { fontSize: 13, color: colors.textDim, fontWeight: '500' },
  nightStatsRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: spacing.lg, borderTopWidth: 1, borderTopColor: colors.borderFaint, paddingTop: spacing.md },
  nightStat: { alignItems: 'center', flex: 1 },
  nightStatVal: { fontSize: 18, fontWeight: '600', color: colors.text },
  nightStatLabel: { fontSize: 10, color: colors.textFaint, letterSpacing: 1, marginTop: 2 },
  emptyInner: { alignItems: 'center', marginTop: 60 },
  emptyText: { fontSize: 18, color: colors.textFaint, fontWeight: '600' },
  emptySubtext: { fontSize: 13, color: colors.textGhost, marginTop: 8, textAlign: 'center', paddingHorizontal: 32 },
});
