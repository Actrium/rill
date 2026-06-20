/**
 * ios-demo - React Native + rill sandbox testing
 */

import React from 'react';
import { AppRegistry, LogBox, NativeModules, Platform } from 'react-native';

// Disable LogBox on macOS to avoid potential crashes
if (Platform.OS === 'macos') {
  LogBox.ignoreAllLogs(true);
}

// Install rill sandbox JSI bindings on Android (bridgeless runtime)
if (Platform.OS === 'android') {
  try {
    NativeModules.RillSandboxNative?.installEngine?.('auto') ??
      NativeModules.RillSandboxNative?.install?.();
  } catch (e) {
    console.warn('[ios-demo] Failed to install sandbox bindings:', e);
  }
}

// Import the main App component
import App from './src/App';

// Error boundary wrapper
class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack?: string }) {
    console.error('[ErrorBoundary]', error.message, info?.componentStack);
  }

  render() {
    if (this.state.error) {
      const { View, Text } = require('react-native');
      return React.createElement(
        View,
        { style: { flex: 1, backgroundColor: '#2b0b0b', padding: 16, justifyContent: 'center' } },
        React.createElement(
          Text,
          { style: { color: '#fff', fontSize: 18, fontWeight: '700', marginBottom: 8 } },
          'Render Error'
        ),
        React.createElement(
          Text,
          { style: { color: '#fff', fontSize: 13 } },
          String(this.state.error.message)
        )
      );
    }
    return this.props.children;
  }
}

// Wrap App with ErrorBoundary
const WrappedApp = (props: Record<string, unknown>) => (
  <ErrorBoundary>
    <App {...props} />
  </ErrorBoundary>
);

// Register the app
AppRegistry.registerComponent('RillDemo', () => WrappedApp);

console.log('[ios-demo] App registered as RillDemo');
