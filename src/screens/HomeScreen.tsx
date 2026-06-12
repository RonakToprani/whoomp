import React, { useEffect, useState, useCallback } from 'react';
import { View, Text, ScrollView, StyleSheet, useWindowDimensions, AppState, RefreshControl } from 'react-native';
import { Pedometer } from 'expo-sensors';
import RecoveryRing from '../components/RecoveryRing';
import MetricCard from '../components/MetricCard';
import HRChart from '../components/HRChart';
import { useBleContext } from '../ble/BleContext';
import { getDailyHistory, rollupAllDays, DailyRow } from '../storage/db';

function localDateStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export default function HomeScreen() {
  const { heartRate, hrv, state, calories, hrBuffer60 } = useBleContext();
  const [today, setToday] = useState<DailyRow | null>(null);
  const [yesterday, setYesterday] = useState<DailyRow | null>(null);
  const [steps, setSteps] = useState<number | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const { width } = useWindowDimensions();

  // Steps: re-query the midnight→now total directly. watchStepCount() reports
  // steps since the subscription started (not since midnight), which is what
  // made the count collapse to small random values — so we don't use it.
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
      // Rebuild today's aggregates from raw samples before reading them back,
      // so the dashboard reflects data that arrived since the last roll-up.
      await rollupAllDays();
      const rows = await getDailyHistory(2);
      const todayStr = localDateStr(new Date());
      setToday(rows.find(r => r.date === todayStr) ?? null);
      setYesterday(rows.find(r => r.date !== todayStr) ?? null);
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

  const featured = (today?.rmssd != null || today?.rhr != null) ? today : yesterday;
  const isMorningView = featured === yesterday && yesterday != null;

  const displayHrv = hrv ?? featured?.rmssd ?? null;
  const recovery = featured?.recovery ?? null;
  const strain = featured?.strain ?? null;
  const rhr = featured?.rhr ?? null;
  // Day total from the roll-up; fall back to the live in-session counter.
  const displayCalories = featured?.calories ?? (calories > 0 ? calories : null);

  // content padding 16+16, chartBox margin 6+6, chartBox padding 16+16
  const chartWidth = width - 76;

  return (
    <ScrollView
      style={styles.scroll}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#555" />}
    >
      <View style={styles.titleRow}>
        <Text style={styles.title}>{isMorningView ? 'Yesterday' : 'Today'}</Text>
        {isMorningView && (
          <Text style={styles.morningBadge}>morning view</Text>
        )}
      </View>

      <View style={styles.ringRow}>
        <RecoveryRing score={recovery} size={180} />
      </View>

      <View style={styles.row}>
        <MetricCard label="HRV (RMSSD)" value={displayHrv != null ? Math.round(displayHrv) : null} unit="ms" />
        <MetricCard label="HEART RATE" value={heartRate ?? (featured?.rhr != null ? Math.round(featured.rhr) : null)} unit="bpm" />
      </View>

      <View style={styles.row}>
        <MetricCard label="RESTING HR" value={rhr != null ? Math.round(rhr) : null} unit="bpm" />
        <MetricCard label="STRAIN" value={strain != null ? (Math.round(strain * 10) / 10) : null} unit="/ 21" />
      </View>

      <View style={styles.row}>
        <MetricCard label="CALORIES" value={displayCalories != null ? Math.round(displayCalories) : null} unit="kcal" />
        <MetricCard label="STEPS" value={steps != null ? steps.toLocaleString() : null} unit="today" />
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
  scroll: { flex: 1, backgroundColor: '#000' },
  content: { padding: 16, paddingBottom: 40 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 24 },
  title: { fontSize: 28, fontWeight: '700', color: '#fff' },
  morningBadge: {
    fontSize: 11, color: '#555', letterSpacing: 1,
    borderWidth: 1, borderColor: '#222', borderRadius: 6,
    paddingHorizontal: 8, paddingVertical: 3,
  },
  ringRow: { alignItems: 'center', marginBottom: 24 },
  row: { flexDirection: 'row', marginBottom: 8 },
  chartBox: {
    backgroundColor: '#111', borderRadius: 14,
    padding: 16, margin: 6, marginTop: 8,
  },
  chartLabel: { fontSize: 11, color: '#555', letterSpacing: 1.5, marginBottom: 10 },
  hint: { textAlign: 'center', color: '#333', fontSize: 13, marginTop: 32 },
});
