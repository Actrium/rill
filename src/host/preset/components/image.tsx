/**
 * Image Component
 *
 * Default Image component implementation, wrapping React Native Image
 * Uses forwardRef to allow parent components to get native view reference
 */

import React from 'react';
import { type ImageSourcePropType, type ImageStyle, Image as RNImage } from 'react-native';

export interface ImageSource {
  uri: string;
  width?: number;
  height?: number;
  headers?: Record<string, string>;
}

export interface ImageProps {
  source: ImageSource | ImageSourcePropType;
  style?: ImageStyle;
  resizeMode?: 'cover' | 'contain' | 'stretch' | 'repeat' | 'center';
  testID?: string;
  accessible?: boolean;
  accessibilityLabel?: string;
  fadeDuration?: number;
  blurRadius?: number;
  onLoad?: () => void;
  onLoadStart?: () => void;
  onLoadEnd?: () => void;
  onError?: (error: { nativeEvent: { error: string } }) => void;
}

export const Image = React.forwardRef<React.ComponentRef<typeof RNImage>, ImageProps>(
  (
    {
      source,
      style,
      resizeMode = 'cover',
      testID,
      accessible,
      accessibilityLabel,
      fadeDuration,
      blurRadius,
      onLoad,
      onLoadStart,
      onLoadEnd,
      onError,
    },
    ref
  ) => {
    // Handle source format
    const imageSource: ImageSourcePropType =
      typeof source === 'object' && 'uri' in source
        ? { uri: source.uri, headers: source.headers }
        : source;

    // Sanitize error event to only pass serializable data
    const handleError = onError
      ? (event: { nativeEvent: { error: string } }) => {
          onError({
            nativeEvent: {
              error: event.nativeEvent.error,
            },
          });
        }
      : undefined;

    return (
      <RNImage
        ref={ref}
        source={imageSource}
        style={style}
        resizeMode={resizeMode}
        testID={testID}
        accessible={accessible}
        accessibilityLabel={accessibilityLabel}
        fadeDuration={fadeDuration}
        blurRadius={blurRadius}
        onLoad={onLoad ? () => onLoad() : undefined}
        onLoadStart={onLoadStart ? () => onLoadStart() : undefined}
        onLoadEnd={onLoadEnd ? () => onLoadEnd() : undefined}
        onError={handleError}
      />
    );
  }
);

Image.displayName = 'Image';

export default Image;
