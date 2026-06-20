/**
 * View Component
 *
 * Default View component implementation, wrapping React Native View
 * Uses forwardRef to allow parent components to get native view reference
 */

import React from 'react';
import { View as RNView, type ViewStyle } from 'react-native';

export interface ViewProps {
  style?: ViewStyle;
  children?: React.ReactNode;
  testID?: string;
  pointerEvents?: 'auto' | 'none' | 'box-none' | 'box-only';
  accessible?: boolean;
  accessibilityLabel?: string;
  collapsable?: boolean;
  onLayout?: (event: {
    nativeEvent: {
      layout: { x: number; y: number; width: number; height: number };
    };
  }) => void;
}

export const View = React.forwardRef<React.ComponentRef<typeof RNView>, ViewProps>(
  (
    {
      style,
      children,
      testID,
      pointerEvents,
      accessible,
      accessibilityLabel,
      collapsable,
      onLayout,
    },
    ref
  ) => {
    // Sanitize layout event to only pass serializable data
    const handleLayout = onLayout
      ? (event: {
          nativeEvent: { layout: { x: number; y: number; width: number; height: number } };
        }) => {
          onLayout({
            nativeEvent: {
              layout: {
                x: event.nativeEvent.layout.x,
                y: event.nativeEvent.layout.y,
                width: event.nativeEvent.layout.width,
                height: event.nativeEvent.layout.height,
              },
            },
          });
        }
      : undefined;

    return (
      <RNView
        ref={ref}
        style={style}
        testID={testID}
        pointerEvents={pointerEvents}
        accessible={accessible}
        accessibilityLabel={accessibilityLabel}
        collapsable={collapsable}
        onLayout={handleLayout}
      >
        {children}
      </RNView>
    );
  }
);

View.displayName = 'View';

export default View;
