import React, { useEffect, useState, useCallback } from 'react';
import { View, Text, ScrollView, StyleSheet, useWindowDimensions, AppState, RefreshControl } from 'react-native';
import RecoveryRing from '../components/RecoveryRing';
import MetricCard from '../components/MetricCard';
import HRChart from '../components/HRChart';
import { useBleContext } from '../ble/BleContext';
import { getDailyHistory, DailyRow } from '../storage/db';

function hrvQuality(ms: number): { label: string; color: string } {
  if (ms >= 80) return { label: 'Excellent', color: '#4ade80' };
  if (ms >= 60) return { label: 'Above avg', color: '#86efac' };
  if (ms >= 40) return { label: 'Average', color: '#fbbf24' };
  if (ms >= 20) return { label: 'Below avg', color: '#f97316' };
  return { label: 'Low', color: '#f87171' };
}

export default function HomeScreen() {
  const { heartRate, hrv, rr, state, calories } = useBleContext();
  const [today, setToday] = useState<DailyRow | null>(null);
  const [yesterday, setYesterday] = useState<DailyRow | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const { width } = useWindowDimensions();

  const refresh = useCallback(async () => {
    try {
      const rows = await getDailyHistory(2);
      const todayStr = new Date().toISOString().slice(0, 10);
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
    return () => sub.remove();
  }, [refresh]);

  useEffect(() => { refresh(); }, [state, refresh]);

  const featured = (today?.rmssd != null || today?.rhr != null) ? today : yesterday;
  const isMorningView = featured === yesterday && yesterday != null;

  const displayHrv = hrv ?? featured?.rmssd ?? null;
  const recovery = featured?.recovery ?? null;
  const strain = featured?.strain ?? null;
  const rhr = featured?.rhr ?? null;

  const liveHrSlice: (number | null)[] = rr.slice(-300).map(ms =>
    ms > 0 ? Math.round(60000 / ms) : null
  );
  const chartWidth = width - 48;

  const qual = displayHrv != null && recovery == null ? hrvQuality(displayHrv) : null;

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
        {qual && (
          <View style={[styles.qualBadge, { borderColor: qual.color }]}>
            <Text style={[styles.qualText, { color: qual.color }]}>{qual.label}</Text>
          </View>
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

      {calories > 0 && (
        <View style={styles.row}>
          <MetricCard label="CALORIES" value={Math.round(calories)} unit="kcal" />
        </View>
      )}

      {liveHrSlice.length > 4 && (
        <View style={styles.chartBox}>
          <Text style={styles.chartLabel}>LIVE HR</Text>
          <HRChart data={liveHrSlice} width={chartWidth} height={56} />
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
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 24, flexWrap: 'wrap' },
  title: { fontSize: 28, fontWeight: '700', color: '#fff' },
  morningBadge: {
    fontSize: 11, color: '#555', letterSpacing: 1,
    borderWidth: 1, borderColor: '#222', borderRadius: 6,
    paddingHorizontal: 8, paddingVertical: 3,
  },
  qualBadge: {
    borderWidth: 1, borderRadius: 6,
    paddingHorizontal: 8, paddingVertical: 3,
  },
  qualText: { fontSize: 11, fontWeight: '600', letterSpacing: 0.5 },
  ringRow: { alignItems: 'center', marginBottom: 24 },
  row: { flexDirection: 'row', marginBottom: 8 },
  chartBox: {
    backgroundColor: '#111', borderRadius: 14,
    padding: 16, margin: 6, marginTop: 8,
  },
  chartLabel: { fontSize: 11, color: '#555', letterSpacing: 1.5, marginBottom: 10 },
  hint: { textAlign: 'center', color: '#333', fontSize: 13, marginTop: 32 },
});
