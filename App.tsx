import React from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createStackNavigator } from '@react-navigation/stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { Text } from 'react-native';
import { colors } from './src/theme';
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

function TabLabel({ label, focused }: { label: string; focused: boolean }) {
  return (
    <Text style={{
      fontSize: 12,
      color: focused ? colors.text : colors.textFaint,
      fontWeight: focused ? '600' : '400',
      letterSpacing: 0.3,
      marginTop: 4,
    }}>
      {label}
    </Text>
  );
}

function MainTabs() {
  return (
    <Tab.Navigator
      screenOptions={{
        headerShown: false,
        tabBarStyle: { backgroundColor: colors.bg, borderTopColor: colors.borderFaint, height: 60, paddingBottom: 8 },
        tabBarShowLabel: false,
      }}
    >
      <Tab.Screen
        name="Home"
        component={HomeScreen}
        options={{ tabBarIcon: ({ focused }) => <TabLabel label="Home" focused={focused} /> }}
      />
      <Tab.Screen
        name="Live"
        component={LiveScreen}
        options={{ tabBarIcon: ({ focused }) => <TabLabel label="Live" focused={focused} /> }}
      />
      <Tab.Screen
        name="Trends"
        component={TrendsScreen}
        options={{ tabBarIcon: ({ focused }) => <TabLabel label="Trends" focused={focused} /> }}
      />
      <Tab.Screen
        name="Sleep"
        component={SleepScreen}
        options={{ tabBarIcon: ({ focused }) => <TabLabel label="Sleep" focused={focused} /> }}
      />
      <Tab.Screen
        name="Settings"
        component={SettingsScreen}
        options={{ tabBarIcon: ({ focused }) => <TabLabel label="Settings" focused={focused} /> }}
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
