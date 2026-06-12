import React, { useState, useEffect } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, TextInput, Alert, ScrollView } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { useBleContext } from '../ble/BleContext';
import { getDailyHistory, getSampleCount, getAllSamples } from '../storage/db';
import { getProfile, setProfile, ageFromDob, type Sex } from '../storage/settings';
import { tanakaHRmax } from '../metrics/strain';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, spacing, radii } from '../theme';

const WRIST_KEY = '@whoomp/wrist';

// Visible build marker — bump on every install so a new build is confirmable at a glance
// (the app has no other version cue and same-version reinstalls look identical).
const BUILD_TAG = 'build 2 · engine v6 (aggregate night + RSA resp)';

export default function SettingsScreen() {
  const { state, disconnect } = useBleContext();
  const [dob, setDob] = useState('');
  const [sex, setSex] = useState<Sex>('M');
  const [weight, setWeight] = useState('');
  const [height, setHeight] = useState('');
  const [wrist, setWrist] = useState<'left' | 'right'>('left');
  const [sampleCount, setSampleCount] = useState<number | null>(null);
  const [exporting, setExporting] = useState(false);
  const insets = useSafeAreaInsets();

  useEffect(() => {
    getProfile().then(p => {
      setDob(p.dob);
      setSex(p.sex);
      setWeight(p.weightKg != null ? String(p.weightKg) : '');
      setHeight(p.heightCm != null ? String(p.heightCm) : '');
    }).catch(() => {});
    AsyncStorage.getItem(WRIST_KEY).then(v => { if (v === 'right') setWrist('right'); }).catch(() => {});
    getSampleCount().then(setSampleCount).catch(() => {});
  }, []);

  const saveDob = (v: string) => { setDob(v); if (/^\d{4}-\d{2}-\d{2}$/.test(v)) setProfile({ dob: v }).catch(() => {}); };
  const saveSex = (v: Sex) => { setSex(v); setProfile({ sex: v }).catch(() => {}); };
  const saveWeight = (v: string) => { setWeight(v); const n = parseFloat(v); setProfile({ weightKg: Number.isFinite(n) ? n : null }).catch(() => {}); };
  const saveHeight = (v: string) => { setHeight(v); const n = parseFloat(v); setProfile({ heightCm: Number.isFinite(n) ? n : null }).catch(() => {}); };
  const saveWrist = (v: 'left' | 'right') => { setWrist(v); AsyncStorage.setItem(WRIST_KEY, v).catch(() => {}); };

  const age = ageFromDob(dob);
  const tanaka = age != null ? Math.round(tanakaHRmax(age)) : null;

  const writeAndShare = async (filename: string, csv: string) => {
    const dir = FileSystem.cacheDirectory;
    if (!dir) throw new Error('no cache directory');
    const uri = dir + filename;
    await FileSystem.writeAsStringAsync(uri, csv, { encoding: FileSystem.EncodingType.UTF8 });
    if (!(await Sharing.isAvailableAsync())) { Alert.alert('Sharing is not available on this device'); return; }
    await Sharing.shareAsync(uri, { mimeType: 'text/csv', UTI: 'public.comma-separated-values-text', dialogTitle: 'Whoomp data export' });
  };

  const exportDaily = async () => {
    setExporting(true);
    try {
      const rows = await getDailyHistory(60);
      const csv = [
        'date,recovery_pct,recovery_state,rmssd_ms,resting_hr_bpm,resp_br_min,strain,calories_kcal,sleep_minutes,sleep_efficiency,deep_min,rem_min,light_min,awake_min',
        ...rows.map(r => [
          r.date, r.recovery ?? '', r.recovery_state ?? '', r.rmssd ?? '', r.rhr ?? '', r.resp_rate ?? '',
          r.strain ?? '', r.calories ?? '', r.sleep_minutes ?? '', r.sleep_efficiency ?? '',
          r.deep_min ?? '', r.rem_min ?? '', r.light_min ?? '', r.awake_min ?? '',
        ].join(',')),
      ].join('\n');
      await writeAndShare('whoomp-daily.csv', csv);
    } catch { Alert.alert('Export failed'); } finally { setExporting(false); }
  };

  const exportSamples = async () => {
    setExporting(true);
    try {
      const rows = await getAllSamples();
      const csv = [
        'unix,iso_utc,hr_bpm,rr_intervals_ms,source,gx,gy,gz,resp_raw,skin_contact',
        ...rows.map(r => [
          r.unix, new Date(r.unix * 1000).toISOString(), r.hr ?? '',
          r.rr_json ? (JSON.parse(r.rr_json) as number[]).join('|') : '', r.source ?? '',
          r.gx ?? '', r.gy ?? '', r.gz ?? '', r.resp_raw ?? '', r.skin_contact ?? '',
        ].join(',')),
      ].join('\n');
      await writeAndShare('whoomp-samples.csv', csv);
    } catch { Alert.alert('Export failed'); } finally { setExporting(false); }
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={[styles.content, { paddingTop: insets.top + spacing.sm }]}>
      <Text style={styles.title}>Settings</Text>

      <View style={styles.section}>
        <Text style={styles.sectionLabel}>BODY</Text>
        <View style={styles.fieldRow}>
          <View style={styles.field}>
            <Text style={styles.fieldLabel}>Date of birth</Text>
            <TextInput style={styles.input} value={dob} onChangeText={saveDob} placeholder="YYYY-MM-DD" placeholderTextColor={colors.textGhost} maxLength={10} autoCapitalize="none" />
          </View>
          <View style={styles.field}>
            <Text style={styles.fieldLabel}>Sex</Text>
            <View style={styles.segmented}>
              {(['M', 'F'] as const).map(s => (
                <TouchableOpacity key={s} style={[styles.segSm, sex === s && styles.segActive]} onPress={() => saveSex(s)}>
                  <Text style={[styles.segText, sex === s && styles.segTextActive]}>{s === 'M' ? 'Male' : 'Female'}</Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>
        </View>
        <View style={styles.fieldRow}>
          <View style={styles.field}>
            <Text style={styles.fieldLabel}>Weight (kg)</Text>
            <TextInput style={styles.input} value={weight} onChangeText={saveWeight} keyboardType="decimal-pad" maxLength={5} placeholder="kg" placeholderTextColor={colors.textGhost} />
          </View>
          <View style={styles.field}>
            <Text style={styles.fieldLabel}>Height (cm)</Text>
            <TextInput style={styles.input} value={height} onChangeText={saveHeight} keyboardType="decimal-pad" maxLength={5} placeholder="cm" placeholderTextColor={colors.textGhost} />
          </View>
        </View>
        <Text style={styles.hint}>
          {age != null ? `Age ${age} · ` : ''}{tanaka != null ? `Tanaka max HR ${tanaka} bpm` : 'Set DOB for age-based max HR'} · drives calories, strain & zones
        </Text>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionLabel}>WRIST</Text>
        <View style={styles.segmented}>
          {(['left', 'right'] as const).map(w => (
            <TouchableOpacity key={w} style={[styles.seg, wrist === w && styles.segActive]} onPress={() => saveWrist(w)}>
              <Text style={[styles.segText, wrist === w && styles.segTextActive]}>{w.charAt(0).toUpperCase() + w.slice(1)}</Text>
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
        {sampleCount != null && <Text style={styles.dataLine}>{sampleCount.toLocaleString()} samples stored</Text>}
        <TouchableOpacity style={[styles.outlineBtn, { marginTop: 12 }, exporting && styles.btnDisabled]} onPress={exportSamples} disabled={exporting}>
          <Text style={styles.outlineBtnText}>{exporting ? 'Exporting…' : 'Export all samples (CSV)'}</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[styles.outlineBtn, { marginTop: 10 }, exporting && styles.btnDisabled]} onPress={exportDaily} disabled={exporting}>
          <Text style={styles.outlineBtnText}>Export daily summary (CSV)</Text>
        </TouchableOpacity>
      </View>

      <Text style={styles.buildTag}>{BUILD_TAG}</Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.xl, paddingBottom: 40 },
  title: { fontSize: 28, fontWeight: '700', color: colors.text, marginBottom: spacing.xxl },
  section: { marginBottom: spacing.xxl },
  sectionLabel: { fontSize: 11, color: colors.textFaint, letterSpacing: 1.5, marginBottom: spacing.md },
  fieldRow: { flexDirection: 'row', gap: spacing.md, marginBottom: spacing.md },
  field: { flex: 1 },
  fieldLabel: { fontSize: 12, color: colors.textDim, marginBottom: 6 },
  input: { backgroundColor: colors.surface, color: colors.text, fontSize: 17, fontWeight: '600', padding: 12, borderRadius: radii.md, borderWidth: 1, borderColor: colors.border },
  hint: { fontSize: 12, color: colors.textFaint, marginTop: spacing.sm },
  segmented: { flexDirection: 'row', gap: spacing.sm },
  seg: { paddingHorizontal: 24, paddingVertical: 12, borderRadius: radii.md, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
  segSm: { flex: 1, alignItems: 'center', paddingVertical: 12, borderRadius: radii.md, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
  segActive: { backgroundColor: colors.text, borderColor: colors.text },
  segText: { fontSize: 15, color: colors.textFaint, fontWeight: '600' },
  segTextActive: { color: colors.bg },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 12 },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.textGhost },
  dotGreen: { backgroundColor: colors.green },
  statusText: { fontSize: 14, color: colors.textDim, textTransform: 'capitalize' },
  outlineBtn: { borderWidth: 1, borderColor: colors.border, paddingVertical: 12, paddingHorizontal: 24, borderRadius: radii.md, alignSelf: 'flex-start' },
  outlineBtnText: { fontSize: 14, color: colors.textDim },
  btnDisabled: { opacity: 0.4 },
  dataLine: { fontSize: 14, color: colors.textFaint },
  buildTag: { fontSize: 11, color: colors.textGhost, textAlign: 'center', marginTop: spacing.md },
});
