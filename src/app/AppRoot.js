'use strict';

import { useState } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import AppErrorBoundary from '../../components/AppErrorBoundary';
import AppShell from './AppShell';

export default function AppRoot() {
  const [appEpoch, setAppEpoch] = useState(0);
  return (
    <SafeAreaProvider>
      <AppErrorBoundary resetKey={appEpoch} onReset={() => setAppEpoch((value) => value + 1)}>
        <AppShell key={appEpoch} />
      </AppErrorBoundary>
    </SafeAreaProvider>
  );
}
