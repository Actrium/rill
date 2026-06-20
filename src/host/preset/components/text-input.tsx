/**
 * TextInput Component
 *
 * Default TextInput component implementation, wrapping React Native TextInput
 * Uses forwardRef to allow parent components to get native view reference
 */

import React from 'react';
import { TextInput as RNTextInput, type TextStyle, type ViewStyle } from 'react-native';

export interface TextInputProps {
  value?: string;
  defaultValue?: string;
  placeholder?: string;
  placeholderTextColor?: string;
  onChangeText?: (text: string) => void;
  onFocus?: () => void;
  onBlur?: () => void;
  onSubmitEditing?: () => void;
  style?: TextStyle | ViewStyle;
  multiline?: boolean;
  numberOfLines?: number;
  maxLength?: number;
  secureTextEntry?: boolean;
  autoCapitalize?: 'none' | 'sentences' | 'words' | 'characters';
  autoCorrect?: boolean;
  autoFocus?: boolean;
  keyboardType?:
    | 'default'
    | 'email-address'
    | 'numeric'
    | 'phone-pad'
    | 'decimal-pad'
    | 'number-pad'
    | 'url';
  returnKeyType?: 'done' | 'go' | 'next' | 'search' | 'send';
  editable?: boolean;
  selectTextOnFocus?: boolean;
  testID?: string;
  accessible?: boolean;
  accessibilityLabel?: string;
}

export const TextInput = React.forwardRef<React.ComponentRef<typeof RNTextInput>, TextInputProps>(
  (
    {
      value,
      defaultValue,
      placeholder,
      placeholderTextColor,
      onChangeText,
      onFocus,
      onBlur,
      onSubmitEditing,
      style,
      multiline,
      numberOfLines,
      maxLength,
      secureTextEntry,
      autoCapitalize,
      autoCorrect,
      autoFocus,
      keyboardType,
      returnKeyType,
      editable,
      selectTextOnFocus,
      testID,
      accessible,
      accessibilityLabel,
    },
    ref
  ) => {
    // Wrap focus/blur/submit callbacks to not pass event objects to Guest
    // RN passes NativeSyntheticEvent which contains native references
    return (
      <RNTextInput
        ref={ref}
        value={value}
        defaultValue={defaultValue}
        placeholder={placeholder}
        placeholderTextColor={placeholderTextColor}
        onChangeText={onChangeText}
        onFocus={onFocus ? () => onFocus() : undefined}
        onBlur={onBlur ? () => onBlur() : undefined}
        onSubmitEditing={onSubmitEditing ? () => onSubmitEditing() : undefined}
        style={style}
        multiline={multiline}
        numberOfLines={numberOfLines}
        maxLength={maxLength}
        secureTextEntry={secureTextEntry}
        autoCapitalize={autoCapitalize}
        autoCorrect={autoCorrect}
        autoFocus={autoFocus}
        keyboardType={keyboardType}
        returnKeyType={returnKeyType}
        editable={editable}
        selectTextOnFocus={selectTextOnFocus}
        testID={testID}
        accessible={accessible}
        accessibilityLabel={accessibilityLabel}
      />
    );
  }
);

TextInput.displayName = 'TextInput';

export default TextInput;
