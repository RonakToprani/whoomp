import React, { useEffect, useState, useCallback } from 'react';
import { View, Text, ScrollView, StyleSheet, useWindowDimensions } from 'react-native';
import Svg, { Polyline, Line, Circle, Rect } from 'react-native-svg';
import {
  getDailyHistory, getLatestSampleDate, getIntradayHr, rollupAllDays,
  DailyRow, IntradayPoint,
} from '../storage/db';
import { colors, spacing, radii } from '../theme';

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

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
          ? <Circle key={i} cx={x(s[0].minute)} cy={y(s[0].hr)} r={2} fill={colors.red} />
          : <Polyline key={i} points={s.map(p => `${x(p.minute).toFixed(1)},${y(p.hr).toFixed(1)}`).join(' ')} fill="none" stroke={colors.red} strokeWidth={2} strokeLinejoin="round" />
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
  const points = data.map((v, i) => (v == null ? null : `${(i * step).toFixed(1)},${y(v).toFixed(1)}`)).filter(Boolean).join(' ');
  const bandTop = Math.max(0, y(avg + std));
  const bandBot = Math.min(height, y(avg - std));

  return (
    <Svg width={width} height={height}>
      {/* ±1σ baseline band + mean line, so deviations are legible. */}
      {std > 0 && <Rect x={0} y={bandTop} width={width} height={Math.max(0, bandBot - bandTop)} fill={color + '14'} />}
      <Line x1={0} y1={y(avg)} x2={width} y2={y(avg)} stroke={colors.border} strokeWidth={1} strokeDasharray="4 4" />
      <Polyline points={points} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" />
    </Svg>
  );
}

function TrendSection({ label, rows, getValue, unit, color }: {
  label: string; rows: DailyRow[]; getValue: (r: DailyRow) => number | null; unit: string; color: string;
}) {
  const { width } = useWindowDimensions();
  const chartWidth = width - 64;
  const ordered = [...rows].reverse();
  const data = ordered.map(getValue);
  const valid = data.filter((v): v is number => v != null);
  const latest = valid[valid.length - 1] ?? null;
  const avg = valid.length > 0 ? valid.reduce((a, b) => a + b, 0) / valid.length : null;
  const stepN = ordered.length > 14 ? 6 : 2;
  const tickRows = ordered.filter((_, i) => i % stepN === 0);

  return (
    <View style={styles.section}>
      <View style={styles.sectionHeader}>
        <Text style={styles.sectionLabel}>{label}</Text>
        <View style={styles.sectionValues}>
          {avg != null && <Text style={styles.avgText}>avg {Math.round(avg * 10) / 10}</Text>}
          <Text style={styles.sectionValue}>{latest != null ? `${Math.round(latest * 10) / 10} ${unit}` : '--'}</Text>
        </View>
      </View>
      <TrendChart data={data} width={chartWidth} height={72} color={color} />
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

  const intradayHrs = intraday.map(p => p.hr);

  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Trends</Text>

      {intraday.length >= 2 && intradayDate && (
        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionLabel}>HEART RATE · {dateHeadline(intradayDate).toUpperCase()}</Text>
            <Text style={styles.sectionValue}>{Math.min(...intradayHrs)}–{Math.max(...intradayHrs)} bpm</Text>
          </View>
          <IntradayHrChart points={intraday} width={chartWidth} height={90} />
          <View style={[styles.axisRow, { width: chartWidth }]}>
            {['12a', '6a', '12p', '6p', '12a'].map((l, i) => <Text key={i} style={styles.axisLabel}>{l}</Text>)}
          </View>
        </View>
      )}

      <TrendSection label="RECOVERY" rows={rows} getValue={r => r.recovery} unit="%" color={colors.violet} />
      <TrendSection label="HRV (RMSSD)" rows={rows} getValue={r => r.rmssd} unit="ms" color={colors.green} />
      <TrendSection label="RESTING HR" rows={rows} getValue={r => r.rhr} unit="bpm" color={colors.red} />
      <TrendSection label="STRAIN" rows={rows} getValue={r => r.strain} unit="" color={colors.strain} />
      <TrendSection label="RESP RATE" rows={rows} getValue={r => r.resp_rate ?? null} unit="br/min" color={colors.yellow} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.lg, paddingBottom: 40 },
  title: { fontSize: 28, fontWeight: '700', color: colors.text, marginBottom: spacing.lg },
  section: { backgroundColor: colors.surface, borderRadius: radii.lg, padding: spacing.lg, marginBottom: spacing.md },
  sectionHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: spacing.md },
  sectionLabel: { fontSize: 11, color: colors.textFaint, letterSpacing: 1.5 },
  sectionValues: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  avgText: { fontSize: 12, color: colors.textGhost },
  sectionValue: { fontSize: 16, fontWeight: '600', color: colors.text },
  axisRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: spacing.sm },
  axisLabel: { fontSize: 10, color: colors.textGhost },
  noData: { color: colors.textGhost, fontSize: 12 },
  empty: { flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center', padding: spacing.xxl },
  emptyTitle: { fontSize: 18, color: colors.textFaint, fontWeight: '600' },
  emptyText: { fontSize: 13, color: colors.textGhost, marginTop: spacing.sm, textAlign: 'center' },
});
