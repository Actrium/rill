/**
 * android-demo - React Native + rill sandbox testing
 */

import React from 'react';
import { AppRegistry, NativeModules, Platform } from 'react-native';

// Install rill sandbox JSI bindings (must happen before Engine uses them)
// Read the engine from the build flavor (BuildConfig.SANDBOX_ENGINE exposed via RillDemoConfig)
// so each APK flavor only installs its designated engine.
if (Platform.OS === 'android') {
  try {
    const engine: string = NativeModules.RillDemoConfig?.sandboxEngine || 'auto';
    const installed =
      NativeModules.RillSandboxNative?.installEngine?.(engine) ??
      NativeModules.RillSandboxNative?.install?.();
    console.log('[android-demo] Sandbox install:', { engine, installed });
  } catch (e) {
    console.warn('[android-demo] Failed to install sandbox bindings:', e);
  }
}

// Import the main App component
import App from './App';

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

console.log('[android-demo] App registered as RillDemo');
