/**
 * Button Component
 *
 * Default Button component implementation, wrapping React Native Button
 * Note: RN Button doesn't support ref, but we use forwardRef for API consistency
 */

import React from 'react';
import { Button as RNButton, View as RNView } from 'react-native';

export interface ButtonProps {
  title: string;
  onPress: () => void;
  color?: string;
  disabled?: boolean;
  testID?: string;
  accessibilityLabel?: string;
}

// RN Button doesn't support ref directly, so we wrap it in a View to enable ref
export const Button = React.forwardRef<React.ComponentRef<typeof RNView>, ButtonProps>(
  ({ title, onPress, color, disabled, testID, accessibilityLabel }, ref) => {
    // Wrap onPress to not pass the GestureResponderEvent to Guest
    // The event object contains native references that cannot be serialized across JSI boundary
    return (
      <RNView ref={ref} collapsable={false}>
        <RNButton
          title={title}
          onPress={() => onPress()}
          color={color}
          disabled={disabled}
          testID={testID}
          accessibilityLabel={accessibilityLabel}
        />
      </RNView>
    );
  }
);

Button.displayName = 'Button';

export default Button;
