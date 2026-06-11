import React from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createStackNavigator } from '@react-navigation/stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { View, Text } from 'react-native';
import { BleProvider } from './src/ble/BleContext';
import { useBleContext } from './src/ble/BleContext';
import ScanScreen from './src/screens/ScanScreen';
import LiveScreen from './src/screens/LiveScreen';
import HomeScreen from './src/screens/HomeScreen';
import TrendsScreen from './src/screens/TrendsScreen';
import SleepScreen from './src/screens/SleepScreen';
import SettingsScreen from './src/screens/SettingsScreen';

const Stack = createStackNavigator();
const Tab = createBottomTabNavigator();

function TabIcon({ label, focused }: { label: string; focused: boolean }) {
  return (
    <Text style={{ fontSize: 11, color: focused ? '#fff' : '#555', letterSpacing: 0.5, marginTop: 2 }}>
      {label}
    </Text>
  );
}

function MainTabs() {
  return (
    <Tab.Navigator
      screenOptions={{
        headerShown: false,
        tabBarStyle: { backgroundColor: '#0a0a0a', borderTopColor: '#1a1a1a' },
        tabBarActiveTintColor: '#fff',
        tabBarInactiveTintColor: '#444',
        tabBarShowLabel: false,
      }}
    >
      <Tab.Screen
        name="Home"
        component={HomeScreen}
        options={{ tabBarIcon: ({ focused }) => <TabIcon label="HOME" focused={focused} /> }}
      />
      <Tab.Screen
        name="Live"
        component={LiveScreen}
        options={{ tabBarIcon: ({ focused }) => <TabIcon label="LIVE" focused={focused} /> }}
      />
      <Tab.Screen
        name="Trends"
        component={TrendsScreen}
        options={{ tabBarIcon: ({ focused }) => <TabIcon label="TRENDS" focused={focused} /> }}
      />
      <Tab.Screen
        name="Sleep"
        component={SleepScreen}
        options={{ tabBarIcon: ({ focused }) => <TabIcon label="SLEEP" focused={focused} /> }}
      />
      <Tab.Screen
        name="Settings"
        component={SettingsScreen}
        options={{ tabBarIcon: ({ focused }) => <TabIcon label="SETTINGS" focused={focused} /> }}
      />
    </Tab.Navigator>
  );
}

function RootNavigator() {
  const { state } = useBleContext();
  const isConnected = state === 'connected' || state === 'reconnecting';

  return (
    <Stack.Navigator screenOptions={{ headerShown: false }}>
      {isConnected ? (
        <Stack.Screen name="Main" component={MainTabs} />
      ) : (
        <Stack.Screen name="Scan" component={ScanScreen} />
      )}
    </Stack.Navigator>
  );
}

export default function App() {
  return (
    <BleProvider>
      <NavigationContainer>
        <RootNavigator />
      </NavigationContainer>
    </BleProvider>
  );
}
