/**
 * TouchableOpacity Component
 *
 * Default touchable component implementation, wrapping React Native TouchableOpacity
 * Uses forwardRef to allow parent components to get native view reference
 */

import React from 'react';
import { TouchableOpacity as RNTouchableOpacity, type ViewStyle } from 'react-native';

export interface TouchableOpacityProps {
  style?: ViewStyle;
  children?: React.ReactNode;
  onPress?: () => void;
  onPressIn?: () => void;
  onPressOut?: () => void;
  onLongPress?: () => void;
  activeOpacity?: number;
  disabled?: boolean;
  delayPressIn?: number;
  delayPressOut?: number;
  delayLongPress?: number;
  testID?: string;
  accessible?: boolean;
  accessibilityLabel?: string;
  accessibilityRole?: 'button' | 'link' | 'none';
}

export const TouchableOpacity = React.forwardRef<
  React.ComponentRef<typeof RNTouchableOpacity>,
  TouchableOpacityProps
>(
  (
    {
      style,
      children,
      onPress,
      onPressIn,
      onPressOut,
      onLongPress,
      activeOpacity = 0.7,
      disabled = false,
      delayPressIn,
      delayPressOut,
      delayLongPress,
      testID,
      accessible,
      accessibilityLabel,
      accessibilityRole = 'button',
    },
    ref
  ) => {
    // Wrap callbacks to not pass the GestureResponderEvent to Guest
    // The event object contains native references that cannot be serialized across JSI boundary
    // This matches the TypeScript signature: onPress?: () => void
    return (
      <RNTouchableOpacity
        ref={ref}
        style={style}
        onPress={onPress ? () => onPress() : undefined}
        onPressIn={onPressIn ? () => onPressIn() : undefined}
        onPressOut={onPressOut ? () => onPressOut() : undefined}
        onLongPress={onLongPress ? () => onLongPress() : undefined}
        activeOpacity={activeOpacity}
        disabled={disabled}
        delayPressIn={delayPressIn}
        delayPressOut={delayPressOut}
        delayLongPress={delayLongPress}
        testID={testID}
        accessible={accessible}
        accessibilityLabel={accessibilityLabel}
        accessibilityRole={accessibilityRole}
      >
        {children}
      </RNTouchableOpacity>
    );
  }
);

TouchableOpacity.displayName = 'TouchableOpacity';

export default TouchableOpacity;
