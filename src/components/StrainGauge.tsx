import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import Svg, { Circle } from 'react-native-svg';
import { colors } from '../theme';

interface Props {
  strain: number | null; // 0..21
  size?: number;
  max?: number;
}

// A 270° gauge (gap at the bottom) on the 0–21 strain scale.
export default function StrainGauge({ strain, size = 150, max = 21 }: Props) {
  const stroke = 12;
  const r = (size - stroke) / 2;
  const cx = size / 2;
  const circumference = 2 * Math.PI * r;
  const sweep = 0.75; // 270°
  const arc = sweep * circumference;
  const progress = strain != null ? Math.min(1, Math.max(0, strain / max)) : 0;
  const dashOffset = arc * (1 - progress);

  return (
    <View style={styles.container}>
      <Svg width={size} height={size}>
        {/* Track: a 270° arc, rotated so the gap sits at the bottom. */}
        <Circle
          cx={cx} cy={cx} r={r}
          stroke={colors.surfaceAlt} strokeWidth={stroke} fill="none"
          strokeDasharray={`${arc} ${circumference}`}
          strokeLinecap="round"
          rotation="135"
          origin={`${cx}, ${cx}`}
        />
        {progress > 0 && (
          <Circle
            cx={cx} cy={cx} r={r}
            stroke={colors.strain} strokeWidth={stroke} fill="none"
            strokeDasharray={`${arc} ${circumference}`}
            strokeDashoffset={dashOffset}
            strokeLinecap="round"
            rotation="135"
            origin={`${cx}, ${cx}`}
          />
        )}
      </Svg>
      <View style={[styles.label, { width: size, height: size }]}>
        <Text style={[styles.value, { color: strain != null ? colors.text : colors.textGhost }]}>
          {strain != null ? (Math.round(strain * 10) / 10).toFixed(1) : '--'}
        </Text>
        <Text style={styles.sub}>STRAIN</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { position: 'relative', alignItems: 'center', justifyContent: 'center' },
  label: { position: 'absolute', alignItems: 'center', justifyContent: 'center' },
  value: { fontSize: 40, fontWeight: '700', lineHeight: 44 },
  sub: { fontSize: 10, color: colors.textFaint, letterSpacing: 2, marginTop: 2 },
});
