import React, { useEffect, useState, useCallback } from 'react';
import { View, Text, ScrollView, StyleSheet, useWindowDimensions } from 'react-native';
import Svg, { Polyline, Line, Circle, Rect } from 'react-native-svg';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  getDailyHistory, getLatestSampleDate, getIntradayHr, rollupAllDays,
  DailyRow, IntradayPoint,
} from '../storage/db';
import { cToF } from '../metrics/skinTemp';
import { colors, spacing, radii, metricColors, withAlpha } from '../theme';

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
type GoodWhen = 'higher' | 'lower' | 'neutral';

function localDateStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function dayLabel(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  return DAY_LABELS[new Date(y, m - 1, d).getDay()];
}
function dateHeadline(dateStr: string): string {
  if (dateStr === localDateStr(new Date())) return 'Today';
  if (dateStr === localDateStr(new Date(Date.now() - 86400_000))) return 'Yesterday';
  return dateStr.slice(5);
}
function fmtSleep(min: number): string {
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return h > 0 ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`;
}

function IntradayHrChart({ points, width, height }: { points: IntradayPoint[]; width: number; height: number }) {
  if (points.length < 2) {
    return <View style={{ width, height, alignItems: 'center', justifyContent: 'center' }}><Text style={styles.noData}>not enough data yet</Text></View>;
  }
  const hrs = points.map(p => p.hr);
  const min = Math.min(...hrs) - 5;
  const max = Math.max(...hrs) + 5;
  const range = Math.max(max - min, 1);
  const x = (minute: number) => (minute / 1440) * width;
  const y = (hr: number) => height - ((hr - min) / range) * height;
  const segments: IntradayPoint[][] = [];
  let seg: IntradayPoint[] = [];
  for (const p of points) {
    if (seg.length && p.minute - seg[seg.length - 1].minute > 30) { segments.push(seg); seg = []; }
    seg.push(p);
  }
  if (seg.length) segments.push(seg);
  return (
    <Svg width={width} height={height}>
      {[6, 12, 18].map(h => <Line key={h} x1={x(h * 60)} y1={0} x2={x(h * 60)} y2={height} stroke={colors.borderFaint} strokeWidth={1} />)}
      {segments.map((s, i) =>
        s.length === 1
          ? <Circle key={i} cx={x(s[0].minute)} cy={y(s[0].hr)} r={2} fill={metricColors.hr} />
          : <Polyline key={i} points={s.map(p => `${x(p.minute).toFixed(1)},${y(p.hr).toFixed(1)}`).join(' ')} fill="none" stroke={metricColors.hr} strokeWidth={2} strokeLinejoin="round" />
      )}
    </Svg>
  );
}

function TrendChart({ data, width, height, color }: { data: (number | null)[]; width: number; height: number; color: string }) {
  const valid = data.filter((v): v is number => v != null);
  if (valid.length === 0) {
    return <View style={{ width, height, alignItems: 'center', justifyContent: 'center' }}><Text style={styles.noData}>no data yet</Text></View>;
  }
  const min = Math.min(...valid) * 0.95;
  const max = Math.max(...valid) * 1.05;
  const range = Math.max(max - min, 1);
  const step = width / Math.max(data.length - 1, 1);
  const avg = valid.reduce((a, b) => a + b, 0) / valid.length;
  const std = valid.length > 1 ? Math.sqrt(valid.reduce((a, b) => a + (b - avg) ** 2, 0) / (valid.length - 1)) : 0;
  const y = (v: number) => height - ((v - min) / range) * height;

  if (valid.length === 1) {
    return <Svg width={width} height={height}><Circle cx={width / 2} cy={height / 2} r={4} fill={color} /></Svg>;
  }
  const pts = data.map((v, i) => (v == null ? null : [i * step, y(v)] as const)).filter((p): p is readonly [number, number] => p != null);
  const line = pts.map(([px, py]) => `${px.toFixed(1)},${py.toFixed(1)}`).join(' ');
  const last = pts[pts.length - 1];
  const bandTop = Math.max(0, y(avg + std));
  const bandBot = Math.min(height, y(avg - std));

  return (
    <Svg width={width} height={height}>
      {std > 0 && <Rect x={0} y={bandTop} width={width} height={Math.max(0, bandBot - bandTop)} fill={withAlpha(color, 0.10)} />}
      <Line x1={0} y1={y(avg)} x2={width} y2={y(avg)} stroke={colors.border} strokeWidth={1} strokeDasharray="4 4" />
      <Polyline points={line} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
      {last && <Circle cx={last[0]} cy={last[1]} r={3} fill={color} />}
    </Svg>
  );
}

function TrendSection({ label, rows, getValue, unit, color, goodWhen = 'neutral', fmt }: {
  label: string; rows: DailyRow[]; getValue: (r: DailyRow) => number | null; unit: string; color: string;
  goodWhen?: GoodWhen; fmt?: (v: number) => string;
}) {
  const { width } = useWindowDimensions();
  const chartWidth = width - 64;
  const ordered = [...rows].reverse(); // oldest → newest
  const data = ordered.map(getValue);
  const valid = data.filter((v): v is number => v != null);
  if (valid.length === 0) return null;

  const latest = valid[valid.length - 1];
  const avg = valid.reduce((a, b) => a + b, 0) / valid.length;
  const lo = Math.min(...valid);
  const hi = Math.max(...valid);
  const show = (v: number) => (fmt ? fmt(v) : `${Math.round(v * 10) / 10}`);

  // Trend direction: first-half vs second-half mean, with a deadband at 4% of the range.
  const half = Math.floor(valid.length / 2);
  const firstMean = valid.slice(0, half).reduce((a, b) => a + b, 0) / Math.max(1, half);
  const secondMean = valid.slice(half).reduce((a, b) => a + b, 0) / Math.max(1, valid.length - half);
  const delta = secondMean - firstMean;
  const dead = Math.max(1e-9, (hi - lo) * 0.04);
  const dir = valid.length < 4 || Math.abs(delta) < dead ? 'flat' : delta > 0 ? 'up' : 'down';
  const arrow = dir === 'up' ? '↑' : dir === 'down' ? '↓' : '→';
  const good = goodWhen === 'neutral' || dir === 'flat'
    ? colors.textDim
    : (goodWhen === 'higher' ? dir === 'up' : dir === 'down') ? colors.green : colors.red;

  const stepN = ordered.length > 14 ? 6 : 2;
  const tickRows = ordered.filter((_, i) => i % stepN === 0);

  return (
    <View style={styles.section}>
      <View style={styles.sectionHeader}>
        <View style={styles.sectionTitleWrap}>
          <View style={[styles.dot, { backgroundColor: color }]} />
          <Text style={styles.sectionLabel}>{label}</Text>
        </View>
        <View style={styles.sectionValues}>
          <Text style={[styles.arrow, { color: good }]}>{arrow}</Text>
          <Text style={[styles.sectionValue, { color }]}>{show(latest)}{unit ? ` ${unit}` : ''}</Text>
        </View>
      </View>
      <TrendChart data={data} width={chartWidth} height={70} color={color} />
      <View style={[styles.metaRow, { width: chartWidth }]}>
        <Text style={styles.metaText}>avg {show(avg)}</Text>
        <Text style={styles.metaText}>range {show(lo)}–{show(hi)}</Text>
      </View>
      {tickRows.length > 0 && (
        <View style={[styles.axisRow, { width: chartWidth }]}>
          {tickRows.map(r => <Text key={r.date} style={styles.axisLabel}>{dayLabel(r.date)}</Text>)}
        </View>
      )}
    </View>
  );
}

export default function TrendsScreen() {
  const [rows, setRows] = useState<DailyRow[]>([]);
  const [intraday, setIntraday] = useState<IntradayPoint[]>([]);
  const [intradayDate, setIntradayDate] = useState<string | null>(null);
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const chartWidth = width - 64;

  const load = useCallback(async () => {
    try {
      await rollupAllDays();
      const [daily, latest] = await Promise.all([getDailyHistory(30), getLatestSampleDate()]);
      setRows(daily);
      if (latest) { setIntradayDate(latest); setIntraday(await getIntradayHr(latest, 10)); }
    } catch {}
  }, []);

  useEffect(() => { load(); }, [load]);

  if (rows.length === 0 && intraday.length === 0) {
    return (
      <View style={styles.empty}>
        <Text style={styles.emptyTitle}>No history yet</Text>
        <Text style={styles.emptyText}>Trends appear after your first connected session</Text>
      </View>
    );
  }

  // 14-day recovery summary insight.
  const recoveryVals = [...rows].reverse().map(r => r.recovery).filter((v): v is number => v != null);
  const recAvg = recoveryVals.length ? Math.round(recoveryVals.reduce((a, b) => a + b, 0) / recoveryVals.length) : null;
  const intradayHrs = intraday.map(p => p.hr);

  return (
    <ScrollView style={styles.scroll} contentContainerStyle={[styles.content, { paddingTop: insets.top + spacing.sm }]}>
      <Text style={styles.title}>Trends</Text>

      {recAvg != null && (
        <View style={styles.summaryCard}>
          <Text style={styles.summaryLabel}>LAST {recoveryVals.length} DAYS</Text>
          <Text style={styles.summaryValue}>Avg recovery <Text style={{ color: metricColors.recovery }}>{recAvg}%</Text></Text>
        </View>
      )}

      {intraday.length >= 2 && intradayDate && (
        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionLabel}>HEART RATE · {dateHeadline(intradayDate).toUpperCase()}</Text>
            <Text style={[styles.sectionValue, { color: metricColors.hr }]}>{Math.min(...intradayHrs)}–{Math.max(...intradayHrs)} bpm</Text>
          </View>
          <IntradayHrChart points={intraday} width={chartWidth} height={90} />
          <View style={[styles.axisRow, { width: chartWidth }]}>
            {['12a', '6a', '12p', '6p', '12a'].map((l, i) => <Text key={i} style={styles.axisLabel}>{l}</Text>)}
          </View>
        </View>
      )}

      <TrendSection label="RECOVERY" rows={rows} getValue={r => r.recovery} unit="%" color={metricColors.recovery} goodWhen="higher" />
      <TrendSection label="SLEEP" rows={rows} getValue={r => r.sleep_minutes} unit="" color={metricColors.sleep} goodWhen="higher" fmt={fmtSleep} />
      <TrendSection label="HRV (RMSSD)" rows={rows} getValue={r => r.rmssd} unit="ms" color={metricColors.hrv} goodWhen="higher" />
      <TrendSection label="RESTING HR" rows={rows} getValue={r => r.rhr} unit="bpm" color={metricColors.rhr} goodWhen="lower" />
      <TrendSection label="STRAIN" rows={rows} getValue={r => r.strain} unit="" color={metricColors.strain} goodWhen="neutral" />
      <TrendSection label="RESPIRATORY" rows={rows} getValue={r => r.resp_rate ?? null} unit="rpm" color={metricColors.resp} goodWhen="neutral" />
      <TrendSection label="SKIN TEMP" rows={rows} getValue={r => (r.skin_temp_c != null ? cToF(r.skin_temp_c) : null)} unit="°F" color={metricColors.skinTemp} goodWhen="neutral" />
      <TrendSection label="BLOOD O₂ · RELATIVE" rows={rows} getValue={r => r.spo2_ratio ?? null} unit="" color={metricColors.spo2} goodWhen="neutral" fmt={v => v.toFixed(3)} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.lg, paddingBottom: 40 },
  title: { fontSize: 28, fontWeight: '700', color: colors.text, marginBottom: spacing.lg },
  summaryCard: { backgroundColor: colors.surface, borderRadius: radii.lg, padding: spacing.lg, marginBottom: spacing.md },
  summaryLabel: { fontSize: 11, color: colors.textFaint, letterSpacing: 1.5, marginBottom: 4 },
  summaryValue: { fontSize: 20, fontWeight: '700', color: colors.text },
  section: { backgroundColor: colors.surface, borderRadius: radii.lg, padding: spacing.lg, marginBottom: spacing.md },
  sectionHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: spacing.md },
  sectionTitleWrap: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  sectionLabel: { fontSize: 11, color: colors.textFaint, letterSpacing: 1.5 },
  sectionValues: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  arrow: { fontSize: 15, fontWeight: '700' },
  sectionValue: { fontSize: 16, fontWeight: '700', color: colors.text },
  metaRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: spacing.sm },
  metaText: { fontSize: 11, color: colors.textFaint },
  axisRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: spacing.xs },
  axisLabel: { fontSize: 10, color: colors.textGhost },
  noData: { color: colors.textGhost, fontSize: 12 },
  empty: { flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center', padding: spacing.xxl },
  emptyTitle: { fontSize: 18, color: colors.textFaint, fontWeight: '600' },
  emptyText: { fontSize: 13, color: colors.textGhost, marginTop: spacing.sm, textAlign: 'center' },
});
