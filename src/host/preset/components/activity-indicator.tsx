/**
 * ActivityIndicator Component
 *
 * Default ActivityIndicator component implementation, wrapping React Native ActivityIndicator
 * Uses forwardRef to allow parent components to get native view reference
 */

import React from 'react';
import {
  ActivityIndicator as RNActivityIndicator,
  View as RNView,
  type ViewStyle,
} from 'react-native';

export interface ActivityIndicatorProps {
  animating?: boolean;
  color?: string;
  size?: 'small' | 'large' | number;
  hidesWhenStopped?: boolean;
  style?: ViewStyle;
  testID?: string;
  accessible?: boolean;
  accessibilityLabel?: string;
}

// Wrap in View to support ref (ActivityIndicator may not support ref directly on all platforms)
export const ActivityIndicator = React.forwardRef<
  React.ComponentRef<typeof RNView>,
  ActivityIndicatorProps
>(
  (
    {
      animating = true,
      color,
      size = 'small',
      hidesWhenStopped = true,
      style,
      testID,
      accessible,
      accessibilityLabel,
    },
    ref
  ) => {
    return (
      <RNView ref={ref} collapsable={false} style={style}>
        <RNActivityIndicator
          animating={animating}
          color={color}
          size={size}
          hidesWhenStopped={hidesWhenStopped}
          testID={testID}
          accessible={accessible}
          accessibilityLabel={accessibilityLabel}
        />
      </RNView>
    );
  }
);

ActivityIndicator.displayName = 'ActivityIndicator';

export default ActivityIndicator;
