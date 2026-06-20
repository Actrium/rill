/**
 * ScrollView Component
 *
 * Default scroll view component implementation, wrapping React Native ScrollView
 * Uses forwardRef to allow parent components to get native view reference
 */

import React from 'react';
import {
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  ScrollView as RNScrollView,
  type ViewStyle,
} from 'react-native';

export interface ScrollEvent {
  nativeEvent: {
    contentOffset: { x: number; y: number };
    contentSize: { width: number; height: number };
    layoutMeasurement: { width: number; height: number };
  };
}

export interface ScrollViewProps {
  style?: ViewStyle;
  contentContainerStyle?: ViewStyle;
  children?: React.ReactNode;
  horizontal?: boolean;
  showsVerticalScrollIndicator?: boolean;
  showsHorizontalScrollIndicator?: boolean;
  pagingEnabled?: boolean;
  bounces?: boolean;
  scrollEnabled?: boolean;
  scrollEventThrottle?: number;
  keyboardShouldPersistTaps?: 'always' | 'never' | 'handled';
  keyboardDismissMode?: 'none' | 'on-drag' | 'interactive';
  testID?: string;
  onScroll?: (event: ScrollEvent) => void;
  onScrollBeginDrag?: (event: ScrollEvent) => void;
  onScrollEndDrag?: (event: ScrollEvent) => void;
  onMomentumScrollBegin?: (event: ScrollEvent) => void;
  onMomentumScrollEnd?: (event: ScrollEvent) => void;
}

export const ScrollView = React.forwardRef<
  React.ComponentRef<typeof RNScrollView>,
  ScrollViewProps
>(
  (
    {
      style,
      contentContainerStyle,
      children,
      horizontal = false,
      showsVerticalScrollIndicator = true,
      showsHorizontalScrollIndicator = true,
      pagingEnabled = false,
      bounces = true,
      scrollEnabled = true,
      scrollEventThrottle = 16,
      keyboardShouldPersistTaps,
      keyboardDismissMode,
      testID,
      onScroll,
      onScrollBeginDrag,
      onScrollEndDrag,
      onMomentumScrollBegin,
      onMomentumScrollEnd,
    },
    ref
  ) => {
    // Convert event format
    const handleScroll = onScroll
      ? (event: NativeSyntheticEvent<NativeScrollEvent>) => {
          onScroll({
            nativeEvent: {
              contentOffset: event.nativeEvent.contentOffset,
              contentSize: event.nativeEvent.contentSize,
              layoutMeasurement: event.nativeEvent.layoutMeasurement,
            },
          });
        }
      : undefined;

    const handleScrollBeginDrag = onScrollBeginDrag
      ? (event: NativeSyntheticEvent<NativeScrollEvent>) => {
          onScrollBeginDrag({
            nativeEvent: {
              contentOffset: event.nativeEvent.contentOffset,
              contentSize: event.nativeEvent.contentSize,
              layoutMeasurement: event.nativeEvent.layoutMeasurement,
            },
          });
        }
      : undefined;

    const handleScrollEndDrag = onScrollEndDrag
      ? (event: NativeSyntheticEvent<NativeScrollEvent>) => {
          onScrollEndDrag({
            nativeEvent: {
              contentOffset: event.nativeEvent.contentOffset,
              contentSize: event.nativeEvent.contentSize,
              layoutMeasurement: event.nativeEvent.layoutMeasurement,
            },
          });
        }
      : undefined;

    const handleMomentumScrollBegin = onMomentumScrollBegin
      ? (event: NativeSyntheticEvent<NativeScrollEvent>) => {
          onMomentumScrollBegin({
            nativeEvent: {
              contentOffset: event.nativeEvent.contentOffset,
              contentSize: event.nativeEvent.contentSize,
              layoutMeasurement: event.nativeEvent.layoutMeasurement,
            },
          });
        }
      : undefined;

    const handleMomentumScrollEnd = onMomentumScrollEnd
      ? (event: NativeSyntheticEvent<NativeScrollEvent>) => {
          onMomentumScrollEnd({
            nativeEvent: {
              contentOffset: event.nativeEvent.contentOffset,
              contentSize: event.nativeEvent.contentSize,
              layoutMeasurement: event.nativeEvent.layoutMeasurement,
            },
          });
        }
      : undefined;

    return (
      <RNScrollView
        ref={ref}
        style={style}
        contentContainerStyle={contentContainerStyle}
        horizontal={horizontal}
        showsVerticalScrollIndicator={showsVerticalScrollIndicator}
        showsHorizontalScrollIndicator={showsHorizontalScrollIndicator}
        pagingEnabled={pagingEnabled}
        bounces={bounces}
        scrollEnabled={scrollEnabled}
        scrollEventThrottle={scrollEventThrottle}
        keyboardShouldPersistTaps={keyboardShouldPersistTaps}
        keyboardDismissMode={keyboardDismissMode}
        testID={testID}
        onScroll={handleScroll}
        onScrollBeginDrag={handleScrollBeginDrag}
        onScrollEndDrag={handleScrollEndDrag}
        onMomentumScrollBegin={handleMomentumScrollBegin}
        onMomentumScrollEnd={handleMomentumScrollEnd}
      >
        {children}
      </RNScrollView>
    );
  }
);

ScrollView.displayName = 'ScrollView';

export default ScrollView;
