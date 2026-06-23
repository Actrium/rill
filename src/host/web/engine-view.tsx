/**
 * WebEngineView (issue #19, L2)
 *
 * The DOM-mount sibling of the React Native `EngineView`. It reuses the platform-agnostic
 * `useEngineView` hook (load bundle → subscribe to engine updates → `receiver.render()`),
 * and renders the resulting guest tree into the DOM inside a container <div>. The integrator
 * mounts this with their own react-dom (`createRoot(el).render(<WebEngineView .../>)`), or
 * via the `mountEngineView` helper. No react-native / react-native-web dependency.
 *
 * Register the thin-DOM preset first so the guest's primitives resolve:
 * ```ts
 * engine.register(WebComponents);
 * createRoot(el).render(<WebEngineView engine={engine} source={code} />);
 * ```
 */

import type { CSSProperties, ReactElement, ReactNode } from 'react';
import { type EngineViewEngine, useEngineView } from '../use-engine-view';

export interface WebEngineViewProps {
  /**
   * Engine instance. Either the in-thread `Engine` (sandbox `'wasm-quickjs'`) or an
   * off-main-thread `WorkerEngine` from `rill/host/web` — both render identically here.
   */
  engine: EngineViewEngine;
  /** Bundle source (URL or code string). */
  source: string;
  /** Initial props passed to the guest. */
  initialProps?: Record<string, unknown>;
  /** Load complete callback. */
  onLoad?: () => void;
  /** Error callback. */
  onError?: (error: Error) => void;
  /** Destroy callback. */
  onDestroy?: () => void;
  /** Custom loading UI (defaults to a small "Loading…" line). */
  fallback?: ReactNode;
  /** Custom error UI. */
  renderError?: (error: Error) => ReactNode;
  /** Container style (merged over the flexbox-column default). */
  style?: CSSProperties;
  /** Container className. */
  className?: string;
}

const CONTAINER: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  position: 'relative',
  boxSizing: 'border-box',
};

export function WebEngineView({
  engine,
  source,
  initialProps,
  onLoad,
  onError,
  onDestroy,
  fallback,
  renderError,
  style,
  className,
}: WebEngineViewProps): ReactElement {
  const { loadingState, error, content } = useEngineView({
    engine,
    source,
    initialProps,
    onLoad,
    onError,
    onDestroy,
  });

  const containerStyle: CSSProperties = { ...CONTAINER, ...style };

  if (loadingState === 'loading' || loadingState === 'idle') {
    return (
      <div className={className} style={containerStyle} data-rill-state="loading">
        {fallback ?? <span style={{ color: '#666', fontSize: 14 }}>Loading…</span>}
      </div>
    );
  }

  if (loadingState === 'error' && error) {
    return (
      <div className={className} style={containerStyle} data-rill-state="error">
        {renderError?.(error) ?? (
          <div style={{ color: '#c00', fontSize: 14 }}>
            <strong>Bundle error</strong>
            <div>{error.message}</div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className={className} style={containerStyle} data-rill-state="loaded">
      {content}
    </div>
  );
}

export default WebEngineView;
