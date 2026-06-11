import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import Svg, { Circle } from 'react-native-svg';

interface Props {
  score: number | null;
  size?: number;
}

function ringColor(score: number | null): string {
  if (score == null) return '#333';
  if (score >= 67) return '#4ade80'; // green
  if (score >= 34) return '#facc15'; // yellow
  return '#f87171';                  // red
}

export default function RecoveryRing({ score, size = 180 }: Props) {
  const stroke = 14;
  const r = (size - stroke) / 2;
  const cx = size / 2;
  const circumference = 2 * Math.PI * r;
  const progress = score != null ? Math.min(100, Math.max(0, score)) / 100 : 0;
  const dashOffset = circumference * (1 - progress);
  const color = ringColor(score);

  return (
    <View style={styles.container}>
      <Svg width={size} height={size}>
        <Circle
          cx={cx} cy={cx} r={r}
          stroke="#1a1a1a"
          strokeWidth={stroke}
          fill="none"
        />
        <Circle
          cx={cx} cy={cx} r={r}
          stroke={color}
          strokeWidth={stroke}
          fill="none"
          strokeDasharray={`${circumference} ${circumference}`}
          strokeDashoffset={dashOffset}
          strokeLinecap="round"
          rotation="-90"
          origin={`${cx}, ${cx}`}
        />
      </Svg>
      <View style={[styles.label, { width: size, height: size }]}>
        <Text style={[styles.score, { color }]}>
          {score != null ? Math.round(score) : '--'}
        </Text>
        <Text style={styles.sub}>RECOVERY</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { position: 'relative', alignItems: 'center', justifyContent: 'center' },
  label: {
    position: 'absolute',
    alignItems: 'center',
    justifyContent: 'center',
  },
  score: { fontSize: 52, fontWeight: '700', lineHeight: 56 },
  sub: { fontSize: 11, color: '#555', letterSpacing: 2, marginTop: 2 },
});
