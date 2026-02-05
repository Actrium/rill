/**
 * Default component exports
 */

export type { ActivityIndicatorProps } from './activity-indicator';
export { ActivityIndicator } from './activity-indicator';
export type { ButtonProps } from './button';
export { Button } from './button';
export type { ClickableViewProps } from './clickable-view';
export { ClickableView } from './clickable-view';
export type { FlatListProps } from './flat-list';
export { FlatList } from './flat-list';
export type { ImageProps, ImageSource } from './image';
export { Image } from './image';
export type { ScrollEvent, ScrollViewProps } from './scroll-view';
export { ScrollView } from './scroll-view';
export type { SwitchProps } from './switch';
export { Switch } from './switch';
export type { TextProps } from './text';
export { Text } from './text';
export type { TextInputProps } from './text-input';
export { TextInput } from './text-input';
export type { TouchableOpacityProps } from './touchable-opacity';
export { TouchableOpacity } from './touchable-opacity';
export type { ViewProps } from './view';
export { View } from './view';

import { ActivityIndicator } from './activity-indicator';
import { Button } from './button';
import { FlatList } from './flat-list';
import { Image } from './image';
import { ScrollView } from './scroll-view';
import { Switch } from './switch';
import { Text } from './text';
import { TextInput } from './text-input';
import { TouchableOpacity } from './touchable-opacity';
/**
 * Default component mapping
 * For registering with Engine
 */
import { View } from './view';

export const DefaultComponents = {
  View,
  Text,
  Image,
  TouchableOpacity,
  ScrollView,
  TextInput,
  FlatList,
  Button,
  Switch,
  ActivityIndicator,
} as const;

export type DefaultComponentName = keyof typeof DefaultComponents;
