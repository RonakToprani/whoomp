import React from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createStackNavigator } from '@react-navigation/stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { Text } from 'react-native';
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

function TabIcon({ emoji, label, focused }: { emoji: string; label: string; focused: boolean }) {
  return (
    <>
      <Text style={{ fontSize: 20, lineHeight: 24 }}>{emoji}</Text>
      <Text style={{ fontSize: 10, color: focused ? '#fff' : '#555', marginTop: 2, letterSpacing: 0.3 }}>
        {label}
      </Text>
    </>
  );
}

function MainTabs() {
  return (
    <Tab.Navigator
      screenOptions={{
        headerShown: false,
        tabBarStyle: { backgroundColor: '#0a0a0a', borderTopColor: '#1a1a1a', paddingBottom: 6, height: 64 },
        tabBarShowLabel: false,
      }}
    >
      <Tab.Screen
        name="Home"
        component={HomeScreen}
        options={{ tabBarIcon: ({ focused }) => <TabIcon emoji="🏠" label="Home" focused={focused} /> }}
      />
      <Tab.Screen
        name="Live"
        component={LiveScreen}
        options={{ tabBarIcon: ({ focused }) => <TabIcon emoji="❤️" label="Live" focused={focused} /> }}
      />
      <Tab.Screen
        name="Trends"
        component={TrendsScreen}
        options={{ tabBarIcon: ({ focused }) => <TabIcon emoji="📈" label="Trends" focused={focused} /> }}
      />
      <Tab.Screen
        name="Sleep"
        component={SleepScreen}
        options={{ tabBarIcon: ({ focused }) => <TabIcon emoji="🌙" label="Sleep" focused={focused} /> }}
      />
      <Tab.Screen
        name="Settings"
        component={SettingsScreen}
        options={{ tabBarIcon: ({ focused }) => <TabIcon emoji="⚙️" label="Settings" focused={focused} /> }}
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
