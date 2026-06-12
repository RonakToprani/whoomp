import React from 'react';
import Svg, { Rect } from 'react-native-svg';
import { View, Text, StyleSheet } from 'react-native';
import { stageColors, stageLabels, colors } from '../theme';

interface Seg { start: number; end: number; stage: string; }
interface Props { stages: Seg[]; width: number; height?: number; }

// Lanes top→bottom (WHOOP order): wake, rem, light, deep.
const LANES = ['wake', 'rem', 'light', 'deep'] as const;

export default function Hypnogram({ stages, width, height = 132 }: Props) {
  if (!stages || stages.length === 0) return null;
  const t0 = Math.min(...stages.map(s => s.start));
  const t1 = Math.max(...stages.map(s => s.end));
  const span = Math.max(1, t1 - t0);
  const labelW = 44;
  const chartW = width - labelW;
  const laneH = height / LANES.length;
  const x = (t: number) => labelW + ((t - t0) / span) * chartW;

  return (
    <View>
      <Svg width={width} height={height}>
        {LANES.map((lane, i) => (
          <Rect key={`bg-${lane}`} x={labelW} y={i * laneH + laneH / 2 - 0.5} width={chartW} height={1} fill={colors.borderFaint} />
        ))}
        {stages.map((s, idx) => {
          const lane = LANES.indexOf(s.stage as typeof LANES[number]);
          if (lane < 0) return null;
          const xs = x(s.start);
          const w = Math.max(1.5, x(s.end) - xs);
          return (
            <Rect key={idx} x={xs} y={lane * laneH + 4} width={w} height={laneH - 8} rx={3} fill={stageColors[s.stage]} />
          );
        })}
      </Svg>
      <View style={[styles.lanes, { height }]} pointerEvents="none">
        {LANES.map(lane => (
          <Text key={lane} style={[styles.laneLabel, { height: laneH, lineHeight: laneH, color: stageColors[lane] }]}>
            {stageLabels[lane]}
          </Text>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  lanes: { position: 'absolute', left: 0, top: 0, justifyContent: 'flex-start' },
  laneLabel: { fontSize: 9, letterSpacing: 0.5, width: 44, textAlignVertical: 'center' },
});
