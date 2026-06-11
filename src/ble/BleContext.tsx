import React, { createContext, useContext, ReactNode } from 'react';
import { useBLE } from './useBLE';

type BleContextValue = ReturnType<typeof useBLE>;

const BleContext = createContext<BleContextValue | null>(null);

export function BleProvider({ children }: { children: ReactNode }) {
  const ble = useBLE();
  return <BleContext.Provider value={ble}>{children}</BleContext.Provider>;
}

export function useBleContext(): BleContextValue {
  const ctx = useContext(BleContext);
  if (!ctx) throw new Error('useBleContext must be used inside BleProvider');
  return ctx;
}
