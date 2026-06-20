/**
 * EngineView
 *
 * React Native component for rendering Guest UI in sandbox
 */

import type { ReactElement, ReactNode } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import type { Engine } from '../engine';
import { useEngineView } from '../use-engine-view';

const React = require('react') as typeof import('react');

/**
 * EngineView Props
 */
export interface EngineViewProps {
  /**
   * Engine instance
   */
  engine: Engine;

  /**
   * Bundle source (URL or code string)
   */
  source: string;

  /**
   * Optional Hermes bytecode asset path (.hbc) for the guest bundle.
   */
  bytecodeAssetPath?: string;

  /**
   * Initial props to pass to the Guest
   */
  initialProps?: Record<string, unknown>;

  /**
   * Load complete callback
   */
  onLoad?: () => void;

  /**
   * Error callback
   */
  onError?: (error: Error) => void;

  /**
   * Destroy callback
   */
  onDestroy?: () => void;

  /**
   * Custom loading indicator
   */
  fallback?: ReactNode;

  /**
   * Custom error display
   */
  renderError?: (error: Error) => ReactNode;

  /**
   * Container style
   */
  style?: object;
}

/**
 * EngineView component
 *
 * @example
 * ```tsx
 * const engine = new Engine();
 * engine.register({ StepList: NativeStepList });
 *
 * <EngineView
 *   engine={engine}
 *   source="https://cdn.example.com/bundle.js"
 *   initialProps={{ theme: 'dark' }}
 *   onLoad={() => console.log('Bundle loaded')}
 *   onError={(err) => console.error('Bundle error:', err)}
 * />
 * ```
 */
export function EngineView({
  engine,
  source,
  bytecodeAssetPath,
  initialProps,
  onLoad,
  onError,
  onDestroy,
  fallback,
  renderError,
  style,
}: EngineViewProps): ReactElement {
  const { loadingState, error, content } = useEngineView({
    engine,
    source,
    bytecodeAssetPath,
    initialProps,
    onLoad,
    onError,
    onDestroy,
  });

  // Render loading state
  if (loadingState === 'loading' || loadingState === 'idle') {
    return React.createElement(
      View,
      { style: [styles.container, style] },
      fallback ??
        React.createElement(
          View,
          { style: styles.loadingContainer },
          React.createElement(ActivityIndicator, { size: 'large', color: '#007AFF' }),
          React.createElement(Text, { style: styles.loadingText }, 'Loading bundle...')
        )
    );
  }

  // Render error state
  if (loadingState === 'error' && error) {
    return React.createElement(
      View,
      { style: [styles.container, style] },
      renderError?.(error) ??
        React.createElement(
          View,
          { style: styles.errorContainer },
          React.createElement(Text, { style: styles.errorTitle }, 'Bundle Error'),
          React.createElement(Text, { style: styles.errorMessage }, error.message)
        )
    );
  }

  // Render Guest content
  return React.createElement(View, { style: [styles.container, style] }, content);
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  loadingText: {
    marginTop: 12,
    fontSize: 14,
    color: '#666',
  },
  errorContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  errorTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: '#FF3B30',
    marginBottom: 8,
  },
  errorMessage: {
    fontSize: 14,
    color: '#666',
    textAlign: 'center',
  },
});

export default EngineView;
