import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import Svg, { Rect, Polyline, Line } from 'react-native-svg';
import { colors, stageColors, withAlpha } from '../theme';

interface Seg { start: number; end: number; stage: string }
interface HrPt { unix: number; hr: number }
interface Props { hr: HrPt[]; stages: Seg[]; width: number; height?: number }

const LEGEND: Array<[string, string]> = [
  ['wake', 'Awake'], ['rem', 'REM'], ['light', 'Light'], ['deep', 'Deep'],
];

function clock(unix: number): string {
  const d = new Date(unix * 1000);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// Sleeping heart rate drawn over translucent per-stage bands on a shared time axis — the WHOOP
// "SLEEPING HEART RATE" panel. Bands come from the staged hypnogram; the HR line is split on data
// gaps (>6 min) so it never bridges a missing stretch.
export default function SleepStageChart({ hr, stages, width, height = 190 }: Props) {
  const haveStages = stages.length > 0;
  const haveHr = hr.length > 1;
  if (!haveStages && !haveHr) return null;

  const t0 = Math.min(haveStages ? Math.min(...stages.map(s => s.start)) : Infinity, haveHr ? hr[0].unix : Infinity);
  const t1 = Math.max(haveStages ? Math.max(...stages.map(s => s.end)) : -Infinity, haveHr ? hr[hr.length - 1].unix : -Infinity);
  const span = Math.max(1, t1 - t0);
  const x = (t: number) => ((t - t0) / span) * width;

  const hrs = hr.map(p => p.hr);
  const lo = haveHr ? Math.min(...hrs) - 3 : 40;
  const hi = haveHr ? Math.max(...hrs) + 3 : 100;
  const range = Math.max(1, hi - lo);
  const y = (v: number) => height - ((v - lo) / range) * height;

  const segs: HrPt[][] = [];
  let cur: HrPt[] = [];
  for (const p of hr) {
    if (cur.length && p.unix - cur[cur.length - 1].unix > 360) { segs.push(cur); cur = []; }
    cur.push(p);
  }
  if (cur.length) segs.push(cur);

  return (
    <View>
      <Svg width={width} height={height}>
        {stages.map((s, i) => {
          const c = stageColors[s.stage];
          if (!c) return null;
          const xs = x(s.start);
          return <Rect key={i} x={xs} y={0} width={Math.max(0.5, x(s.end) - xs)} height={height} fill={withAlpha(c, s.stage === 'wake' ? 0.14 : 0.22)} />;
        })}
        <Line x1={0} y1={height / 2} x2={width} y2={height / 2} stroke={colors.borderFaint} strokeWidth={1} />
        {segs.map((s, i) => (
          <Polyline key={i} points={s.map(p => `${x(p.unix).toFixed(1)},${y(p.hr).toFixed(1)}`).join(' ')}
            fill="none" stroke={colors.text} strokeOpacity={0.92} strokeWidth={1.6} strokeLinejoin="round" />
        ))}
      </Svg>
      <View style={[styles.axis, { width }]}>
        <Text style={styles.axisLabel}>{clock(t0)}</Text>
        <Text style={styles.axisLabel}>{clock(t1)}</Text>
      </View>
      <View style={styles.legend}>
        {LEGEND.map(([k, label]) => (
          <View key={k} style={styles.legendItem}>
            <View style={[styles.legendDot, { backgroundColor: stageColors[k] }]} />
            <Text style={styles.legendText}>{label}</Text>
          </View>
        ))}
        <View style={styles.legendItem}>
          <View style={[styles.legendLine]} />
          <Text style={styles.legendText}>Heart rate</Text>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  axis: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 6 },
  axisLabel: { color: colors.textFaint, fontSize: 10, fontVariant: ['tabular-nums'] },
  legend: { flexDirection: 'row', flexWrap: 'wrap', gap: 14, marginTop: 12 },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  legendDot: { width: 9, height: 9, borderRadius: 2 },
  legendLine: { width: 12, height: 2, borderRadius: 1, backgroundColor: colors.text },
  legendText: { color: colors.textDim, fontSize: 11 },
});
