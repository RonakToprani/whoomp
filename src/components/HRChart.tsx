import React from 'react';
import { View, StyleSheet } from 'react-native';
import Svg, { Polyline } from 'react-native-svg';

interface Props {
  data: (number | null)[];
  width?: number;
  height?: number;
  color?: string;
}

export default function HRChart({ data, width = 300, height = 60, color = '#f87171' }: Props) {
  const valid = data.filter((v): v is number => v != null);
  if (valid.length < 2) return <View style={{ width, height }} />;

  const min = Math.min(...valid) - 5;
  const max = Math.max(...valid) + 5;
  const range = Math.max(max - min, 1);
  const step = width / (data.length - 1);

  const points = data
    .map((v, i) => {
      if (v == null) return null;
      const x = i * step;
      const y = height - ((v - min) / range) * height;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .filter(Boolean)
    .join(' ');

  return (
    <View style={[styles.container, { width, height }]}>
      <Svg width={width} height={height}>
        <Polyline points={points} fill="none" stroke={color} strokeWidth={1.5} />
      </Svg>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { overflow: 'hidden' },
});
