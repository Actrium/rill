/**
 * Rill SDK
 *
 * Virtual components and Hooks for Guest development
 * Zero runtime dependencies - all implementations injected by reconciler at runtime
 */

import type { ReviewedUnknown } from '../shared';
import { KBD_EVENT, KBD_SUBSCRIBE, KBD_UNSUBSCRIBE, type RillKeyEvent } from '../shared/keyboard';
import type {
  ImageSource,
  LayoutEvent,
  RemoteRef,
  RemoteRefCallback,
  ScrollEvent,
  StyleProp,
} from './types';

// ============ Runtime-injected React types ============
// These types mirror React's types but are defined locally to avoid React dependency

/** React node type - matches React.ReactNode */
export type ReactNode =
  | string
  | number
  | boolean
  | null
  | undefined
  | ReactNode[]
  | { $$typeof: symbol; type: unknown; props: unknown };

/** Component type - matches React.ComponentType */
export type ComponentType<P = object> =
  | ((props: P) => ReactNode)
  | { new (props: P): { render(): ReactNode } };

// ============ Runtime React hooks accessor ============

interface ReactHooks {
  useEffect: (effect: () => undefined | (() => void), deps?: ReviewedUnknown[]) => void;
  useRef: <T>(initial: T) => { current: T };
  useState: <T>(initial: T | (() => T)) => [T, (value: T | ((prev: T) => T)) => void];
  useMemo: <T>(factory: () => T, deps: ReviewedUnknown[]) => T;
  useCallback: <T extends (...args: ReviewedUnknown[]) => ReviewedUnknown>(
    callback: T,
    deps: ReviewedUnknown[]
  ) => T;
}

/**
 * Get React hooks from runtime-injected global.
 *
 * In rill sandbox, React is provided by the Guest runtime bundle via `globalThis.React`.
 */
function getReactHooks(): ReactHooks {
  const g = globalThis as { React?: ReactHooks };
  if (g.React && typeof g.React.useEffect === 'function') {
    return g.React as ReactHooks;
  }

  // Fallback: hooks not available (will fail at runtime if used)
  const throwUnavailable = (hook: string) => () => {
    throw new Error(`[rill/guest] ${hook} not available. Ensure running in rill sandbox.`);
  };
  return {
    useEffect: throwUnavailable('useEffect'),
    useRef: throwUnavailable('useRef'),
    useState: throwUnavailable('useState'),
    useMemo: throwUnavailable('useMemo'),
    useCallback: throwUnavailable('useCallback'),
  } as ReactHooks;
}

// ============ Component Definitions ============
// In sandbox: string identifiers (virtual components)

// Component names list - single source of truth
const COMPONENT_NAMES = [
  // Core
  'View',
  'Text',
  'Image',
  'ImageBackground',
  // Scrolling
  'ScrollView',
  'FlatList',
  'SectionList',
  'VirtualizedList',
  'RefreshControl',
  // Input
  'TextInput',
  'Button',
  'Switch',
  'Pressable',
  // Touchables
  'TouchableOpacity',
  'TouchableHighlight',
  'TouchableWithoutFeedback',
  // Feedback
  'ActivityIndicator',
  'Modal',
  'StatusBar',
  // Layout
  'SafeAreaView',
  'KeyboardAvoidingView',
] as const;

type ComponentName = (typeof COMPONENT_NAMES)[number];

/**
 * Get components (virtual components in sandbox)
 */
function getComponents(): Record<ComponentName, string> {
  const result = {} as Record<ComponentName, string>;
  for (const name of COMPONENT_NAMES) {
    result[name] = name;
  }
  return result;
}

/**
 * Get APIs - either stubs (sandbox) or real (react-native)
 *
 * API Categories:
 * - Pure JS: StyleSheet, Easing (no Host interaction needed)
 * - Platform Info: Platform, Dimensions, PixelRatio, Appearance, I18nManager (Host injected)
 * - Event Subscription: AppState, Keyboard (Host→Guest push)
 * - Host Capability: Alert, Linking, Share, Vibration (Guest→Host request)
 * - Animation: Animated
 */
function getAPIs() {
  // Sandbox stubs
  const stubs = {
    // Pure JS
    StyleSheet: {
      create: <T extends object>(styles: T): T => styles,
      flatten: (s: ReviewedUnknown): ReviewedUnknown => s,
    },
    Easing: {
      linear: (t: number) => t,
      ease: (t: number) => t,
      quad: (t: number) => t * t,
      cubic: (t: number) => t * t * t,
      bezier: () => (t: number) => t,
      in: (e: (t: number) => number) => e,
      out: (e: (t: number) => number) => e,
      inOut: (e: (t: number) => number) => e,
    },
    // Platform Info
    Platform: {
      OS: 'unknown' as string,
      Version: 0,
      select: <T>(spec: { default?: T }) => spec.default,
    },
    Dimensions: {
      get: () => ({ width: 0, height: 0, scale: 1, fontScale: 1 }),
      addEventListener: () => ({ remove: () => {} }),
    },
    PixelRatio: {
      get: () => 1,
      getFontScale: () => 1,
      getPixelSizeForLayoutSize: (size: number) => size,
      roundToNearestPixel: (size: number) => size,
    },
    Appearance: {
      getColorScheme: () => 'light' as 'light' | 'dark' | null,
      addChangeListener: () => ({ remove: () => {} }),
    },
    I18nManager: { isRTL: false, allowRTL: () => {}, forceRTL: () => {} },
    // Event Subscription
    AppState: {
      currentState: 'active' as string,
      addEventListener: () => ({ remove: () => {} }),
    },
    Keyboard: {
      dismiss: () => {},
      addListener: () => ({ remove: () => {} }),
    },
    // Host Capability
    Alert: { alert: () => {}, prompt: () => {} },
    Linking: {
      openURL: async () => {},
      canOpenURL: async () => false,
      getInitialURL: async () => null,
      addEventListener: () => ({ remove: () => {} }),
    },
    Share: { share: async () => ({ action: 'dismissedAction' }) },
    Vibration: { vibrate: () => {}, cancel: () => {} },
    // Animation
    Animated: {},
  };
  return stubs;
}

/**
 * Get RN Hooks - either stubs (sandbox) or real (react-native)
 */
function getRNHooks() {
  const stubs = {
    useColorScheme: () => 'light' as 'light' | 'dark' | null,
    useWindowDimensions: () => ({ width: 0, height: 0, scale: 1, fontScale: 1 }),
  };
  return stubs;
}

const _components = getComponents();
const _apis = getAPIs();
const _rnHooks = getRNHooks();

// ============ Component Exports ============
// Core
export const View = _components.View;
export const Text = _components.Text;
export const Image = _components.Image;
export const ImageBackground = _components.ImageBackground;
// Scrolling
export const ScrollView = _components.ScrollView;
export const FlatList = _components.FlatList;
export const SectionList = _components.SectionList;
export const VirtualizedList = _components.VirtualizedList;
export const RefreshControl = _components.RefreshControl;
// Input
export const TextInput = _components.TextInput;
export const Button = _components.Button;
export const Switch = _components.Switch;
export const Pressable = _components.Pressable;
// Touchables
export const TouchableOpacity = _components.TouchableOpacity;
export const TouchableHighlight = _components.TouchableHighlight;
export const TouchableWithoutFeedback = _components.TouchableWithoutFeedback;
// Feedback
export const ActivityIndicator = _components.ActivityIndicator;
export const Modal = _components.Modal;
export const StatusBar = _components.StatusBar;
// Layout
export const SafeAreaView = _components.SafeAreaView;
export const KeyboardAvoidingView = _components.KeyboardAvoidingView;

// ============ API Exports ============
// Pure JS
export const StyleSheet = _apis.StyleSheet;
export const Easing = _apis.Easing;
// Platform Info
export const Platform = _apis.Platform;
export const Dimensions = _apis.Dimensions;
export const PixelRatio = _apis.PixelRatio;
export const Appearance = _apis.Appearance;
export const I18nManager = _apis.I18nManager;
// Event Subscription
export const AppState = _apis.AppState;
export const Keyboard = _apis.Keyboard;
// Host Capability
export const Alert = _apis.Alert;
export const Linking = _apis.Linking;
export const Share = _apis.Share;
export const Vibration = _apis.Vibration;
// Animation
export const Animated = _apis.Animated;

// ============ RN Hook Exports ============
export const useColorScheme = _rnHooks.useColorScheme;
export const useWindowDimensions = _rnHooks.useWindowDimensions;

// ============ Component Props Type Definitions ============

/**
 * Common Props
 */
export interface BaseProps {
  style?: StyleProp;
  testID?: string;
  key?: string | number;
}

/**
 * View Component Props
 */
export interface ViewProps extends BaseProps {
  children?: ReactNode;
  onLayout?: (event: LayoutEvent) => void;
  pointerEvents?: 'auto' | 'none' | 'box-none' | 'box-only';
  accessible?: boolean;
  accessibilityLabel?: string;
}

/**
 * Text Component Props
 */
export interface TextProps extends BaseProps {
  children?: ReactNode;
  numberOfLines?: number;
  ellipsizeMode?: 'head' | 'middle' | 'tail' | 'clip';
  selectable?: boolean;
  onPress?: () => void;
  onLongPress?: () => void;
}

/**
 * Image Component Props
 */
export interface ImageProps extends BaseProps {
  source: ImageSource | ImageSource[];
  resizeMode?: 'cover' | 'contain' | 'stretch' | 'repeat' | 'center';
  onLoad?: () => void;
  onLoadStart?: () => void;
  onLoadEnd?: () => void;
  onError?: (error: { nativeEvent: { error: string } }) => void;
  fadeDuration?: number;
  blurRadius?: number;
}

/**
 * ScrollView Component Props
 */
export interface ScrollViewProps extends ViewProps {
  horizontal?: boolean;
  showsVerticalScrollIndicator?: boolean;
  showsHorizontalScrollIndicator?: boolean;
  pagingEnabled?: boolean;
  bounces?: boolean;
  scrollEnabled?: boolean;
  onScroll?: (event: ScrollEvent) => void;
  onScrollBeginDrag?: (event: ScrollEvent) => void;
  onScrollEndDrag?: (event: ScrollEvent) => void;
  onMomentumScrollBegin?: (event: ScrollEvent) => void;
  onMomentumScrollEnd?: (event: ScrollEvent) => void;
  scrollEventThrottle?: number;
  contentContainerStyle?: StyleProp;
  keyboardShouldPersistTaps?: 'always' | 'never' | 'handled';
  keyboardDismissMode?: 'none' | 'on-drag' | 'interactive';
}

/**
 * TouchableOpacity Component Props
 */
export interface TouchableOpacityProps extends BaseProps {
  children?: ReactNode;
  onPress?: () => void;
  onPressIn?: () => void;
  onPressOut?: () => void;
  onLongPress?: () => void;
  activeOpacity?: number;
  disabled?: boolean;
  delayPressIn?: number;
  delayPressOut?: number;
  delayLongPress?: number;
}

/**
 * FlatList Component Props
 */
export interface FlatListProps<T> extends ScrollViewProps {
  data: T[];
  renderItem: (info: { item: T; index: number }) => ReactNode;
  keyExtractor?: (item: T, index: number) => string;
  ItemSeparatorComponent?: ComponentType;
  ListHeaderComponent?: ReactNode;
  ListFooterComponent?: ReactNode;
  ListEmptyComponent?: ReactNode;
  numColumns?: number;
  initialNumToRender?: number;
  onEndReached?: () => void;
  onEndReachedThreshold?: number;
  refreshing?: boolean;
  onRefresh?: () => void;
  getItemLayout?: (
    data: T[] | null,
    index: number
  ) => {
    length: number;
    offset: number;
    index: number;
  };
}

/**
 * TextInput Component Props
 */
export interface TextInputProps extends BaseProps {
  value?: string;
  defaultValue?: string;
  placeholder?: string;
  placeholderTextColor?: string;
  onChangeText?: (text: string) => void;
  onChange?: (event: { nativeEvent: { text: string } }) => void;
  onFocus?: () => void;
  onBlur?: () => void;
  onSubmitEditing?: () => void;
  multiline?: boolean;
  numberOfLines?: number;
  maxLength?: number;
  editable?: boolean;
  autoCapitalize?: 'none' | 'sentences' | 'words' | 'characters';
  autoCorrect?: boolean;
  autoFocus?: boolean;
  secureTextEntry?: boolean;
  keyboardType?: 'default' | 'email-address' | 'numeric' | 'phone-pad' | 'decimal-pad' | 'url';
  returnKeyType?: 'done' | 'go' | 'next' | 'search' | 'send';
  selectTextOnFocus?: boolean;
}

/**
 * Button Component Props
 */
export interface ButtonProps {
  title: string;
  onPress: () => void;
  color?: string;
  disabled?: boolean;
  testID?: string;
  accessibilityLabel?: string;
}

/**
 * Switch Component Props
 */
export interface SwitchProps extends BaseProps {
  value?: boolean;
  onValueChange?: (value: boolean) => void;
  disabled?: boolean;
  trackColor?: { false?: string; true?: string };
  thumbColor?: string;
  ios_backgroundColor?: string;
}

/**
 * ActivityIndicator Component Props
 */
export interface ActivityIndicatorProps extends BaseProps {
  animating?: boolean;
  color?: string;
  size?: 'small' | 'large' | number;
  hidesWhenStopped?: boolean;
}

// ============ Event Types (re-exported from types.ts) ============
// LayoutEvent, ScrollEvent, ImageSource are now imported from '../types'

// ============ Hooks ============

/**
 * Subscribe to host events
 *
 * Automatically cleans up subscription when component unmounts.
 *
 * @param eventName Event name
 * @param callback Callback function
 *
 * @example
 * ```tsx
 * useHostEvent('REFRESH', () => {
 *   console.log('Host requested refresh');
 *   fetchData();
 * });
 * // Automatically unsubscribes when component unmounts
 * ```
 */
export function useHostEvent<T = unknown>(eventName: string, callback: (payload: T) => void): void {
  const { useEffect, useRef } = getReactHooks();

  // Use ref to avoid re-subscribing when callback changes
  const callbackRef = useRef(callback);

  // Keep ref up to date with latest callback
  useEffect(() => {
    callbackRef.current = callback;
    return undefined;
  });

  useEffect(() => {
    const g = globalThis as Record<string, unknown>;
    if ('__rill_onHostEvent' in globalThis) {
      // Create stable callback wrapper that always calls the latest callback
      const stableCallback = (payload: T) => callbackRef.current(payload);

      // Subscribe and get unsubscribe function
      const unsubscribe = (
        g.__rill_onHostEvent as (name: string, cb: (payload: T) => void) => () => void
      )(eventName, stableCallback);

      // React automatically calls this cleanup function when component unmounts
      return unsubscribe;
    }
    return undefined;
  }, [eventName]); // Only re-subscribe when eventName changes
}

/**
 * Get initial configuration from host
 *
 * @returns Configuration object
 *
 * @example
 * ```tsx
 * const config = useConfig<{ theme: 'light' | 'dark' }>();
 * console.log(config.theme);
 * ```
 */
export function useConfig<T = Record<string, unknown>>(): T {
  // Actual implementation injected by reconciler at runtime
  const g = globalThis as Record<string, unknown>;
  if ('__rill_getConfig' in globalThis) {
    return (g.__rill_getConfig as () => T)();
  }
  return {} as T;
}

/**
 * Get function to send messages to host
 *
 * @returns send function
 *
 * @example
 * ```tsx
 * const sendToHost = useSendToHost();
 * sendToHost('ANALYTICS', { action: 'click', target: 'button' });
 * ```
 */
export function useSendToHost(): (eventName: string, payload?: ReviewedUnknown) => void {
  // Actual implementation injected by reconciler at runtime
  const g = globalThis as Record<string, unknown>;
  if ('__rill_emitEvent' in globalThis) {
    return g.__rill_emitEvent as (eventName: string, payload?: ReviewedUnknown) => void;
  }
  return () => {
    console.warn('[rill] sendToHost is not available outside sandbox');
  };
}

// ============ Keyboard (web host) ============

/** Spec for {@link useKeyboard}. */
export interface UseKeyboardSpec {
  /**
   * Keys to listen for, matched against `KeyboardEvent.key` (e.g. 'Enter', 'a', 'ArrowUp',
   * ' ' for Space). `null` or omitted means every key.
   */
  keys?: string[] | null;
  /**
   * Ask the host to call `preventDefault` synchronously on the subscribed keys as they are
   * captured. Use this for keys the browser would otherwise act on (Space scrolls, arrows
   * scroll, Tab moves focus, '/' opens quick-find). The host must decide without awaiting
   * the guest, which is why the intent is declared up front rather than per event.
   */
  preventDefault?: boolean;
  /** Called on key press (keydown). */
  onKeyDown?: (event: RillKeyEvent) => void;
  /** Called on key release (keyup). */
  onKeyUp?: (event: RillKeyEvent) => void;
}

/** Monotonic source of per-hook subscription ids (unique within a guest realm). */
let _kbdSubscriptionSeq = 0;

/**
 * Subscribe to physical keyboard events forwarded by a web host (`rill/host/web`
 * `attachKeyboard`). A no-op on hosts that don't bridge the keyboard (native, or web hosts
 * that never attached it), so it is always safe to call.
 *
 * Events arrive asynchronously over the host-event channel, but the host has already decided
 * synchronously — based on this subscription's `keys` + `preventDefault` — whether to call
 * `preventDefault`. That split is deliberate: the browser cannot wait for the sandbox.
 *
 * @example
 * ```tsx
 * useKeyboard({
 *   keys: ['ArrowLeft', 'ArrowRight', ' '],
 *   preventDefault: true,
 *   onKeyDown: (e) => move(e.key),
 * });
 * ```
 */
export function useKeyboard(spec: UseKeyboardSpec): void {
  const { useEffect, useRef } = getReactHooks();

  // Stable subscription id for this hook instance (assigned once, on first render).
  const idRef = useRef<string | null>(null);
  if (idRef.current === null) {
    _kbdSubscriptionSeq += 1;
    idRef.current = `kbd-${_kbdSubscriptionSeq}`;
  }

  // Track the latest spec so callbacks can change without re-subscribing.
  const specRef = useRef(spec);
  useEffect(() => {
    specRef.current = spec;
    return undefined;
  });

  // Re-subscribe only when the key set or preventDefault intent changes.
  const specKeys = spec.keys ?? null;
  const keysKey = specKeys === null ? '*' : [...specKeys].sort().join(' ');
  const preventDefault = spec.preventDefault ?? false;

  useEffect(() => {
    const g = globalThis as Record<string, unknown>;
    if (!('__rill_emitEvent' in g) || !('__rill_onHostEvent' in g)) {
      return undefined;
    }
    const id = idRef.current as string;
    // Reason: runtime-injected bridge; payload is any serializable guest->host value
    const emit = g.__rill_emitEvent as (name: string, payload?: unknown) => void;
    const onHostEvent = g.__rill_onHostEvent as (
      name: string,
      cb: (payload: RillKeyEvent) => void
    ) => () => void;

    const keys = specRef.current.keys ?? null;

    // Declare the subscription so the host can preventDefault exactly these keys.
    emit(KBD_SUBSCRIBE, { id, keys, preventDefault });

    // The host broadcasts every subscribed key on one channel, so filter locally to the
    // keys this hook cares about before dispatching.
    const unsubscribe = onHostEvent(KBD_EVENT, (event) => {
      if (keys !== null && !keys.includes(event.key)) {
        return;
      }
      const current = specRef.current;
      if (event.type === 'keydown') {
        current.onKeyDown?.(event);
      } else {
        current.onKeyUp?.(event);
      }
    });

    return () => {
      unsubscribe();
      emit(KBD_UNSUBSCRIBE, { id });
    };
  }, [keysKey, preventDefault]);
}

// ============ Remote Ref ============

/** Pending call entry for tracking async method invocations */
interface PendingCall {
  resolve: (value: ReviewedUnknown) => void;
  reject: (error: Error) => void;
  timeoutId: ReturnType<typeof setTimeout>;
}

/** REF_METHOD_RESULT message from Host */
interface RefMethodResult {
  refId: number;
  callId: string;
  result?: ReviewedUnknown;
  error?: { message: string; name?: string; stack?: string };
}

/** Default timeout for remote method calls (ms) */
const DEFAULT_REMOTE_REF_TIMEOUT = 4000;

/**
 * Create a remote reference to a Host component instance
 *
 * Since Guest code runs in a sandbox and cannot directly access Host component instances,
 * this hook provides a message-based mechanism to invoke component methods asynchronously.
 *
 * @returns Tuple of [refCallback, remoteRef]
 *   - refCallback: Pass to component's ref prop
 *   - remoteRef: RemoteRef instance (null until mounted)
 *
 * @example
 * ```tsx
 * import { useRemoteRef, TextInput, TextInputRef } from 'rill/guest';
 *
 * function MyComponent() {
 *   const [inputRef, remoteInput] = useRemoteRef<TextInputRef>();
 *
 *   const handleFocus = async () => {
 *     await remoteInput?.invoke('focus');
 *     // or using typed call proxy:
 *     // await remoteInput?.call.focus();
 *   };
 *
 *   return (
 *     <TouchableOpacity onPress={handleFocus}>
 *       <TextInput ref={inputRef} placeholder="Tap button to focus" />
 *     </TouchableOpacity>
 *   );
 * }
 * ```
 */
export function useRemoteRef<T = unknown>(options?: {
  timeout?: number;
}): [RemoteRefCallback, RemoteRef<T> | null] {
  const { useEffect, useRef, useState, useMemo, useCallback } = getReactHooks();

  // Use provided timeout or default
  const timeout = options?.timeout ?? DEFAULT_REMOTE_REF_TIMEOUT;

  // Track the nodeId assigned by reconciler
  const [nodeId, setNodeId] = useState<number | null>(null);

  // Counter for generating unique call IDs
  const callIdCounterRef = useRef(0);

  // Map of pending calls waiting for results
  const pendingCallsRef = useRef<Map<string, PendingCall>>(new Map());

  // Ref callback to pass to the component
  const refCallback = useCallback(
    ((instance: { nodeId: number } | null) => {
      if (instance && typeof instance.nodeId === 'number') {
        setNodeId(instance.nodeId);
      } else {
        setNodeId(null);
      }
    }) as unknown as (...args: unknown[]) => unknown,
    []
  ) as unknown as RemoteRefCallback;

  // Listen for REF_METHOD_RESULT events from Host
  useEffect(() => {
    const g = globalThis as Record<string, unknown>;
    if (!('__rill_onHostEvent' in g)) {
      return undefined;
    }

    const handleResult = (message: RefMethodResult) => {
      // Only handle results for our nodeId
      if (message.refId !== nodeId) {
        return;
      }

      const pending = pendingCallsRef.current.get(message.callId);
      if (!pending) {
        return;
      }

      // Clear timeout and remove from pending
      clearTimeout(pending.timeoutId);
      pendingCallsRef.current.delete(message.callId);

      // Resolve or reject the promise
      if (message.error) {
        const error = new Error(message.error.message);
        if (message.error.name) error.name = message.error.name;
        if (message.error.stack) error.stack = message.error.stack;
        pending.reject(error);
      } else {
        pending.resolve(message.result);
      }
    };

    // Subscribe to __REF_RESULT__ events
    const unsubscribe = (
      g.__rill_onHostEvent as (name: string, cb: (payload: RefMethodResult) => void) => () => void
    )('__REF_RESULT__', handleResult);

    return unsubscribe;
  }, [nodeId]);

  // Cleanup pending calls when nodeId changes or on unmount
  useEffect(() => {
    return () => {
      // Reject all pending calls - node may have changed or unmounted
      for (const [, pending] of pendingCallsRef.current) {
        clearTimeout(pending.timeoutId);
        pending.reject(new Error('Node changed or component unmounted'));
      }
      pendingCallsRef.current.clear();
    };
  }, [nodeId]);

  // Create RemoteRef instance
  const remoteRef = useMemo<RemoteRef<T> | null>(() => {
    if (nodeId === null) {
      return null;
    }

    const invoke = <R = unknown>(method: string, ...args: unknown[]): Promise<R> => {
      return new Promise((resolve, reject) => {
        // Generate unique call ID
        const callId = `${nodeId}-${++callIdCounterRef.current}`;

        // Set timeout for the call
        const timeoutId = setTimeout(() => {
          pendingCallsRef.current.delete(callId);
          reject(new Error(`Remote method call '${method}' timed out after ${timeout}ms`));
        }, timeout);

        // Store pending call
        pendingCallsRef.current.set(callId, {
          resolve: resolve as PendingCall['resolve'],
          reject,
          timeoutId,
        });

        // Send REF_CALL operation to Host
        const g = globalThis as Record<string, unknown>;
        if ('__rill_sendOperation' in g) {
          const sendOp = g.__rill_sendOperation as (op: ReviewedUnknown) => void;
          sendOp({
            op: 'REF_CALL',
            refId: nodeId,
            method,
            args,
            callId,
          });
        } else {
          // No operation channel available
          clearTimeout(timeoutId);
          pendingCallsRef.current.delete(callId);
          reject(new Error('[rill/guest] __rill_sendOperation not available'));
        }
      });
    };

    // Create typed call proxy
    const call = new Proxy(
      {},
      {
        get(_, prop: string) {
          return (...args: unknown[]) => invoke(prop, ...args);
        },
      }
    ) as RemoteRef<T>['call'];

    return {
      nodeId,
      invoke,
      call,
    };
  }, [nodeId, timeout]);

  return [refCallback, remoteRef];
}

// ============ Error Boundary ============

/**
 * Error info passed to error handlers
 */
export interface ErrorInfo {
  componentStack: string;
}

/**
 * Props for RillErrorBoundary
 */
export interface RillErrorBoundaryProps {
  children: ReactNode;
  fallback?: ReactNode | ((error: Error, errorInfo: ErrorInfo) => ReactNode);
  onError?: (error: Error, errorInfo: ErrorInfo) => void;
}

/**
 * State for RillErrorBoundary
 */
interface RillErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
}

/**
 * Error Boundary component for catching render errors in Guest code
 *
 * @example
 * ```tsx
 * import { RillErrorBoundary, View, Text } from 'rill/guest';
 *
 * function App() {
 *   return (
 *     <RillErrorBoundary
 *       fallback={<Text>Something went wrong</Text>}
 *       onError={(error, info) => {
 *         // Report error to host
 *         sendToHost('RENDER_ERROR', { message: error.message, stack: info.componentStack });
 *       }}
 *     >
 *       <MyComponent />
 *     </RillErrorBoundary>
 *   );
 * }
 * ```
 */
// Note: We use React.Component here because ErrorBoundary must be a class component
// Check that globalThis.React.Component is a valid constructor (not just an object from shims)
const React =
  globalThis.React && typeof (globalThis.React as { Component?: unknown }).Component === 'function'
    ? globalThis.React
    : { Component: class {} };

type ReactType = typeof React;
// Reason: ReactNode fallback type when React.Component unavailable
type ReactNodeType = ReactType extends { Component: { prototype: { render(): infer R } } }
  ? R
  : unknown;

export class RillErrorBoundary extends (React.Component as unknown as new (
  props: RillErrorBoundaryProps
) => {
  props: RillErrorBoundaryProps;
  state: RillErrorBoundaryState;
  setState: (state: Partial<RillErrorBoundaryState>) => void;
  render(): ReactNodeType;
}) {
  constructor(props: RillErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null, errorInfo: null };
  }

  static getDerivedStateFromError(error: Error): Partial<RillErrorBoundaryState> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: { componentStack: string }): void {
    const info: ErrorInfo = { componentStack: errorInfo.componentStack };
    this.setState({ errorInfo: info });

    // Call onError callback if provided
    if (this.props.onError) {
      this.props.onError(error, info);
    }

    // Also send to host if sendToHost is available
    const g = globalThis as Record<string, unknown>;
    if ('__rill_emitEvent' in g) {
      // Reason: Error payload can be any serializable type
      const sendToHost = g.__rill_emitEvent as (name: string, payload: unknown) => void;
      sendToHost('RENDER_ERROR', {
        message: error.message,
        stack: error.stack,
        componentStack: info.componentStack,
      });
    }
  }

  override render(): ReactNode {
    if (this.state.hasError) {
      const { fallback } = this.props;
      const { error, errorInfo } = this.state;

      if (typeof fallback === 'function' && error && errorInfo) {
        return fallback(error, errorInfo);
      }

      if (fallback && typeof fallback !== 'function') {
        return fallback;
      }

      // Default fallback - simple error message
      return null;
    }

    return this.props.children;
  }
}

// ============ Type Exports ============

export type { ImageSource, LayoutEvent, ScrollEvent, StyleObject, StyleProp } from './types';
