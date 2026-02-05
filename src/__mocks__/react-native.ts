/**
 * Minimal react-native mock for Bun tests
 *
 * Provides just enough to allow EngineView tests to run
 */
import type { CSSProperties, ReactNode, SyntheticEvent } from 'react';
import { createElement, forwardRef } from 'react';

// Type exports (simplified versions)
export type ViewStyle = CSSProperties;
export type TextStyle = CSSProperties;
export type ImageStyle = CSSProperties;
export type ImageSourcePropType = string | { uri: string; headers?: Record<string, string> } | number;
export type ListRenderItem<T> = (info: { item: T; index: number }) => ReactNode;
export type NativeScrollEvent = {
  contentOffset: { x: number; y: number };
  contentSize: { width: number; height: number };
  layoutMeasurement: { width: number; height: number };
};
export type NativeSyntheticEvent<T> = SyntheticEvent & { nativeEvent: T };

// Basic View mock
// biome-ignore lint/suspicious/noExplicitAny: Mock component with flexible types
export const View = forwardRef<any, any>((props, ref) =>
  createElement('View', { ...props, ref }, props.children)
);
View.displayName = 'View';

// Basic Text mock
// biome-ignore lint/suspicious/noExplicitAny: Mock component with flexible types
export const Text = forwardRef<any, any>((props, ref) =>
  createElement('Text', { ...props, ref }, props.children)
);
Text.displayName = 'Text';

// ActivityIndicator mock
// biome-ignore lint/suspicious/noExplicitAny: Mock component with flexible types
export const ActivityIndicator = forwardRef<any, any>((props, ref) =>
  createElement('ActivityIndicator', { ...props, ref })
);
ActivityIndicator.displayName = 'ActivityIndicator';

// StyleSheet mock
export const StyleSheet = {
  // biome-ignore lint/suspicious/noExplicitAny: Mock utility accepting any style object
  create: <T extends Record<string, any>>(styles: T): T => styles,
  // biome-ignore lint/suspicious/noExplicitAny: Mock utility accepting any style object
  flatten: (style: any) => {
    if (Array.isArray(style)) {
      // biome-ignore lint/performance/noAccumulatingSpread: Simplified mock implementation
      return style.reduce((acc, s) => ({ ...acc, ...s }), {});
    }
    return style || {};
  },
  absoluteFill: {
    position: 'absolute' as const,
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
  },
};

// Platform mock
export const Platform = {
  OS: 'ios' as const,
  Version: 17,
  select: <T>(config: { ios?: T; android?: T; default?: T }): T | undefined => {
    return config.ios ?? config.default;
  },
};

// Dimensions mock
export const Dimensions = {
  get: (_dim: 'window' | 'screen') => ({
    width: 390,
    height: 844,
    scale: 3,
    fontScale: 1,
  }),
  addEventListener: () => ({ remove: () => {} }),
};

// TurboModuleRegistry mock
export const TurboModuleRegistry = {
  get: (_name: string) => null,
  getEnforcing: (_name: string) => ({}),
};

// Common components
export const TouchableOpacity = View;
export const TouchableHighlight = View;
export const TouchableWithoutFeedback = View;
export const ScrollView = View;
export const FlatList = View;
export const TextInput = View;
export const Image = View;
export const SafeAreaView = View;
export const KeyboardAvoidingView = View;
export const Switch = View;
export const Button = View;

// Default export
export default {
  View,
  Text,
  ActivityIndicator,
  StyleSheet,
  Platform,
  Dimensions,
  TouchableOpacity,
  TouchableHighlight,
  TouchableWithoutFeedback,
  ScrollView,
  FlatList,
  TextInput,
  Image,
  SafeAreaView,
  KeyboardAvoidingView,
  Switch,
  Button,
  TurboModuleRegistry,
};
