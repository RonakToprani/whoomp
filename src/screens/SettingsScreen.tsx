import React, { useState, useEffect } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, TextInput, Alert } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { useBleContext } from '../ble/BleContext';
import { getDailyHistory, getSampleCount, getAllSamples } from '../storage/db';

const AGE_KEY = '@whoomp/age';
const WRIST_KEY = '@whoomp/wrist';

export default function SettingsScreen() {
  const { state, disconnect } = useBleContext();
  const [age, setAge] = useState('');
  const [wrist, setWrist] = useState<'left' | 'right'>('left');
  const [sampleCount, setSampleCount] = useState<number | null>(null);

  useEffect(() => {
    AsyncStorage.getItem(AGE_KEY).then(v => { if (v) setAge(v); }).catch(() => {});
    AsyncStorage.getItem(WRIST_KEY).then(v => { if (v === 'right') setWrist('right'); }).catch(() => {});
    getSampleCount().then(setSampleCount).catch(() => {});
  }, []);

  const saveAge = (val: string) => {
    setAge(val);
    AsyncStorage.setItem(AGE_KEY, val).catch(() => {});
  };

  const saveWrist = (val: 'left' | 'right') => {
    setWrist(val);
    AsyncStorage.setItem(WRIST_KEY, val).catch(() => {});
  };

  const [exporting, setExporting] = useState(false);

  const writeAndShare = async (filename: string, csv: string) => {
    const dir = FileSystem.cacheDirectory;
    if (!dir) throw new Error('no cache directory');
    const uri = dir + filename;
    await FileSystem.writeAsStringAsync(uri, csv, { encoding: FileSystem.EncodingType.UTF8 });
    if (!(await Sharing.isAvailableAsync())) {
      Alert.alert('Sharing is not available on this device');
      return;
    }
    await Sharing.shareAsync(uri, {
      mimeType: 'text/csv',
      UTI: 'public.comma-separated-values-text',
      dialogTitle: 'Whoomp data export',
    });
  };

  const exportDaily = async () => {
    setExporting(true);
    try {
      const rows = await getDailyHistory(30);
      const csv = [
        'date,rmssd_ms,resting_hr_bpm,strain,recovery_pct,calories_kcal,sleep_minutes',
        ...rows.map(r =>
          [r.date, r.rmssd ?? '', r.rhr ?? '', r.strain ?? '', r.recovery ?? '', r.calories ?? '', r.sleep_minutes ?? ''].join(',')
        ),
      ].join('\n');
      await writeAndShare('whoomp-daily.csv', csv);
    } catch {
      Alert.alert('Export failed');
    } finally {
      setExporting(false);
    }
  };

  const exportSamples = async () => {
    setExporting(true);
    try {
      const rows = await getAllSamples();
      const csv = [
        'unix,iso_utc,hr_bpm,rr_intervals_ms,source',
        ...rows.map(r => [
          r.unix,
          new Date(r.unix * 1000).toISOString(),
          r.hr ?? '',
          r.rr_json ? (JSON.parse(r.rr_json) as number[]).join('|') : '',
          r.source ?? '',
        ].join(',')),
      ].join('\n');
      await writeAndShare('whoomp-samples.csv', csv);
    } catch {
      Alert.alert('Export failed');
    } finally {
      setExporting(false);
    }
  };

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Settings</Text>

      <View style={styles.section}>
        <Text style={styles.sectionLabel}>AGE</Text>
        <TextInput
          style={styles.input}
          value={age}
          onChangeText={saveAge}
          keyboardType="number-pad"
          maxLength={3}
          placeholder="30"
          placeholderTextColor="#333"
        />
        <Text style={styles.hint}>Used for max HR and strain estimates</Text>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionLabel}>WRIST</Text>
        <View style={styles.segmented}>
          {(['left', 'right'] as const).map(w => (
            <TouchableOpacity
              key={w}
              style={[styles.seg, wrist === w && styles.segActive]}
              onPress={() => saveWrist(w)}
            >
              <Text style={[styles.segText, wrist === w && styles.segTextActive]}>
                {w.charAt(0).toUpperCase() + w.slice(1)}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionLabel}>CONNECTION</Text>
        <View style={styles.statusRow}>
          <View style={[styles.dot, state === 'connected' && styles.dotGreen]} />
          <Text style={styles.statusText}>{state}</Text>
        </View>
        {state === 'connected' && (
          <TouchableOpacity style={styles.outlineBtn} onPress={() => disconnect()}>
            <Text style={styles.outlineBtnText}>Disconnect</Text>
          </TouchableOpacity>
        )}
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionLabel}>DATA</Text>
        {sampleCount != null && (
          <Text style={styles.dataLine}>{sampleCount.toLocaleString()} samples stored</Text>
        )}
        <TouchableOpacity
          style={[styles.outlineBtn, { marginTop: 12 }, exporting && styles.btnDisabled]}
          onPress={exportSamples}
          disabled={exporting}
        >
          <Text style={styles.outlineBtnText}>{exporting ? 'Exporting…' : 'Export all samples (CSV)'}</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.outlineBtn, { marginTop: 10 }, exporting && styles.btnDisabled]}
          onPress={exportDaily}
          disabled={exporting}
        >
          <Text style={styles.outlineBtnText}>Export daily summary (CSV)</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000', padding: 24 },
  title: { fontSize: 28, fontWeight: '700', color: '#fff', marginBottom: 32 },
  section: { marginBottom: 32 },
  sectionLabel: { fontSize: 11, color: '#555', letterSpacing: 1.5, marginBottom: 12 },
  input: {
    backgroundColor: '#111', color: '#fff', fontSize: 20, fontWeight: '600',
    padding: 14, borderRadius: 10, width: 100,
  },
  hint: { fontSize: 12, color: '#333', marginTop: 8 },
  segmented: { flexDirection: 'row', gap: 8 },
  seg: {
    paddingHorizontal: 24, paddingVertical: 12, borderRadius: 10,
    backgroundColor: '#111', borderWidth: 1, borderColor: '#222',
  },
  segActive: { backgroundColor: '#fff', borderColor: '#fff' },
  segText: { fontSize: 16, color: '#555', fontWeight: '600' },
  segTextActive: { color: '#000' },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 12 },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#444' },
  dotGreen: { backgroundColor: '#4ade80' },
  statusText: { fontSize: 14, color: '#888', textTransform: 'capitalize' },
  outlineBtn: {
    borderWidth: 1, borderColor: '#333', paddingVertical: 12, paddingHorizontal: 24,
    borderRadius: 10, alignSelf: 'flex-start',
  },
  outlineBtnText: { fontSize: 14, color: '#888' },
  btnDisabled: { opacity: 0.4 },
  dataLine: { fontSize: 14, color: '#555' },
});
