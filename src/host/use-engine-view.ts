/**
 * useEngineView Hook
 *
 * Shared logic for EngineView components across platforms.
 * Handles Guest loading, error handling, and content updates.
 */

import type { ReactElement } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Engine } from './engine';

/**
 * Loading state
 */
export type LoadingState = 'idle' | 'loading' | 'loaded' | 'error';

/**
 * Common EngineView props (platform-agnostic)
 */
export interface UseEngineViewOptions {
  /**
   * Engine instance
   */
  engine: Engine;

  /**
   * Bundle source (URL or code string)
   */
  source: string;

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
}

/**
 * Return type for useEngineView hook
 */
export interface UseEngineViewResult {
  /**
   * Current loading state
   */
  loadingState: LoadingState;

  /**
   * Error if loading failed
   */
  error: Error | null;

  /**
   * Rendered content from Guest
   */
  content: ReactElement | string | null;
}

/**
 * useEngineView Hook
 *
 * Manages Guest lifecycle, including:
 * - Loading bundle and creating Receiver
 * - Listening to engine events (error, destroy)
 * - Triggering re-renders on content updates
 *
 * @example
 * ```tsx
 * function EngineView({ engine, source, ...props }) {
 *   const { loadingState, error, content } = useEngineView({ engine, source, ...props });
 *
 *   if (loadingState === 'loading') return <Loading />;
 *   if (loadingState === 'error') return <Error error={error} />;
 *   return <Container>{content}</Container>;
 * }
 * ```
 */
export function useEngineView({
  engine,
  source,
  initialProps,
  onLoad,
  onError,
  onDestroy,
}: UseEngineViewOptions): UseEngineViewResult {
  const [loadingState, setLoadingState] = useState<LoadingState>('idle');
  const [error, setError] = useState<Error | null>(null);
  const [content, setContent] = useState<ReactElement | string | null>(null);
  const mountedRef = useRef(true);

  // Update callback
  const handleUpdate = useCallback(() => {
    if (!mountedRef.current) return;

    const receiver = engine.getReceiver();
    if (receiver) {
      setContent(receiver.render());
    }
  }, [engine]);

  // Load Guest
  useEffect(() => {
    mountedRef.current = true;

    async function loadGuest() {
      if (engine.isLoaded || engine.isDestroyed) {
        return;
      }

      setLoadingState('loading');
      setError(null);

      try {
        // Create Receiver (update events come via engine.on('update'))
        engine.createReceiver();

        // Load and execute Guest
        await engine.loadBundle(source, initialProps);

        if (mountedRef.current) {
          setLoadingState('loaded');
          onLoad?.();
        }
      } catch (err) {
        console.error('[EngineView] loadGuest error:', err);
        if (mountedRef.current) {
          const loadError = err instanceof Error ? err : new Error(String(err));
          setError(loadError);
          setLoadingState('error');
          onError?.(loadError);
        }
      }
    }

    loadGuest();

    return () => {
      mountedRef.current = false;
    };
  }, [engine, source, initialProps, onLoad, onError]);

  // Listen to engine events
  useEffect(() => {
    const unsubscribeUpdate = engine.on('update', handleUpdate);

    const unsubscribeError = engine.on('error', (err: Error) => {
      if (mountedRef.current) {
        setError(err);
        setLoadingState('error');
        onError?.(err);
      }
    });

    const unsubscribeDestroy = engine.on('destroy', () => {
      if (mountedRef.current) {
        setContent(null);
        onDestroy?.();
      }
    });

    return () => {
      unsubscribeUpdate();
      unsubscribeError();
      unsubscribeDestroy();
    };
  }, [engine, handleUpdate, onError, onDestroy]);

  // Cleanup
  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

  return { loadingState, error, content };
}
