import React, { useEffect, useState, useCallback } from 'react';
import { View, Text, ScrollView, StyleSheet, useWindowDimensions, AppState, RefreshControl } from 'react-native';
import { Pedometer } from 'expo-sensors';
import RecoveryRing from '../components/RecoveryRing';
import StrainGauge from '../components/StrainGauge';
import MetricCard from '../components/MetricCard';
import HRChart from '../components/HRChart';
import { useBleContext } from '../ble/BleContext';
import { getDailyHistory, rollupAllDays, DailyRow } from '../storage/db';
import { deviation, MIN_NIGHTS_SEED } from '../metrics/baselines';
import { getProfile } from '../storage/settings';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, spacing, radii } from '../theme';

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

export default function HomeScreen() {
  const { heartRate, hrv, state, calories, hrBuffer60 } = useBleContext();
  const [rows, setRows] = useState<DailyRow[]>([]);
  const [steps, setSteps] = useState<number | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [profileComplete, setProfileComplete] = useState(true);
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();

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
  const liveMode = hrv != null; // connected & a live HRV reading is available
  const displayHrv = hrv ?? featured?.rmssd ?? null;
  const rhr = featured?.rhr ?? null;
  const resp = featured?.resp_rate ?? null;
  const displayCalories = featured?.calories ?? (calories > 0 ? calories : null);

  // Deviation vs baseline is only meaningful once the baseline is usable (≥4 nights). During
  // calibration the spread sits at its floor and z-scores explode (the bogus "24.8σ"), so suppress
  // them. The HRV caption is also suppressed in live mode (a live reading vs a nightly baseline is
  // apples-to-oranges) — the card then just reads "live".
  const baselineUsable = featured?.recovery_state === 'provisional' || featured?.recovery_state === 'trusted';
  const hrvZ = !liveMode && baselineUsable && featured ? devZ(featured.rmssd, featured.hrv_baseline, featured.hrv_spread) : null;
  const rhrZ = baselineUsable && featured ? devZ(featured.rhr, featured.rhr_baseline, featured.rhr_spread) : null;

  const priorValid = featured ? rows.filter(r => r.rmssd != null && r.date < featured.date).length : 0;
  const calibrating = recovery == null && priorValid < MIN_NIGHTS_SEED ? { n: priorValid, seed: MIN_NIGHTS_SEED } : null;

  const sleepStr = fmtSleep(featured?.sleep_minutes);
  const effRounded = featured?.sleep_efficiency != null ? Math.round(featured.sleep_efficiency * 100) : null;
  const effPct = effRounded != null && effRounded < 99 ? `${effRounded}% efficiency` : undefined;
  const chartWidth = width - 76;

  return (
    <ScrollView
      style={styles.scroll}
      contentContainerStyle={[styles.content, { paddingTop: insets.top + spacing.sm }]}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.textFaint} />}
    >
      <View style={styles.titleRow}>
        <Text style={styles.title}>{isMorningView ? 'Yesterday' : 'Today'}</Text>
        {isMorningView && <Text style={styles.morningBadge}>morning view</Text>}
      </View>

      {!profileComplete && (
        <View style={styles.profileBanner}>
          <Text style={styles.profileBannerText}>
            Add your date of birth, weight &amp; sex in <Text style={styles.profileBannerBold}>Settings</Text> for accurate calories, strain &amp; HR zones.
          </Text>
        </View>
      )}

      <View style={styles.hero}>
        <RecoveryRing score={recovery} size={150} calibrating={calibrating} />
        <StrainGauge strain={strain} size={150} />
      </View>

      <View style={styles.row}>
        <MetricCard label="HRV (RMSSD)" value={displayHrv != null ? Math.round(displayHrv) : null} unit="ms" z={hrvZ} goodWhen="higher" sub={liveMode ? 'live' : undefined} />
        <MetricCard label="RESTING HR" value={rhr != null ? Math.round(rhr) : null} unit="bpm" z={rhrZ} goodWhen="lower" />
      </View>

      <View style={styles.row}>
        <MetricCard label="HEART RATE" value={heartRate ?? (rhr != null ? Math.round(rhr) : null)} unit="bpm" sub={heartRate != null ? 'live' : undefined} />
        <MetricCard label="RESP RATE" value={resp != null ? (Math.round(resp * 10) / 10) : null} unit="br/min" />
      </View>

      <View style={styles.row}>
        <MetricCard label="SLEEP" value={sleepStr} sub={effPct} />
        <MetricCard label="CALORIES" value={displayCalories != null ? Math.round(displayCalories) : null} unit="kcal" />
      </View>

      <View style={styles.row}>
        <MetricCard label="STEPS" value={steps != null ? steps.toLocaleString() : null} sub="today" />
        <View style={{ flex: 1, margin: 6 }} />
      </View>

      {hrBuffer60.length > 4 && (
        <View style={styles.chartBox}>
          <Text style={styles.chartLabel}>LIVE HR</Text>
          <HRChart data={hrBuffer60} width={chartWidth} height={56} />
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
  hero: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-evenly', marginVertical: spacing.lg },
  row: { flexDirection: 'row', marginBottom: spacing.sm },
  chartBox: { backgroundColor: colors.surface, borderRadius: radii.lg, padding: spacing.lg, margin: 6, marginTop: spacing.sm },
  chartLabel: { fontSize: 11, color: colors.textFaint, letterSpacing: 1.5, marginBottom: 10 },
  hint: { textAlign: 'center', color: colors.textGhost, fontSize: 13, marginTop: spacing.xxl },
});
