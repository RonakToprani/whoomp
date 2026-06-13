import React from 'react';
import { View } from 'react-native';
import Svg, { Polyline, Polygon, Circle, Defs, LinearGradient, Stop } from 'react-native-svg';

interface Props {
  data: (number | null)[];
  width?: number;
  height?: number;
  color: string;
  fill?: boolean;        // soft gradient area under the line
  dot?: boolean;         // dot on the most recent point
  strokeWidth?: number;
}

// Compact colored trend line (no axes) for metric cards. Nulls are skipped and the line connects
// through the gaps, so a sparse 14-day series still draws.
export default function Sparkline({ data, width = 96, height = 32, color, fill = true, dot = true, strokeWidth = 2 }: Props) {
  const valid = data.filter((v): v is number => v != null);
  if (valid.length < 2) return <View style={{ width, height }} />;

  const min = Math.min(...valid);
  const max = Math.max(...valid);
  const range = Math.max(max - min, 1e-6);
  const pad = strokeWidth + 1;
  const step = width / Math.max(data.length - 1, 1);

  const pts: Array<readonly [number, number]> = [];
  data.forEach((v, i) => {
    if (v == null) return;
    pts.push([i * step, pad + (height - 2 * pad) * (1 - (v - min) / range)] as const);
  });
  const line = pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const last = pts[pts.length - 1];
  const gid = `spk_${color.replace('#', '')}_${Math.round(width)}_${Math.round(height)}`;
  const area = `${pts[0][0].toFixed(1)},${height} ${line} ${last[0].toFixed(1)},${height}`;

  return (
    <Svg width={width} height={height}>
      {fill && (
        <Defs>
          <LinearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={color} stopOpacity={0.3} />
            <Stop offset="1" stopColor={color} stopOpacity={0} />
          </LinearGradient>
        </Defs>
      )}
      {fill && <Polygon points={area} fill={`url(#${gid})`} />}
      <Polyline points={line} fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinejoin="round" strokeLinecap="round" />
      {dot && last && <Circle cx={last[0]} cy={last[1]} r={strokeWidth + 0.6} fill={color} />}
    </Svg>
  );
}
