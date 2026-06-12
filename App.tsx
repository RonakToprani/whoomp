import React from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createStackNavigator } from '@react-navigation/stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { colors } from './src/theme';
import { BleProvider, useBleContext } from './src/ble/BleContext';
import ScanScreen from './src/screens/ScanScreen';
import LiveScreen from './src/screens/LiveScreen';
import HomeScreen from './src/screens/HomeScreen';
import TrendsScreen from './src/screens/TrendsScreen';
import SleepScreen from './src/screens/SleepScreen';
import SettingsScreen from './src/screens/SettingsScreen';

const Stack = createStackNavigator();
const Tab = createBottomTabNavigator();

function MainTabs() {
  return (
    <Tab.Navigator
      screenOptions={{
        headerShown: false,
        tabBarStyle: { backgroundColor: colors.bg, borderTopColor: colors.borderFaint, height: 84, paddingBottom: 28, paddingTop: 8 },
        tabBarActiveTintColor: colors.text,
        tabBarInactiveTintColor: colors.textFaint,
        tabBarLabelStyle: { fontSize: 11, fontWeight: '600', letterSpacing: 0.3 },
        tabBarIconStyle: { display: 'none' },
      }}
    >
      <Tab.Screen name="Home" component={HomeScreen} />
      <Tab.Screen name="Live" component={LiveScreen} />
      <Tab.Screen name="Trends" component={TrendsScreen} />
      <Tab.Screen name="Sleep" component={SleepScreen} />
      <Tab.Screen name="Settings" component={SettingsScreen} />
    </Tab.Navigator>
  );
}

function RootNavigator() {
  const { state } = useBleContext();
  const isConnected = state === 'connected' || state === 'reconnecting';
  return (
    <Stack.Navigator screenOptions={{ headerShown: false }}>
      {isConnected
        ? <Stack.Screen name="Main" component={MainTabs} />
        : <Stack.Screen name="Scan" component={ScanScreen} />}
    </Stack.Navigator>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <BleProvider>
        <NavigationContainer>
          <RootNavigator />
        </NavigationContainer>
      </BleProvider>
    </SafeAreaProvider>
  );
}
