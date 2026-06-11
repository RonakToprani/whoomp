import React from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createStackNavigator } from '@react-navigation/stack';
import { BleProvider } from './src/ble/BleContext';
import ScanScreen from './src/screens/ScanScreen';
import LiveScreen from './src/screens/LiveScreen';

const Stack = createStackNavigator();

export default function App() {
  return (
    <BleProvider>
      <NavigationContainer>
        <Stack.Navigator initialRouteName="Scan" screenOptions={{ headerShown: false }}>
          <Stack.Screen name="Scan" component={ScanScreen} />
          <Stack.Screen name="Live" component={LiveScreen} />
        </Stack.Navigator>
      </NavigationContainer>
    </BleProvider>
  );
}
