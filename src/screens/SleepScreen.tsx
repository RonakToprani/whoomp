import React, { useEffect, useState } from 'react';
import { View, Text, ScrollView, StyleSheet, useWindowDimensions, DimensionValue } from 'react-native';
import { getDailyHistory, rollupAllDays, getNightHr, DailyRow, NightHrPoint } from '../storage/db';
import { sleepNeed, sleepPerformance } from '../metrics/sleepNeed';
import { cToF } from '../metrics/skinTemp';
import SleepStageChart from '../components/SleepStageChart';
import StageBars, { StageRow } from '../components/StageBars';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, spacing, radii, stageColors, metricColors, sleepPerfColor } from '../theme';

interface Seg { start: number; end: number; stage: string }

function localDateStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function dateHeadline(dateStr: string): string {
  if (dateStr === localDateStr(new Date())) return 'Today';
  if (dateStr === localDateStr(new Date(Date.now() - 86400_000))) return 'Yesterday';
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
}
function fmt(min: number | null | undefined): string {
  if (min == null) return '--';
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return h > 0 ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`;
}
function clock(unix: number | null | undefined): string | null {
  if (unix == null) return null;
  const d = new Date(unix * 1000);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
function parseStages(json: string | null | undefined): Seg[] {
  if (!json) return [];
  try { const a = JSON.parse(json); return Array.isArray(a) ? a : []; } catch { return []; }
}
function stageRows(row: DailyRow): StageRow[] {
  return [
    { key: 'wake', label: 'Awake', min: row.awake_min ?? 0, color: stageColors.wake },
    { key: 'rem', label: 'REM', min: row.rem_min ?? 0, color: stageColors.rem },
    { key: 'light', label: 'Light', min: row.light_min ?? 0, color: stageColors.light },
    { key: 'deep', label: 'Deep', min: row.deep_min ?? 0, color: stageColors.deep },
  ];
}

function Stat({ value, label, color }: { value: string; label: string; color?: string }) {
  return (
    <View style={styles.stat}>
      <Text style={[styles.statVal, color ? { color } : null]}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

function NeedBreakdown({ baselineMin, debtMin, strainMin }: { baselineMin: number; debtMin: number; strainMin: number }) {
  const total = baselineMin + debtMin + strainMin;
  const seg = (m: number): DimensionValue => `${(m / total) * 100}%`;
  return (
    <View>
      <View style={styles.needTrack}>
        <View style={{ width: seg(baselineMin), backgroundColor: metricColors.sleep }} />
        <View style={{ width: seg(debtMin), backgroundColor: metricColors.skinTemp }} />
        <View style={{ width: seg(strainMin), backgroundColor: metricColors.strain }} />
      </View>
      <View style={styles.needLegend}>
        <Text style={styles.needLegendItem}><Text style={{ color: metricColors.sleep }}>●</Text> baseline {fmt(baselineMin)}</Text>
        <Text style={styles.needLegendItem}><Text style={{ color: metricColors.skinTemp }}>●</Text> debt {fmt(debtMin)}</Text>
        <Text style={styles.needLegendItem}><Text style={{ color: metricColors.strain }}>●</Text> strain {fmt(strainMin)}</Text>
      </View>
    </View>
  );
}

function FeaturedNight({ row, allRows, hr, width }: { row: DailyRow; allRows: DailyRow[]; hr: NightHrPoint[]; width: number }) {
  const asleep = row.sleep_minutes ?? 0;
  const stages = parseStages(row.sleep_stages);

  // Recompute the sleep-need breakdown from history (same inputs as the stored total).
  const priorRows = allRows.filter(r => r.date < row.date);
  const recentAsleep = priorRows.slice(0, 3).map(r => r.sleep_minutes).filter((m): m is number => m != null);
  const need = sleepNeed({ recentAsleepMin: recentAsleep, dayStrain: priorRows[0]?.strain ?? null });
  const perf = sleepPerformance(asleep, need.needMin);
  const perfPct = perf != null ? Math.min(100, Math.round(perf)) : null;

  const effPct = row.sleep_efficiency != null ? Math.round(row.sleep_efficiency * 100) : null;
  const skinF = cToF(row.skin_temp_c ?? null);
  const restorative = (row.rem_min ?? 0) + (row.deep_min ?? 0);
  const restPct = asleep > 0 ? Math.round((restorative / asleep) * 100) : null;
  const onset = clock(row.sleep_onset_unix);
  const wake = clock(row.sleep_wake_unix);
  const hrs = hr.map(p => p.hr);
  const cardW = width - spacing.lg * 2 - spacing.lg * 2;

  return (
    <View style={styles.detailCard}>
      <View style={styles.detailHeader}>
        <Text style={styles.detailDate}>{dateHeadline(row.date)}</Text>
        <View style={styles.perfRow}>
          <Text style={[styles.perfPct, { color: sleepPerfColor(perf) }]}>{perfPct != null ? `${perfPct}%` : '--'}</Text>
          <Text style={styles.perfCaption}>{fmt(asleep)} asleep · {fmt(need.needMin)} needed</Text>
        </View>
      </View>

      {/* asleep vs need progress */}
      <View style={styles.progressTrack}>
        <View style={[styles.progressFill, { width: `${perfPct ?? 0}%`, backgroundColor: sleepPerfColor(perf) }]} />
      </View>
      {onset && wake && <Text style={styles.onsetWake}>asleep {onset}  →  awake {wake}</Text>}

      {/* stat cards */}
      <View style={styles.statRow}>
        <Stat value={effPct != null ? `${effPct}%` : '--'} label="EFFICIENCY" />
        <Stat value={fmt(asleep)} label="ASLEEP" />
        <Stat value={row.lowest_hr != null ? `${Math.round(row.lowest_hr)}` : '--'} label="LOWEST HR" color={metricColors.hr} />
        <Stat value={skinF != null ? `${(Math.round(skinF * 10) / 10).toFixed(1)}°` : '--'} label="SKIN TEMP" color={metricColors.skinTemp} />
      </View>

      {/* sleeping HR + stage bands */}
      {(hr.length > 1 || stages.length > 0) && (
        <View style={styles.subSection}>
          <View style={styles.subHead}>
            <Text style={styles.subLabel}>SLEEPING HEART RATE</Text>
            {hrs.length > 0 && <Text style={styles.subMeta}>{Math.min(...hrs)}–{Math.max(...hrs)} bpm</Text>}
          </View>
          <SleepStageChart hr={hr} stages={stages} width={cardW} height={180} />
        </View>
      )}

      {/* restorative */}
      {restorative > 0 && asleep > 0 && (
        <View style={styles.subSection}>
          <View style={styles.subHead}>
            <Text style={[styles.subLabel, { color: metricColors.resp }]}>RESTORATIVE  {fmt(restorative)}</Text>
            <Text style={styles.subMeta}>{restPct}% REM+Deep</Text>
          </View>
          <View style={styles.restTrack}>
            <View style={{ width: `${((row.rem_min ?? 0) / asleep) * 100}%`, backgroundColor: stageColors.rem }} />
            <View style={{ width: `${((row.deep_min ?? 0) / asleep) * 100}%`, backgroundColor: stageColors.deep }} />
          </View>
        </View>
      )}

      {/* stage breakdown */}
      <View style={styles.subSection}>
        <Text style={styles.subLabel}>STAGES</Text>
        <View style={{ marginTop: spacing.md }}>
          <StageBars rows={stageRows(row)} />
        </View>
      </View>

      {/* sleep need */}
      <View style={styles.subSection}>
        <View style={styles.subHead}>
          <Text style={styles.subLabel}>SLEEP NEED</Text>
          <Text style={styles.subMeta}>{fmt(need.needMin)}</Text>
        </View>
        <View style={{ marginTop: spacing.sm }}>
          <NeedBreakdown baselineMin={need.baselineMin} debtMin={need.debtMin} strainMin={need.strainMin} />
        </View>
      </View>
    </View>
  );
}

function PriorNight({ row }: { row: DailyRow }) {
  const effPct = row.sleep_efficiency != null ? Math.round(row.sleep_efficiency * 100) : null;
  return (
    <View style={styles.priorCard}>
      <View style={styles.priorHeader}>
        <Text style={styles.priorDate}>{dateHeadline(row.date)}</Text>
        <Text style={styles.priorTotal}>{fmt(row.sleep_minutes)}{effPct != null && effPct < 99 ? ` · ${effPct}%` : ''}</Text>
      </View>
      <StageBars rows={stageRows(row)} />
    </View>
  );
}

export default function SleepScreen() {
  const [rows, setRows] = useState<DailyRow[]>([]);
  const [nightHr, setNightHr] = useState<NightHrPoint[]>([]);
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();

  useEffect(() => {
    (async () => {
      try {
        await rollupAllDays();
        const all = (await getDailyHistory(14)).filter(r => r.sleep_minutes != null && r.sleep_minutes > 0);
        setRows(all);
        const top = all[0];
        if (top?.sleep_onset_unix != null && top?.sleep_wake_unix != null) {
          setNightHr(await getNightHr(top.sleep_onset_unix, top.sleep_wake_unix));
        }
      } catch {}
    })();
  }, []);

  return (
    <ScrollView style={styles.scroll} contentContainerStyle={[styles.content, { paddingTop: insets.top + spacing.sm }]}>
      <Text style={styles.title}>Sleep</Text>

      {rows.length === 0 ? (
        <View style={styles.emptyInner}>
          <Text style={styles.emptyText}>No sleep data yet</Text>
          <Text style={styles.emptySubtext}>Sleep detail appears after an overnight session syncs to the app</Text>
        </View>
      ) : (
        <>
          <FeaturedNight row={rows[0]} allRows={rows} hr={nightHr} width={width} />
          {rows.length > 1 && <Text style={styles.sectionLabel}>EARLIER NIGHTS</Text>}
          {rows.slice(1).map(r => <PriorNight key={r.date} row={r} />)}
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.lg, paddingBottom: 40 },
  title: { fontSize: 28, fontWeight: '700', color: colors.text, marginBottom: spacing.lg },

  detailCard: { backgroundColor: colors.surface, borderRadius: radii.xl, padding: spacing.lg, marginBottom: spacing.lg },
  detailHeader: { marginBottom: spacing.md },
  detailDate: { fontSize: 14, color: colors.textDim, fontWeight: '600', marginBottom: 6 },
  perfRow: { flexDirection: 'row', alignItems: 'baseline', gap: 10 },
  perfPct: { fontSize: 44, fontWeight: '800' },
  perfCaption: { fontSize: 13, color: colors.textDim, flex: 1 },

  progressTrack: { height: 8, borderRadius: radii.pill, backgroundColor: colors.surfaceAlt, overflow: 'hidden', marginTop: spacing.sm },
  progressFill: { height: 8, borderRadius: radii.pill },
  onsetWake: { fontSize: 12, color: colors.textFaint, marginTop: 8, fontVariant: ['tabular-nums'] },

  statRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: spacing.lg, gap: spacing.sm },
  stat: { flex: 1, backgroundColor: colors.surfaceAlt, borderRadius: radii.md, paddingVertical: spacing.md, alignItems: 'center' },
  statVal: { fontSize: 18, fontWeight: '700', color: colors.text },
  statLabel: { fontSize: 9, color: colors.textFaint, letterSpacing: 0.8, marginTop: 4 },

  subSection: { marginTop: spacing.xl },
  subHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: spacing.sm },
  subLabel: { fontSize: 11, color: colors.textFaint, letterSpacing: 1.5, fontWeight: '600' },
  subMeta: { fontSize: 12, color: colors.textDim, fontVariant: ['tabular-nums'] },

  restTrack: { flexDirection: 'row', height: 10, borderRadius: radii.pill, backgroundColor: colors.surfaceAlt, overflow: 'hidden' },

  needTrack: { flexDirection: 'row', height: 10, borderRadius: radii.pill, overflow: 'hidden', backgroundColor: colors.surfaceAlt },
  needLegend: { flexDirection: 'row', flexWrap: 'wrap', gap: 14, marginTop: spacing.sm },
  needLegendItem: { fontSize: 11, color: colors.textDim },

  sectionLabel: { fontSize: 13, color: colors.text, fontWeight: '700', letterSpacing: 1, marginBottom: spacing.sm, marginLeft: 6 },
  priorCard: { backgroundColor: colors.surface, borderRadius: radii.lg, padding: spacing.lg, marginBottom: spacing.md },
  priorHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: spacing.md },
  priorDate: { fontSize: 14, color: colors.text, fontWeight: '600' },
  priorTotal: { fontSize: 13, color: colors.textDim, fontVariant: ['tabular-nums'] },

  emptyInner: { alignItems: 'center', marginTop: 60 },
  emptyText: { fontSize: 18, color: colors.textFaint, fontWeight: '600' },
  emptySubtext: { fontSize: 13, color: colors.textGhost, marginTop: 8, textAlign: 'center', paddingHorizontal: 32 },
});
