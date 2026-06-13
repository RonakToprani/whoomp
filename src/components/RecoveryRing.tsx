import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import Svg, { Circle, Defs, LinearGradient, Stop } from 'react-native-svg';
import { colors, recoveryColor, recoveryLabel } from '../theme';

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
  const bandColor = score != null ? recoveryColor(score) : isCalibrating ? colors.textDim : colors.textGhost;
  // Colorful WHOOP-style arc: a red→amber→green gradient when scored, solid otherwise.
  const stroke2 = score != null ? `url(#recovGrad-${size})` : bandColor;
  const dashOffset = circumference * (1 - progress);

  return (
    <View style={styles.container}>
      <Svg width={size} height={size}>
        <Defs>
          <LinearGradient id={`recovGrad-${size}`} x1="0" y1="1" x2="1" y2="0">
            <Stop offset="0" stopColor={colors.red} />
            <Stop offset="0.5" stopColor={colors.yellow} />
            <Stop offset="1" stopColor={colors.green} />
          </LinearGradient>
        </Defs>
        <Circle cx={cx} cy={cx} r={r} stroke={colors.surfaceAlt} strokeWidth={stroke} fill="none" />
        {progress > 0 && (
          <Circle
            cx={cx} cy={cx} r={r}
            stroke={stroke2} strokeWidth={stroke} fill="none"
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
            <Text style={[styles.score, { color: bandColor }]}>{score != null ? Math.round(score) : '--'}</Text>
            <Text style={[styles.sub, score != null ? { color: bandColor, fontWeight: '700' } : null]}>
              {score != null ? recoveryLabel(score).toUpperCase() : 'RECOVERY'}
            </Text>
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
