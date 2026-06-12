import React from 'react';
import { View, Text, TouchableOpacity, ActivityIndicator, StyleSheet } from 'react-native';
import { useBleContext } from '../ble/BleContext';
import { colors, spacing, radii } from '../theme';

export default function ScanScreen() {
  const { state, scan } = useBleContext();
  const isConnecting = state === 'connecting' || state === 'reconnecting';

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Whoomp</Text>
      <Text style={styles.tagline}>on-device recovery · strain · sleep</Text>
      <Text style={styles.warning}>Close the official WHOOP app first</Text>
      {isConnecting ? (
        <View style={styles.spinner}>
          <ActivityIndicator size="large" color={colors.text} />
          <Text style={styles.connecting}>{state === 'reconnecting' ? 'Reconnecting…' : 'Scanning…'}</Text>
        </View>
      ) : (
        <TouchableOpacity style={styles.button} onPress={() => scan()}>
          <Text style={styles.buttonText}>Connect to WHOOP</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
  title: { fontSize: 48, fontWeight: '700', color: colors.text, marginBottom: spacing.sm },
  tagline: { fontSize: 13, color: colors.textFaint, letterSpacing: 0.5, marginBottom: spacing.xl },
  warning: { fontSize: 14, color: colors.textDim, marginBottom: 48, textAlign: 'center' },
  button: { backgroundColor: colors.text, paddingHorizontal: 32, paddingVertical: 16, borderRadius: radii.md },
  buttonText: { fontSize: 18, fontWeight: '600', color: colors.bg },
  spinner: { alignItems: 'center', gap: spacing.md },
  connecting: { color: colors.textDim, fontSize: 14 },
});
