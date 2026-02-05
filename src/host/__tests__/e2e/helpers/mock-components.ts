/**
 * Mock React Native components for E2E testing
 *
 * These are lightweight replacements that don't depend on React Native.
 * Each component returns a plain object with test helper methods.
 */

import type { ReviewedUnknown } from '../../../types';

export interface MockNode {
  type: string;
  props: Record<string, ReviewedUnknown>;
  children?: ReviewedUnknown;
  [key: string]: ReviewedUnknown;
}

export const MockComponents = {
  /**
   * View - Basic container component
   */
  // biome-ignore lint/suspicious/noExplicitAny: Mock component with flexible props
  View: ({ children, testID, style, onLayout, ...props }: any): MockNode => ({
    type: 'View',
    props: { testID, style, onLayout, ...props },
    children,
    // biome-ignore lint/suspicious/noExplicitAny: Mock layout event with dynamic structure
    __testTriggerLayout: (event: any) => onLayout?.(event),
  }),

  /**
   * Text - Text display component
   */
  // biome-ignore lint/suspicious/noExplicitAny: Mock component with flexible props
  Text: ({ children, testID, style, numberOfLines, ...props }: any): MockNode => ({
    type: 'Text',
    props: { testID, style, numberOfLines, ...props },
    children: String(children ?? ''),
  }),

  /**
   * TouchableOpacity - Pressable component with opacity feedback
   */
  TouchableOpacity: ({
    children,
    onPress,
    onPressIn,
    onPressOut,
    disabled,
    testID,
    activeOpacity,
    ...props
    // biome-ignore lint/suspicious/noExplicitAny: Mock component with flexible props
  }: any): MockNode => ({
    type: 'TouchableOpacity',
    props: { onPress, onPressIn, onPressOut, disabled, testID, activeOpacity, ...props },
    children,
    __testPress: async () => {
      if (disabled) return;
      onPressIn?.();
      await onPress?.();
      onPressOut?.();
    },
    __testPressIn: () => !disabled && onPressIn?.(),
    __testPressOut: () => !disabled && onPressOut?.(),
  }),

  /**
   * TextInput - Text input component
   */
  TextInput: ({
    value,
    defaultValue,
    onChangeText,
    onSubmitEditing,
    onFocus,
    onBlur,
    placeholder,
    testID,
    editable,
    ...props
    // biome-ignore lint/suspicious/noExplicitAny: Mock component with flexible props
  }: any): MockNode => ({
    type: 'TextInput',
    props: { value, defaultValue, placeholder, testID, editable, ...props },
    __testChangeText: (text: string) => editable !== false && onChangeText?.(text),
    __testSubmit: () => editable !== false && onSubmitEditing?.({ nativeEvent: { text: value } }),
    __testFocus: () => editable !== false && onFocus?.(),
    __testBlur: () => editable !== false && onBlur?.(),
  }),

  /**
   * ScrollView - Scrollable container
   */
  ScrollView: ({
    children,
    testID,
    onScroll,
    onScrollBeginDrag,
    onScrollEndDrag,
    scrollEnabled,
    ...props
    // biome-ignore lint/suspicious/noExplicitAny: Mock component with flexible props
  }: any): MockNode => ({
    type: 'ScrollView',
    props: { testID, scrollEnabled, ...props },
    children,
    __testScroll: (
      // biome-ignore lint/suspicious/noExplicitAny: Mock event with dynamic structure
      event: any
    ) => scrollEnabled !== false && onScroll?.(event),
    __testScrollBeginDrag: () => scrollEnabled !== false && onScrollBeginDrag?.(),
    __testScrollEndDrag: () => scrollEnabled !== false && onScrollEndDrag?.(),
  }),

  /**
   * FlatList - Optimized list component
   */
  FlatList: ({
    data,
    renderItem,
    keyExtractor,
    testID,
    onEndReached,
    onRefresh,
    refreshing,
    ...props
    // biome-ignore lint/suspicious/noExplicitAny: Mock component with flexible props
  }: any): MockNode => ({
    type: 'FlatList',
    props: { testID, data, refreshing, ...props },
    // biome-ignore lint/suspicious/noExplicitAny: FlatList data items can be any type
    children: data?.map((item: any, index: number) => renderItem({ item, index, separators: {} })),
    __testEndReached: () => onEndReached?.({ distanceFromEnd: 0 }),
    __testRefresh: () => onRefresh?.(),
  }),

  /**
   * Image - Image component
   */
  // biome-ignore lint/suspicious/noExplicitAny: Mock component with flexible props
  Image: ({ source, testID, style, onLoad, onError, ...props }: any): MockNode => ({
    type: 'Image',
    props: { source, testID, style, ...props },
    __testLoad: () => onLoad?.({ nativeEvent: { source } }),
    // biome-ignore lint/suspicious/noExplicitAny: Mock error with dynamic structure
    __testError: (error: any) => onError?.({ nativeEvent: { error } }),
  }),

  /**
   * Switch - Toggle switch component
   */
  // biome-ignore lint/suspicious/noExplicitAny: Mock component with flexible props
  Switch: ({ value, onValueChange, testID, disabled, ...props }: any): MockNode => ({
    type: 'Switch',
    props: { value, testID, disabled, ...props },
    __testToggle: () => !disabled && onValueChange?.(!value),
  }),

  /**
   * ActivityIndicator - Loading spinner
   */
  // biome-ignore lint/suspicious/noExplicitAny: Mock component with flexible props
  ActivityIndicator: ({ animating, size, color, testID, ...props }: any): MockNode => ({
    type: 'ActivityIndicator',
    props: { animating, size, color, testID, ...props },
  }),

  /**
   * Modal - Modal dialog component
   */
  Modal: ({
    visible,
    children,
    onRequestClose,
    onShow,
    transparent,
    testID,
    ...props
    // biome-ignore lint/suspicious/noExplicitAny: Mock component with flexible props
  }: any): MockNode => ({
    type: 'Modal',
    props: { visible, transparent, testID, ...props },
    children: visible ? children : null,
    __testRequestClose: () => onRequestClose?.(),
    __testShow: () => onShow?.(),
  }),

  /**
   * Pressable - Highly customizable pressable component
   */
  Pressable: ({
    children,
    onPress,
    onPressIn,
    onPressOut,
    onLongPress,
    disabled,
    testID,
    ...props
    // biome-ignore lint/suspicious/noExplicitAny: Mock component with flexible props
  }: any): MockNode => ({
    type: 'Pressable',
    props: { disabled, testID, ...props },
    children: typeof children === 'function' ? children({ pressed: false }) : children,
    __testPress: async () => {
      if (disabled) return;
      onPressIn?.({ nativeEvent: {} });
      await onPress?.({ nativeEvent: {} });
      onPressOut?.({ nativeEvent: {} });
    },
    __testLongPress: () => !disabled && onLongPress?.({ nativeEvent: {} }),
  }),
};

/**
 * Type definition for MockComponents
 */
export type MockComponentsType = typeof MockComponents;
