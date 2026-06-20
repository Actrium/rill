/**
 * Shared Style Type Definitions
 *
 * Shared between Guest (rill/guest) and Host (runtime) sides.
 * These types define the style system used across the boundary.
 */

// ============================================
// Flexbox Types
// ============================================

/**
 * Flexbox direction
 */
export type FlexDirection = 'row' | 'column' | 'row-reverse' | 'column-reverse';

/**
 * Flexbox alignment
 */
export type FlexAlign = 'flex-start' | 'flex-end' | 'center' | 'stretch' | 'baseline';

/**
 * Flexbox justify
 */
export type FlexJustify =
  | 'flex-start'
  | 'flex-end'
  | 'center'
  | 'space-between'
  | 'space-around'
  | 'space-evenly';

// ============================================
// Style Object
// ============================================

/**
 * Style object type
 *
 * Follows React Native style conventions for cross-platform compatibility.
 */
export interface StyleObject {
  // Layout
  flex?: number;
  flexDirection?: FlexDirection;
  justifyContent?: FlexJustify;
  alignItems?: FlexAlign;
  alignSelf?: FlexAlign;
  flexWrap?: 'wrap' | 'nowrap' | 'wrap-reverse';
  flexGrow?: number;
  flexShrink?: number;
  flexBasis?: number | string;

  // Spacing
  padding?: number;
  paddingTop?: number;
  paddingRight?: number;
  paddingBottom?: number;
  paddingLeft?: number;
  paddingHorizontal?: number;
  paddingVertical?: number;
  margin?: number;
  marginTop?: number;
  marginRight?: number;
  marginBottom?: number;
  marginLeft?: number;
  marginHorizontal?: number;
  marginVertical?: number;

  // Size
  width?: number | string;
  height?: number | string;
  minWidth?: number | string;
  minHeight?: number | string;
  maxWidth?: number | string;
  maxHeight?: number | string;

  // Position
  position?: 'relative' | 'absolute';
  top?: number;
  right?: number;
  bottom?: number;
  left?: number;
  zIndex?: number;

  // Background
  backgroundColor?: string;
  opacity?: number;

  // Border
  borderWidth?: number;
  borderTopWidth?: number;
  borderRightWidth?: number;
  borderBottomWidth?: number;
  borderLeftWidth?: number;
  borderColor?: string;
  borderRadius?: number;
  borderTopLeftRadius?: number;
  borderTopRightRadius?: number;
  borderBottomLeftRadius?: number;
  borderBottomRightRadius?: number;

  // Text
  color?: string;
  fontSize?: number;
  fontWeight?:
    | 'normal'
    | 'bold'
    | '100'
    | '200'
    | '300'
    | '400'
    | '500'
    | '600'
    | '700'
    | '800'
    | '900';
  fontFamily?: string;
  fontStyle?: 'normal' | 'italic';
  textAlign?: 'auto' | 'left' | 'right' | 'center' | 'justify';
  textDecorationLine?: 'none' | 'underline' | 'line-through';
  lineHeight?: number;
  letterSpacing?: number;

  // Shadow (iOS)
  shadowColor?: string;
  shadowOffset?: { width: number; height: number };
  shadowOpacity?: number;
  shadowRadius?: number;

  // Elevation (Android)
  elevation?: number;

  // Transform
  transform?: Array<
    | { translateX: number }
    | { translateY: number }
    | { scale: number }
    | { scaleX: number }
    | { scaleY: number }
    | { rotate: string }
    | { rotateX: string }
    | { rotateY: string }
    | { rotateZ: string }
    | { skewX: string }
    | { skewY: string }
  >;

  // Other
  overflow?: 'visible' | 'hidden' | 'scroll';
}

/**
 * Style prop type (generic)
 */
export type StyleProp<T = StyleObject> = T | T[] | undefined | null | false;

// ============================================
// React Native Compatible Style Types
// ============================================

/**
 * View style type - for View component
 */
export type ViewStyle = Pick<
  StyleObject,
  | 'flex'
  | 'flexDirection'
  | 'justifyContent'
  | 'alignItems'
  | 'alignSelf'
  | 'flexWrap'
  | 'flexGrow'
  | 'flexShrink'
  | 'flexBasis'
  | 'padding'
  | 'paddingTop'
  | 'paddingRight'
  | 'paddingBottom'
  | 'paddingLeft'
  | 'paddingHorizontal'
  | 'paddingVertical'
  | 'margin'
  | 'marginTop'
  | 'marginRight'
  | 'marginBottom'
  | 'marginLeft'
  | 'marginHorizontal'
  | 'marginVertical'
  | 'width'
  | 'height'
  | 'minWidth'
  | 'minHeight'
  | 'maxWidth'
  | 'maxHeight'
  | 'position'
  | 'top'
  | 'right'
  | 'bottom'
  | 'left'
  | 'zIndex'
  | 'backgroundColor'
  | 'opacity'
  | 'borderWidth'
  | 'borderTopWidth'
  | 'borderRightWidth'
  | 'borderBottomWidth'
  | 'borderLeftWidth'
  | 'borderColor'
  | 'borderRadius'
  | 'borderTopLeftRadius'
  | 'borderTopRightRadius'
  | 'borderBottomLeftRadius'
  | 'borderBottomRightRadius'
  | 'shadowColor'
  | 'shadowOffset'
  | 'shadowOpacity'
  | 'shadowRadius'
  | 'elevation'
  | 'transform'
  | 'overflow'
>;

/**
 * Text style type - for Text component
 */
export type TextStyle = ViewStyle &
  Pick<
    StyleObject,
    | 'color'
    | 'fontSize'
    | 'fontWeight'
    | 'fontFamily'
    | 'fontStyle'
    | 'textAlign'
    | 'textDecorationLine'
    | 'lineHeight'
    | 'letterSpacing'
  >;

/**
 * Image style type - for Image component
 */
export type ImageStyle = ViewStyle & {
  resizeMode?: 'cover' | 'contain' | 'stretch' | 'repeat' | 'center';
  tintColor?: string;
  overlayColor?: string;
};

/**
 * Flex style type - layout only
 */
export type FlexStyle = Pick<
  StyleObject,
  | 'flex'
  | 'flexDirection'
  | 'justifyContent'
  | 'alignItems'
  | 'alignSelf'
  | 'flexWrap'
  | 'flexGrow'
  | 'flexShrink'
  | 'flexBasis'
>;

// ============================================
// Value Types
// ============================================

/**
 * Color value type
 */
export type ColorValue = string;

/**
 * Dimension value type
 */
export type DimensionValue = number | string | 'auto' | null | undefined;

// ============================================
// Event Types
// ============================================

import type { ReviewedUnknown } from './types';

/**
 * Layout Event
 */
export interface LayoutEvent {
  nativeEvent: {
    layout: {
      x: number;
      y: number;
      width: number;
      height: number;
    };
  };
}

/**
 * Scroll Event
 */
export interface ScrollEvent {
  nativeEvent: {
    contentOffset: { x: number; y: number };
    contentSize: { width: number; height: number };
    layoutMeasurement: { width: number; height: number };
  };
}

/**
 * Image Source
 */
export type ImageSource =
  | { uri: string; width?: number; height?: number; headers?: Record<string, string> }
  | number; // require('./image.png')

/**
 * Native Synthetic Event (base)
 */
export interface NativeSyntheticEvent<T> {
  nativeEvent: T;
  currentTarget: ReviewedUnknown;
  target: ReviewedUnknown;
  bubbles: boolean;
  cancelable: boolean;
  defaultPrevented: boolean;
  eventPhase: number;
  isTrusted: boolean;
  preventDefault(): void;
  stopPropagation(): void;
  persist(): void;
  timeStamp: number;
  type: string;
}

/**
 * Gesture Responder Event
 */
export interface GestureResponderEvent
  extends NativeSyntheticEvent<{
    changedTouches: ReviewedUnknown[];
    identifier: string;
    locationX: number;
    locationY: number;
    pageX: number;
    pageY: number;
    target: ReviewedUnknown;
    timestamp: number;
    touches: ReviewedUnknown[];
  }> {}

/**
 * Layout Change Event
 */
export interface LayoutChangeEvent
  extends NativeSyntheticEvent<{
    layout: {
      x: number;
      y: number;
      width: number;
      height: number;
    };
  }> {}

/**
 * Text Layout Event Line
 */
export interface TextLayoutLine {
  ascender: number;
  capHeight: number;
  descender: number;
  height: number;
  text: string;
  width: number;
  x: number;
  xHeight: number;
  y: number;
}

/**
 * Text Layout Event
 */
export interface TextLayoutEvent
  extends NativeSyntheticEvent<{
    lines: TextLayoutLine[];
  }> {}
