/**
 * Text Component
 *
 * Default Text component implementation, wrapping React Native Text
 * Uses forwardRef to allow parent components to get native view reference
 */

import React from 'react';
import { Text as RNText, type TextStyle } from 'react-native';

export interface TextProps {
  style?: TextStyle;
  children?: React.ReactNode;
  numberOfLines?: number;
  ellipsizeMode?: 'head' | 'middle' | 'tail' | 'clip';
  selectable?: boolean;
  testID?: string;
  accessible?: boolean;
  accessibilityLabel?: string;
  onPress?: () => void;
  onLongPress?: () => void;
}

export const Text = React.forwardRef<React.ComponentRef<typeof RNText>, TextProps>(
  (
    {
      style,
      children,
      numberOfLines,
      ellipsizeMode,
      selectable,
      testID,
      accessible,
      accessibilityLabel,
      onPress,
      onLongPress,
    },
    ref
  ) => {
    // Wrap callbacks to not pass GestureResponderEvent to Guest
    // The event object contains native references that cannot be serialized across JSI boundary
    return (
      <RNText
        ref={ref}
        style={style}
        numberOfLines={numberOfLines}
        ellipsizeMode={ellipsizeMode}
        selectable={selectable}
        testID={testID}
        accessible={accessible}
        accessibilityLabel={accessibilityLabel}
        onPress={onPress ? () => onPress() : undefined}
        onLongPress={onLongPress ? () => onLongPress() : undefined}
      >
        {children}
      </RNText>
    );
  }
);

Text.displayName = 'Text';

export default Text;
