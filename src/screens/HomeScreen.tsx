import React, { useEffect, useState, useCallback } from 'react';
import { View, Text, ScrollView, StyleSheet, useWindowDimensions, AppState, RefreshControl } from 'react-native';
import { Pedometer } from 'expo-sensors';
import RecoveryRing from '../components/RecoveryRing';
import MetricCard from '../components/MetricCard';
import HRChart from '../components/HRChart';
import { useBleContext } from '../ble/BleContext';
import { getDailyHistory, rollupAllDays, DailyRow } from '../storage/db';
import { deviation, MIN_NIGHTS_SEED } from '../metrics/baselines';
import { cToF } from '../metrics/skinTemp';
import { getProfile } from '../storage/settings';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, spacing, radii, metricColors, recoveryLabel, recoveryColor } from '../theme';

function localDateStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function devZ(value: number | null | undefined, base: number | null | undefined, spread: number | null | undefined): number | null {
  if (value == null || base == null || spread == null) return null;
  return deviation(value, { baseline: base, spread, nValid: 99, nightsSinceUpdate: 0, status: 'trusted' }).z;
}

function fmtSleep(min: number | null | undefined): string | null {
  if (min == null) return null;
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

// One-line readiness insight from the morning's recovery + last night's sleep.
function synthesisLine(recovery: number | null, sleepMin: number | null | undefined): string {
  if (recovery == null) return 'Calibrating your baseline — keep wearing the strap overnight.';
  const sleptWell = sleepMin != null && sleepMin >= 420;
  if (recovery >= 67) return sleptWell ? 'Recovery is strong and sleep was solid. Green light for strain.' : 'Recovery is strong — your body is primed for strain today.';
  if (recovery >= 34) return 'Recovery is moderate. Keep strain measured and prioritize sleep tonight.';
  return 'Recovery is low. Favor rest and active recovery today.';
}

export default function HomeScreen() {
  const { heartRate, hrv, state, calories, hrBuffer60 } = useBleContext();
  const [rows, setRows] = useState<DailyRow[]>([]);
  const [steps, setSteps] = useState<number | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [profileComplete, setProfileComplete] = useState(true);
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();

  useEffect(() => {
    getProfile().then(p => setProfileComplete(p.complete)).catch(() => {});
  }, [state]);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    const queryToday = () => {
      const start = new Date();
      start.setHours(0, 0, 0, 0);
      Pedometer.getStepCountAsync(start, new Date())
        .then(r => { if (!cancelled) setSteps(r.steps); })
        .catch(() => {});
    };
    Pedometer.isAvailableAsync().then(ok => {
      if (!ok || cancelled) return;
      queryToday();
      timer = setInterval(queryToday, 60_000);
    }).catch(() => {});
    const appSub = AppState.addEventListener('change', s => { if (s === 'active') queryToday(); });
    return () => { cancelled = true; if (timer) clearInterval(timer); appSub.remove(); };
  }, []);

  const refresh = useCallback(async () => {
    try {
      await rollupAllDays();
      setRows(await getDailyHistory(14));
    } catch {}
  }, []);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await refresh();
    setRefreshing(false);
  }, [refresh]);

  useEffect(() => {
    refresh();
    const sub = AppState.addEventListener('change', s => { if (s === 'active') refresh(); });
    const timer = setInterval(refresh, 60_000);
    return () => { sub.remove(); clearInterval(timer); };
  }, [refresh]);

  useEffect(() => { refresh(); }, [state, refresh]);

  const todayStr = localDateStr(new Date());
  const today = rows.find(r => r.date === todayStr) ?? null;
  const yesterday = rows.find(r => r.date !== todayStr) ?? null;
  const featured = (today?.rmssd != null || today?.rhr != null || today?.strain != null) ? today : yesterday;
  const isMorningView = featured === yesterday && yesterday != null && featured != null;

  const recovery = featured?.recovery ?? null;
  const strain = featured?.strain ?? null;
  const liveMode = hrv != null;
  const displayHrv = hrv ?? featured?.rmssd ?? null;
  const rhr = featured?.rhr ?? null;
  const resp = featured?.resp_rate ?? null;
  const displayCalories = featured?.calories ?? (calories > 0 ? calories : null);
  const skinF = cToF(featured?.skin_temp_c ?? null);

  const baselineUsable = featured?.recovery_state === 'provisional' || featured?.recovery_state === 'trusted';
  const hrvZ = !liveMode && baselineUsable && featured ? devZ(featured.rmssd, featured.hrv_baseline, featured.hrv_spread) : null;
  const rhrZ = baselineUsable && featured ? devZ(featured.rhr, featured.rhr_baseline, featured.rhr_spread) : null;

  const priorValid = featured ? rows.filter(r => r.rmssd != null && r.date < featured.date).length : 0;
  const calibrating = recovery == null && priorValid < MIN_NIGHTS_SEED ? { n: priorValid, seed: MIN_NIGHTS_SEED } : null;

  const sleepStr = fmtSleep(featured?.sleep_minutes);
  const effRounded = featured?.sleep_efficiency != null ? Math.round(featured.sleep_efficiency * 100) : null;
  const effPct = effRounded != null && effRounded < 99 ? `${effRounded}% eff` : undefined;

  // Oldest→newest series for the in-card sparklines.
  const asc = [...rows].reverse();
  const series = (get: (r: DailyRow) => number | null): (number | null)[] => asc.map(get);
  const skinFSeries = series(r => (r.skin_temp_c != null ? cToF(r.skin_temp_c) : null));

  const chartWidth = width - 76;

  return (
    <ScrollView
      style={styles.scroll}
      contentContainerStyle={[styles.content, { paddingTop: insets.top + spacing.sm }]}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.textFaint} />}
    >
      <Text style={styles.kicker}>{isMorningView ? 'THIS MORNING' : 'AT A GLANCE'}</Text>
      <View style={styles.titleRow}>
        <Text style={styles.title}>Control Center</Text>
        {isMorningView && <Text style={styles.morningBadge}>morning</Text>}
      </View>

      {!profileComplete && (
        <View style={styles.profileBanner}>
          <Text style={styles.profileBannerText}>
            Add your date of birth, weight &amp; sex in <Text style={styles.profileBannerBold}>Settings</Text> for accurate calories, strain &amp; HR zones.
          </Text>
        </View>
      )}

      {/* ── Today's Synthesis: recovery ring + readiness insight ── */}
      <View style={styles.synthCard}>
        <RecoveryRing score={recovery} size={132} calibrating={calibrating} />
        <View style={styles.synthText}>
          <Text style={styles.synthLabel}>RECOVERY</Text>
          <Text style={[styles.synthVerdict, { color: recoveryColor(recovery) }]}>{recoveryLabel(recovery)}</Text>
          <Text style={styles.synthInsight}>{synthesisLine(recovery, featured?.sleep_minutes)}</Text>
          {(displayHrv != null || rhr != null) && (
            <Text style={styles.synthVitals}>
              {displayHrv != null ? `HRV ${Math.round(displayHrv)} ms` : ''}
              {displayHrv != null && rhr != null ? '   ·   ' : ''}
              {rhr != null ? `RHR ${Math.round(rhr)}` : ''}
            </Text>
          )}
        </View>
      </View>

      {/* ── Key metrics grid (14-day sparklines) ── */}
      <View style={styles.sectionHead}>
        <Text style={styles.sectionLabel}>KEY METRICS</Text>
        <Text style={styles.sectionHint}>14-day trend</Text>
      </View>

      <View style={styles.row}>
        <MetricCard label="RECOVERY" value={recovery != null ? Math.round(recovery) : null} unit="%" accent={recoveryColor(recovery)} color={metricColors.recovery} trend={series(r => r.recovery)} />
        <MetricCard label="DAY STRAIN" value={strain != null ? (Math.round(strain * 10) / 10).toFixed(1) : null} sub="of 21" color={metricColors.strain} trend={series(r => r.strain)} />
      </View>
      <View style={styles.row}>
        <MetricCard label="SLEEP" value={sleepStr} sub={effPct} color={metricColors.sleep} trend={series(r => r.sleep_minutes)} />
        <MetricCard label="HRV (RMSSD)" value={displayHrv != null ? Math.round(displayHrv) : null} unit="ms" z={hrvZ} goodWhen="higher" sub={liveMode ? 'live' : undefined} color={metricColors.hrv} trend={series(r => r.rmssd)} />
      </View>
      <View style={styles.row}>
        <MetricCard label="RESTING HR" value={rhr != null ? Math.round(rhr) : null} unit="bpm" z={rhrZ} goodWhen="lower" color={metricColors.rhr} trend={series(r => r.rhr)} />
        <MetricCard label="RESPIRATORY" value={resp != null ? Math.round(resp * 10) / 10 : null} unit="rpm" color={metricColors.resp} trend={series(r => r.resp_rate ?? null)} />
      </View>
      <View style={styles.row}>
        <MetricCard label="SKIN TEMP" value={skinF != null ? (Math.round(skinF * 10) / 10).toFixed(1) : null} unit="°F" color={metricColors.skinTemp} trend={skinFSeries} />
        <MetricCard label="CALORIES" value={displayCalories != null ? Math.round(displayCalories) : null} unit="kcal" color={metricColors.calories} trend={series(r => r.calories)} />
      </View>
      <View style={styles.row}>
        <MetricCard label="STEPS" value={steps != null ? steps.toLocaleString() : null} sub="today" color={metricColors.steps} />
        <MetricCard label="HEART RATE" value={heartRate ?? (rhr != null ? Math.round(rhr) : null)} unit="bpm" sub={heartRate != null ? 'live' : undefined} color={metricColors.hr} />
      </View>

      {hrBuffer60.length > 4 && (
        <View style={styles.chartBox}>
          <Text style={styles.chartLabel}>LIVE HEART RATE</Text>
          <HRChart data={hrBuffer60} width={chartWidth} height={56} color={metricColors.hr} />
        </View>
      )}

      {state !== 'connected' && featured == null && (
        <Text style={styles.hint}>Connect to your WHOOP to see today's data</Text>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.lg, paddingBottom: 40 },
  kicker: { fontSize: 11, color: colors.textFaint, letterSpacing: 2, marginBottom: 2 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: spacing.lg },
  title: { fontSize: 28, fontWeight: '700', color: colors.text },
  morningBadge: {
    fontSize: 11, color: colors.textFaint, letterSpacing: 1,
    borderWidth: 1, borderColor: colors.border, borderRadius: radii.sm,
    paddingHorizontal: 8, paddingVertical: 3,
  },
  profileBanner: { backgroundColor: colors.surface, borderRadius: radii.md, borderWidth: 1, borderColor: colors.border, padding: spacing.md, marginBottom: spacing.sm },
  profileBannerText: { color: colors.textDim, fontSize: 13, lineHeight: 18 },
  profileBannerBold: { color: colors.text, fontWeight: '600' },

  synthCard: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.lg,
    backgroundColor: colors.surface, borderRadius: radii.xl, padding: spacing.lg, marginBottom: spacing.lg,
  },
  synthText: { flex: 1, gap: 4 },
  synthLabel: { fontSize: 11, color: colors.textFaint, letterSpacing: 2 },
  synthVerdict: { fontSize: 26, fontWeight: '800' },
  synthInsight: { fontSize: 13, color: colors.textDim, lineHeight: 18, marginTop: 2 },
  synthVitals: { fontSize: 12, color: colors.textFaint, marginTop: 6, fontVariant: ['tabular-nums'] },

  sectionHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: spacing.xs, marginLeft: 6 },
  sectionLabel: { fontSize: 13, color: colors.text, fontWeight: '700', letterSpacing: 1 },
  sectionHint: { fontSize: 11, color: colors.textFaint },
  row: { flexDirection: 'row' },
  chartBox: { backgroundColor: colors.surface, borderRadius: radii.lg, padding: spacing.lg, margin: 6, marginTop: spacing.md },
  chartLabel: { fontSize: 11, color: colors.textFaint, letterSpacing: 1.5, marginBottom: 10 },
  hint: { textAlign: 'center', color: colors.textGhost, fontSize: 13, marginTop: spacing.xxl },
});
