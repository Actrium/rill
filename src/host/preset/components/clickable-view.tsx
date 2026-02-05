/**
 * ClickableView Component
 *
 * A clickable View component that works on macOS by using mouse events
 * Uses forwardRef to allow parent components to get native view reference
 */

import React from 'react';
import { View, type ViewStyle } from 'react-native';

export interface ClickableViewProps {
  style?: ViewStyle;
  children?: React.ReactNode;
  onPress?: () => void;
  activeOpacity?: number;
  disabled?: boolean;
  testID?: string;
  accessible?: boolean;
  accessibilityLabel?: string;
  accessibilityRole?: 'button' | 'link' | 'none';
}

export const ClickableView = React.forwardRef<React.ComponentRef<typeof View>, ClickableViewProps>(
  (
    {
      style,
      children,
      onPress,
      activeOpacity = 0.7,
      disabled = false,
      testID,
      accessible,
      accessibilityLabel,
      accessibilityRole = 'button',
    },
    ref
  ) => {
    const [isPressed, setIsPressed] = React.useState(false);

    const handleMouseDown = () => {
      if (!disabled) {
        setIsPressed(true);
      }
    };

    const handleMouseUp = () => {
      if (!disabled) {
        setIsPressed(false);
        onPress?.();
      }
    };

    const handleMouseLeave = () => {
      setIsPressed(false);
    };

    const combinedStyle: ViewStyle = {
      ...style,
      opacity: isPressed ? activeOpacity : 1,
      cursor: disabled ? 'auto' : 'pointer',
    };

    // Mouse handlers for macOS - not in RN's View type but supported by react-native-macos
    const mouseHandlers: Record<string, () => void> = {
      onMouseDown: handleMouseDown,
      onMouseUp: handleMouseUp,
      onMouseLeave: handleMouseLeave,
    };

    return (
      <View
        ref={ref}
        style={combinedStyle}
        {...mouseHandlers}
        testID={testID}
        accessible={accessible}
        accessibilityLabel={accessibilityLabel}
        accessibilityRole={accessibilityRole}
      >
        {children}
      </View>
    );
  }
);

ClickableView.displayName = 'ClickableView';

export default ClickableView;
