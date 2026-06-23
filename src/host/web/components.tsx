/**
 * Thin-DOM component preset for the web host (issue #19, L2).
 *
 * A tiny, auditable mapping of the common rill primitives onto native DOM elements
 * (View→div, Text→span, Pressable→button, ScrollView→div, TextInput→input/textarea, …) —
 * no react-native-web. Every component is small and overridable, and none carries a
 * mandatory URL/network-bearing prop, so a sealing integrator doesn't have to fork. Use
 * `WebComponents` with `engine.register(...)`, or override any single entry.
 *
 * For RN cross-platform parity, integrators can keep the react-native-web preset
 * (`rill/host/preset`) instead — both are just fillings of the pluggable ComponentRegistry.
 */

import React, { type CSSProperties, type ReactNode } from 'react';
import { toWebStyle, type WebStyleInput, withBaseStyle } from './style';

// RN containers are flexbox-column boxes; DOM blocks are not — give every container the
// RN-default layout so guest styles behave as authored.
const CONTAINER_BASE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  position: 'relative',
  boxSizing: 'border-box',
};

// Strip the browser's default <button> chrome so a Pressable behaves like a View.
const BUTTON_RESET: CSSProperties = {
  ...CONTAINER_BASE,
  margin: 0,
  padding: 0,
  border: 'none',
  background: 'none',
  font: 'inherit',
  color: 'inherit',
  textAlign: 'inherit',
  cursor: 'pointer',
};

// ---- View ----

export interface WebViewProps {
  style?: WebStyleInput;
  children?: ReactNode;
  testID?: string;
  id?: string;
  pointerEvents?: 'auto' | 'none' | 'box-none' | 'box-only';
}

export const View = React.forwardRef<HTMLDivElement, WebViewProps>(function View(
  { style, children, testID, id, pointerEvents },
  ref
) {
  const css = withBaseStyle(CONTAINER_BASE, style);
  if (pointerEvents === 'none' || pointerEvents === 'box-only') css.pointerEvents = 'none';
  return (
    <div ref={ref} id={id} data-testid={testID} style={css}>
      {children}
    </div>
  );
});
View.displayName = 'View';

// ---- Text ----

export interface WebTextProps {
  style?: WebStyleInput;
  children?: ReactNode;
  testID?: string;
  numberOfLines?: number;
}

export const Text = React.forwardRef<HTMLSpanElement, WebTextProps>(function Text(
  { style, children, testID, numberOfLines },
  ref
) {
  const css = toWebStyle(style);
  if (numberOfLines === 1) {
    css.whiteSpace = 'nowrap';
    css.overflow = 'hidden';
    css.textOverflow = 'ellipsis';
  } else if (typeof numberOfLines === 'number' && numberOfLines > 1) {
    css.display = '-webkit-box';
    css.WebkitBoxOrient = 'vertical';
    css.WebkitLineClamp = numberOfLines;
    css.overflow = 'hidden';
  }
  return (
    <span ref={ref} data-testid={testID} style={css}>
      {children}
    </span>
  );
});
Text.displayName = 'Text';

// ---- Pressable / TouchableOpacity ----

export interface WebPressableProps {
  style?: WebStyleInput;
  children?: ReactNode;
  testID?: string;
  onPress?: () => void;
  disabled?: boolean;
  accessibilityLabel?: string;
}

export const Pressable = React.forwardRef<HTMLButtonElement, WebPressableProps>(function Pressable(
  { style, children, testID, onPress, disabled, accessibilityLabel },
  ref
) {
  return (
    <button
      ref={ref}
      type="button"
      data-testid={testID}
      aria-label={accessibilityLabel}
      disabled={disabled}
      onClick={onPress ? () => onPress() : undefined}
      style={withBaseStyle(BUTTON_RESET, style)}
    >
      {children}
    </button>
  );
});
Pressable.displayName = 'Pressable';

// TouchableOpacity is Pressable with a hover/active opacity affordance.
export const TouchableOpacity = React.forwardRef<HTMLButtonElement, WebPressableProps>(
  function TouchableOpacity(props, ref) {
    return <Pressable ref={ref} {...props} />;
  }
);
TouchableOpacity.displayName = 'TouchableOpacity';

// ---- ScrollView ----

export interface WebScrollEvent {
  nativeEvent: { contentOffset: { x: number; y: number } };
}

export interface WebScrollViewProps {
  style?: WebStyleInput;
  contentContainerStyle?: WebStyleInput;
  children?: ReactNode;
  testID?: string;
  horizontal?: boolean;
  onScroll?: (event: WebScrollEvent) => void;
}

export const ScrollView = React.forwardRef<HTMLDivElement, WebScrollViewProps>(function ScrollView(
  { style, contentContainerStyle, children, testID, horizontal, onScroll },
  ref
) {
  const outer = withBaseStyle(
    {
      ...CONTAINER_BASE,
      flexDirection: horizontal ? 'row' : 'column',
      overflowX: horizontal ? 'auto' : 'hidden',
      overflowY: horizontal ? 'hidden' : 'auto',
    },
    style
  );
  const inner = withBaseStyle(
    { display: 'flex', flexDirection: horizontal ? 'row' : 'column' },
    contentContainerStyle
  );
  return (
    <div
      ref={ref}
      data-testid={testID}
      style={outer}
      onScroll={
        onScroll
          ? (e: React.UIEvent<HTMLDivElement>) =>
              onScroll({
                nativeEvent: {
                  contentOffset: { x: e.currentTarget.scrollLeft, y: e.currentTarget.scrollTop },
                },
              })
          : undefined
      }
    >
      <div style={inner}>{children}</div>
    </div>
  );
});
ScrollView.displayName = 'ScrollView';

// ---- TextInput ----

export interface WebTextInputProps {
  style?: WebStyleInput;
  testID?: string;
  value?: string;
  defaultValue?: string;
  placeholder?: string;
  onChangeText?: (text: string) => void;
  onSubmitEditing?: () => void;
  secureTextEntry?: boolean;
  multiline?: boolean;
  editable?: boolean;
  maxLength?: number;
}

export const TextInput = React.forwardRef<
  HTMLInputElement | HTMLTextAreaElement,
  WebTextInputProps
>(function TextInput(
  {
    style,
    testID,
    value,
    defaultValue,
    placeholder,
    onChangeText,
    onSubmitEditing,
    secureTextEntry,
    multiline,
    editable,
    maxLength,
  },
  ref
) {
  const css = toWebStyle(style);
  const onChange = onChangeText
    ? (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => onChangeText(e.target.value)
    : undefined;
  if (multiline) {
    return (
      <textarea
        ref={ref as React.Ref<HTMLTextAreaElement>}
        data-testid={testID}
        value={value}
        defaultValue={defaultValue}
        placeholder={placeholder}
        readOnly={editable === false}
        maxLength={maxLength}
        onChange={onChange}
        style={css}
      />
    );
  }
  return (
    <input
      ref={ref as React.Ref<HTMLInputElement>}
      type={secureTextEntry ? 'password' : 'text'}
      data-testid={testID}
      value={value}
      defaultValue={defaultValue}
      placeholder={placeholder}
      readOnly={editable === false}
      maxLength={maxLength}
      onChange={onChange}
      onKeyDown={
        onSubmitEditing
          ? (e: React.KeyboardEvent<HTMLInputElement>) => {
              if (e.key === 'Enter') onSubmitEditing();
            }
          : undefined
      }
      style={css}
    />
  );
});
TextInput.displayName = 'TextInput';

// ---- Button (RN Button: title + onPress) ----

export interface WebButtonProps {
  title: string;
  onPress?: () => void;
  color?: string;
  disabled?: boolean;
  testID?: string;
}

export function Button({ title, onPress, color, disabled, testID }: WebButtonProps) {
  return (
    <button
      type="button"
      data-testid={testID}
      disabled={disabled}
      onClick={onPress ? () => onPress() : undefined}
      style={color ? { color } : undefined}
    >
      {title}
    </button>
  );
}

// ---- ActivityIndicator ----

export interface WebActivityIndicatorProps {
  style?: WebStyleInput;
  size?: 'small' | 'large' | number;
  color?: string;
  testID?: string;
}

export function ActivityIndicator({ style, size, color, testID }: WebActivityIndicatorProps) {
  const dim = size === 'large' ? 36 : typeof size === 'number' ? size : 20;
  return (
    <span
      role="progressbar"
      aria-busy="true"
      data-testid={testID}
      style={{
        display: 'inline-block',
        width: dim,
        height: dim,
        border: `2px solid ${color ?? '#888'}`,
        borderTopColor: 'transparent',
        borderRadius: '50%',
        ...toWebStyle(style),
      }}
    />
  );
}

/**
 * Default thin-DOM component registry. Register with `engine.register(WebComponents)`.
 * `Pressable` and `TouchableOpacity` are both provided; guests may use either name.
 */
export const WebComponents = {
  View,
  Text,
  Pressable,
  TouchableOpacity,
  ScrollView,
  TextInput,
  Button,
  ActivityIndicator,
} as const;

export type WebComponentName = keyof typeof WebComponents;
