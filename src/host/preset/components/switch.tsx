/**
 * Switch Component
 *
 * Default Switch component implementation, wrapping React Native Switch
 * Uses forwardRef to allow parent components to get native view reference
 */

import React from 'react';
import { Switch as RNSwitch, View as RNView } from 'react-native';

export interface SwitchProps {
  value?: boolean;
  onValueChange?: (value: boolean) => void;
  disabled?: boolean;
  trackColor?: { false?: string; true?: string };
  thumbColor?: string;
  ios_backgroundColor?: string;
  testID?: string;
  accessible?: boolean;
  accessibilityLabel?: string;
}

// Wrap in View to support ref (Switch may not support ref directly on all platforms)
export const Switch = React.forwardRef<React.ComponentRef<typeof RNView>, SwitchProps>(
  (
    {
      value,
      onValueChange,
      disabled,
      trackColor,
      thumbColor,
      ios_backgroundColor,
      testID,
      accessible,
      accessibilityLabel,
    },
    ref
  ) => {
    return (
      <RNView ref={ref} collapsable={false}>
        <RNSwitch
          value={value}
          onValueChange={onValueChange}
          disabled={disabled}
          trackColor={trackColor}
          thumbColor={thumbColor}
          ios_backgroundColor={ios_backgroundColor}
          testID={testID}
          accessible={accessible}
          accessibilityLabel={accessibilityLabel}
        />
      </RNView>
    );
  }
);

Switch.displayName = 'Switch';

export default Switch;
