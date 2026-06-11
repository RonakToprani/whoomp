import React, { useEffect } from 'react';
import {
  View, Text, TouchableOpacity, ActivityIndicator, StyleSheet,
} from 'react-native';
import { useBleContext } from '../ble/BleContext';

type Props = {
  navigation: { navigate: (screen: string) => void };
};

export default function ScanScreen({ navigation }: Props) {
  const { state, scan } = useBleContext();

  useEffect(() => {
    if (state === 'connected') {
      navigation.navigate('Live');
    }
  }, [state, navigation]);

  const isConnecting = state === 'connecting' || state === 'reconnecting';

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Whoomp</Text>
      <Text style={styles.warning}>Close the official WHOOP app first</Text>
      {isConnecting ? (
        <ActivityIndicator size="large" color="#fff" style={styles.spinner} />
      ) : (
        <TouchableOpacity style={styles.button} onPress={() => scan()}>
          <Text style={styles.buttonText}>Connect to WHOOP</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  title: {
    fontSize: 48,
    fontWeight: '700',
    color: '#fff',
    marginBottom: 16,
  },
  warning: {
    fontSize: 14,
    color: '#888',
    marginBottom: 48,
    textAlign: 'center',
  },
  button: {
    backgroundColor: '#fff',
    paddingHorizontal: 32,
    paddingVertical: 16,
    borderRadius: 12,
  },
  buttonText: {
    fontSize: 18,
    fontWeight: '600',
    color: '#000',
  },
  spinner: {
    marginTop: 16,
  },
});
