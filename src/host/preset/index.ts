/**
 * @rill/host/preset
 *
 * Default components and EngineView for Host-side rendering
 *
 * Works for both React Native and Web (via react-native-web).
 * For web builds, configure bundler alias: 'react-native' → 'react-native-web'
 */

export type {
  ActivityIndicatorProps,
  ButtonProps,
  ClickableViewProps,
  FlatListProps,
  ImageProps,
  ImageSource,
  ScrollEvent,
  ScrollViewProps,
  SwitchProps,
  TextInputProps,
  TextProps,
  TouchableOpacityProps,
  ViewProps,
} from './components';
// Re-export individual components and their prop types
export {
  ActivityIndicator,
  Button,
  ClickableView,
  DefaultComponents,
  FlatList,
  Image,
  ScrollView,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from './components';
// EngineView component
export type { EngineViewProps } from './engine-view';
export { EngineView } from './engine-view';
