import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import Svg, { Circle } from 'react-native-svg';
import { colors, recoveryColor } from '../theme';

interface Props {
  score: number | null;
  size?: number;
  /** When score is null but the baseline is still seeding: { n, seed } drives an honest progress state. */
  calibrating?: { n: number; seed: number } | null;
}

export default function RecoveryRing({ score, size = 180, calibrating = null }: Props) {
  const stroke = 14;
  const r = (size - stroke) / 2;
  const cx = size / 2;
  const circumference = 2 * Math.PI * r;

  const isCalibrating = score == null && calibrating != null;
  const progress = score != null
    ? Math.min(100, Math.max(0, score)) / 100
    : isCalibrating
      ? Math.min(1, calibrating!.n / calibrating!.seed)
      : 0;
  const color = score != null ? recoveryColor(score) : isCalibrating ? colors.textDim : colors.textGhost;
  const dashOffset = circumference * (1 - progress);

  return (
    <View style={styles.container}>
      <Svg width={size} height={size}>
        <Circle cx={cx} cy={cx} r={r} stroke={colors.surfaceAlt} strokeWidth={stroke} fill="none" />
        {progress > 0 && (
          <Circle
            cx={cx} cy={cx} r={r}
            stroke={color} strokeWidth={stroke} fill="none"
            strokeDasharray={`${circumference} ${circumference}`}
            strokeDashoffset={dashOffset}
            strokeLinecap="round"
            rotation="-90"
            origin={`${cx}, ${cx}`}
          />
        )}
      </Svg>
      <View style={[styles.label, { width: size, height: size }]}>
        {isCalibrating ? (
          <>
            <Text style={styles.calMain}>{calibrating!.n}/{calibrating!.seed}</Text>
            <Text style={styles.calSub}>CALIBRATING</Text>
          </>
        ) : (
          <>
            <Text style={[styles.score, { color }]}>{score != null ? Math.round(score) : '--'}</Text>
            <Text style={styles.sub}>RECOVERY{score != null ? '  %' : ''}</Text>
          </>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { position: 'relative', alignItems: 'center', justifyContent: 'center' },
  label: { position: 'absolute', alignItems: 'center', justifyContent: 'center' },
  score: { fontSize: 52, fontWeight: '700', lineHeight: 56 },
  sub: { fontSize: 11, color: colors.textFaint, letterSpacing: 2, marginTop: 2 },
  calMain: { fontSize: 40, fontWeight: '700', color: colors.textDim, lineHeight: 44 },
  calSub: { fontSize: 10, color: colors.textFaint, letterSpacing: 2, marginTop: 4 },
});
