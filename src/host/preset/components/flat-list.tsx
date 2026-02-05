/**
 * FlatList Component
 *
 * Default FlatList component implementation, wrapping React Native FlatList
 * Uses forwardRef to allow parent components to get native view reference
 */

import React from 'react';
import { type ListRenderItem, FlatList as RNFlatList, type ViewStyle } from 'react-native';

export interface FlatListProps<T = unknown> {
  data: T[];
  renderItem: ListRenderItem<T>;
  keyExtractor?: (item: T, index: number) => string;
  style?: ViewStyle;
  contentContainerStyle?: ViewStyle;
  horizontal?: boolean;
  numColumns?: number;
  initialNumToRender?: number;
  maxToRenderPerBatch?: number;
  windowSize?: number;
  removeClippedSubviews?: boolean;
  showsVerticalScrollIndicator?: boolean;
  showsHorizontalScrollIndicator?: boolean;
  onEndReached?: () => void;
  onEndReachedThreshold?: number;
  onRefresh?: () => void;
  refreshing?: boolean;
  ListHeaderComponent?: React.ReactElement | null;
  ListFooterComponent?: React.ReactElement | null;
  ListEmptyComponent?: React.ReactElement | null;
  ItemSeparatorComponent?: React.ReactElement | null;
  testID?: string;
  accessible?: boolean;
  accessibilityLabel?: string;
}

// FlatList with forwardRef - generic component requires inner function
function FlatListInner<T = unknown>(
  {
    data,
    renderItem,
    keyExtractor,
    style,
    contentContainerStyle,
    horizontal,
    numColumns,
    initialNumToRender,
    maxToRenderPerBatch,
    windowSize,
    removeClippedSubviews,
    showsVerticalScrollIndicator,
    showsHorizontalScrollIndicator,
    onEndReached,
    onEndReachedThreshold,
    onRefresh,
    refreshing,
    ListHeaderComponent,
    ListFooterComponent,
    ListEmptyComponent,
    ItemSeparatorComponent,
    testID,
    accessible,
    accessibilityLabel,
  }: FlatListProps<T>,
  // biome-ignore lint/suspicious/noExplicitAny: forwardRef requires any for generic components
  ref: React.ForwardedRef<any>
): React.ReactElement {
  // Wrap callbacks to not pass event info to Guest
  // RN's onEndReached passes { distanceFromEnd }, onRefresh passes no args
  return (
    <RNFlatList
      ref={ref}
      data={data}
      renderItem={renderItem}
      keyExtractor={keyExtractor}
      style={style}
      contentContainerStyle={contentContainerStyle}
      horizontal={horizontal}
      numColumns={numColumns}
      initialNumToRender={initialNumToRender}
      maxToRenderPerBatch={maxToRenderPerBatch}
      windowSize={windowSize}
      removeClippedSubviews={removeClippedSubviews}
      showsVerticalScrollIndicator={showsVerticalScrollIndicator}
      showsHorizontalScrollIndicator={showsHorizontalScrollIndicator}
      onEndReached={onEndReached ? () => onEndReached() : undefined}
      onEndReachedThreshold={onEndReachedThreshold}
      onRefresh={onRefresh ? () => onRefresh() : undefined}
      refreshing={refreshing}
      ListHeaderComponent={ListHeaderComponent}
      ListFooterComponent={ListFooterComponent}
      ListEmptyComponent={ListEmptyComponent}
      ItemSeparatorComponent={
        ItemSeparatorComponent as React.ComponentType<unknown> | null | undefined
      }
      testID={testID}
      accessible={accessible}
      accessibilityLabel={accessibilityLabel}
    />
  );
}

// Use type assertion to maintain generic signature while supporting forwardRef
export const FlatList = React.forwardRef(FlatListInner) as <T = unknown>(
  // biome-ignore lint/suspicious/noExplicitAny: forwardRef requires any for generic components
  props: FlatListProps<T> & { ref?: React.ForwardedRef<any> }
) => React.ReactElement;

(FlatList as { displayName?: string }).displayName = 'FlatList';

export default FlatList;
