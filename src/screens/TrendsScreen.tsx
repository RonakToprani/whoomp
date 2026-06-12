import React, { useEffect, useState, useCallback } from 'react';
import { View, Text, ScrollView, StyleSheet, useWindowDimensions } from 'react-native';
import Svg, { Polyline, Line, Circle } from 'react-native-svg';
import {
  getDailyHistory, getLatestSampleDate, getIntradayHr, rollupAllDays,
  DailyRow, IntradayPoint,
} from '../storage/db';

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

// Intraday HR over one day. X is positioned by clock time (not evenly spaced),
// and the line breaks across data gaps longer than ~30 min so it doesn't
// interpolate across hours where the strap wasn't streaming.
function IntradayHrChart({ points, width, height }: { points: IntradayPoint[]; width: number; height: number }) {
  if (points.length < 2) {
    return (
      <View style={{ width, height, alignItems: 'center', justifyContent: 'center' }}>
        <Text style={{ color: '#333', fontSize: 12 }}>not enough data yet</Text>
      </View>
    );
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
      {[6, 12, 18].map(h => (
        <Line key={h} x1={x(h * 60)} y1={0} x2={x(h * 60)} y2={height} stroke="#1a1a1a" strokeWidth={1} />
      ))}
      {segments.map((s, i) =>
        s.length === 1 ? (
          <Circle key={i} cx={x(s[0].minute)} cy={y(s[0].hr)} r={2} fill="#f87171" />
        ) : (
          <Polyline
            key={i}
            points={s.map(p => `${x(p.minute).toFixed(1)},${y(p.hr).toFixed(1)}`).join(' ')}
            fill="none" stroke="#f87171" strokeWidth={2} strokeLinejoin="round"
          />
        )
      )}
    </Svg>
  );
}

function TrendChart({
  data,
  width,
  height,
  color,
}: {
  data: (number | null)[];
  width: number;
  height: number;
  color: string;
}) {
  const valid = data.filter((v): v is number => v != null);
  if (valid.length === 0) {
    return (
      <View style={{ width, height, alignItems: 'center', justifyContent: 'center' }}>
        <Text style={{ color: '#333', fontSize: 12 }}>no data yet</Text>
      </View>
    );
  }
  const min = Math.min(...valid) * 0.95;
  const max = Math.max(...valid) * 1.05;
  const range = Math.max(max - min, 1);
  const step = width / Math.max(data.length - 1, 1);
  const avg = valid.reduce((a, b) => a + b, 0) / valid.length;
  const avgY = height - ((avg - min) / range) * height;

  if (valid.length === 1) {
    return (
      <Svg width={width} height={height}>
        <Circle cx={width / 2} cy={height / 2} r={4} fill={color} />
      </Svg>
    );
  }

  const points = data
    .map((v, i) => {
      if (v == null) return null;
      return `${(i * step).toFixed(1)},${(height - ((v - min) / range) * height).toFixed(1)}`;
    })
    .filter(Boolean)
    .join(' ');

  return (
    <Svg width={width} height={height}>
      <Line
        x1={0} y1={avgY} x2={width} y2={avgY}
        stroke="#2a2a2a" strokeWidth={1} strokeDasharray="4 4"
      />
      <Polyline points={points} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" />
    </Svg>
  );
}

function TrendSection({
  label, rows, getValue, unit, color,
}: {
  label: string;
  rows: DailyRow[];
  getValue: (r: DailyRow) => number | null;
  unit: string;
  color: string;
}) {
  const { width } = useWindowDimensions();
  // content padding 16+16, section padding 16+16
  const chartWidth = width - 64;
  // rows are newest-first; reverse for chart (left=oldest, right=today)
  const ordered = [...rows].reverse();
  const data = ordered.map(getValue);
  const valid = data.filter((v): v is number => v != null);
  const latest = valid[valid.length - 1] ?? null;
  const avg = valid.length > 0 ? valid.reduce((a, b) => a + b, 0) / valid.length : null;

  // Day labels: thin out as the window grows to avoid crowding.
  const stepN = ordered.length > 14 ? 6 : 2;
  const tickRows = ordered.filter((_, i) => i % stepN === 0);

  return (
    <View style={styles.section}>
      <View style={styles.sectionHeader}>
        <Text style={styles.sectionLabel}>{label}</Text>
        <View style={styles.sectionValues}>
          {avg != null && (
            <Text style={styles.avgText}>avg {Math.round(avg * 10) / 10}</Text>
          )}
          <Text style={styles.sectionValue}>
            {latest != null ? `${Math.round(latest * 10) / 10} ${unit}` : '--'}
          </Text>
        </View>
      </View>
      <TrendChart data={data} width={chartWidth} height={72} color={color} />
      {tickRows.length > 0 && (
        <View style={[styles.axisRow, { width: chartWidth }]}>
          {tickRows.map(r => (
            <Text key={r.date} style={styles.axisLabel}>{dayLabel(r.date)}</Text>
          ))}
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
      if (latest) {
        setIntradayDate(latest);
        setIntraday(await getIntradayHr(latest, 10));
      }
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
            <Text style={styles.sectionValue}>
              {Math.min(...intradayHrs)}–{Math.max(...intradayHrs)} bpm
            </Text>
          </View>
          <IntradayHrChart points={intraday} width={chartWidth} height={90} />
          <View style={[styles.axisRow, { width: chartWidth }]}>
            {['12a', '6a', '12p', '6p', '12a'].map((l, i) => (
              <Text key={i} style={styles.axisLabel}>{l}</Text>
            ))}
          </View>
        </View>
      )}

      <TrendSection label="HRV (RMSSD)" rows={rows} getValue={r => r.rmssd} unit="ms" color="#4ade80" />
      <TrendSection label="RESTING HR" rows={rows} getValue={r => r.rhr} unit="bpm" color="#f87171" />
      <TrendSection label="STRAIN" rows={rows} getValue={r => r.strain} unit="" color="#60a5fa" />
      <TrendSection label="RECOVERY" rows={rows} getValue={r => r.recovery} unit="%" color="#a78bfa" />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { flex: 1, backgroundColor: '#000' },
  content: { padding: 16, paddingBottom: 40 },
  title: { fontSize: 28, fontWeight: '700', color: '#fff', marginBottom: 24 },
  section: { backgroundColor: '#111', borderRadius: 14, padding: 16, marginBottom: 12 },
  sectionHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 },
  sectionLabel: { fontSize: 11, color: '#555', letterSpacing: 1.5 },
  sectionValues: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  avgText: { fontSize: 12, color: '#444' },
  sectionValue: { fontSize: 16, fontWeight: '600', color: '#fff' },
  axisRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 8 },
  axisLabel: { fontSize: 10, color: '#444' },
  empty: { flex: 1, backgroundColor: '#000', alignItems: 'center', justifyContent: 'center', padding: 32 },
  emptyTitle: { fontSize: 18, color: '#555', fontWeight: '600' },
  emptyText: { fontSize: 13, color: '#333', marginTop: 8, textAlign: 'center' },
});
