import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { useBleContext } from '../ble/BleContext';

type Props = {
  navigation: { navigate: (screen: string) => void };
};

export default function LiveScreen({ navigation }: Props) {
  const { heartRate, battery, hrv, disconnect } = useBleContext();

  const handleDisconnect = async () => {
    await disconnect();
    navigation.navigate('Scan');
  };

  return (
    <View style={styles.container}>
      {battery != null && (
        <Text style={styles.battery}>{Math.round(battery)}%</Text>
      )}
      <Text style={[styles.bpm, heartRate == null && styles.bpmNull]}>
        {heartRate ?? '--'}
      </Text>
      <Text style={styles.unit}>BPM</Text>
      <View style={styles.hrvRow}>
        <Text style={styles.hrvLabel}>HRV</Text>
        <Text style={[styles.hrvValue, hrv == null && styles.bpmNull]}>
          {hrv != null ? Math.round(hrv) : '--'}
        </Text>
        <Text style={styles.hrvUnit}>ms</Text>
      </View>
      <TouchableOpacity style={styles.button} onPress={handleDisconnect}>
        <Text style={styles.buttonText}>Disconnect</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000',
    alignItems: 'center',
    justifyContent: 'center',
  },
  battery: {
    position: 'absolute',
    top: 60,
    right: 24,
    fontSize: 16,
    color: '#888',
  },
  bpm: {
    fontSize: 120,
    fontWeight: '700',
    color: '#fff',
    lineHeight: 130,
  },
  bpmNull: {
    color: '#444',
  },
  unit: {
    fontSize: 24,
    color: '#888',
    marginTop: 4,
  },
  hrvRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    marginTop: 32,
    gap: 8,
  },
  hrvLabel: {
    fontSize: 14,
    color: '#666',
    letterSpacing: 1,
  },
  hrvValue: {
    fontSize: 40,
    fontWeight: '600',
    color: '#fff',
  },
  hrvUnit: {
    fontSize: 14,
    color: '#666',
  },
  button: {
    marginTop: 64,
    borderWidth: 1,
    borderColor: '#444',
    paddingHorizontal: 32,
    paddingVertical: 14,
    borderRadius: 12,
  },
  buttonText: {
    fontSize: 16,
    color: '#888',
  },
});
