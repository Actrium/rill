/**
 * rill/guest Type Definitions
 *
 * Types for Guest-side SDK and Reconciler
 * 通信相关类型从 bridge/types.ts 重新导出
 */

import type React from 'react';
import type { ReviewedUnknown } from '../shared';

// ============================================
// 从 Bridge 重新导出通信类型
// ============================================

export type {
  AppendOperation,
  BaseOperation,
  BridgeValueObject,
  CallbackRegistry,
  CreateOperation,
  DeleteOperation,
  InsertOperation,
  Operation,
  OperationBatch,
  // 操作类型
  OperationType,
  RemoveOperation,
  ReorderOperation,
  // 函数类型
  SendToHost,
  // 序列化操作类型 (Guest 端使用)
  SerializedCreateOperation,
  SerializedFunction,
  SerializedOperation,
  SerializedOperationBatch,
  SerializedProps,
  SerializedUpdateOperation,
  // 序列化类型
  SerializedValue,
  SerializedValueObject,
  TextOperation,
  UpdateOperation,
} from '../shared';
// Re-export type guards from Bridge
export { isSerializedFunction, operationHasProps } from '../shared';

// ============================================
// Guest Element Types (let 特有)
// ============================================

/**
 * Guest component reference (registered on Host)
 */
export interface GuestComponentRef {
  __rillComponentId: string;
  displayName?: string;
}

/**
 * Guest React element (from sandbox)
 */
export interface GuestReactElement {
  __rillTypeMarker?: string;
  __rillFragmentType?: string;
  $$typeof?: symbol;
  // biome-ignore lint/complexity/noBannedTypes: React element type can be Function for component references
  type: string | symbol | Function | GuestComponentRef | Record<string, unknown>;
  props?: Record<string, unknown>;
  key?: React.Key | null;
  ref?: ReviewedUnknown;
  children?: ReviewedUnknown;
}

/**
 * Valid Guest element types
 * More type-safe than `unknown` - explicitly defines what can come from sandbox
 */
export type GuestElement =
  | null
  | undefined
  | string
  | number
  | boolean
  | GuestReactElement
  | GuestElement[];

/**
 * Type guard for Guest React element
 */
// Reason: Type guard input is untrusted (sandbox boundary)
export function isGuestReactElement(value: unknown): value is GuestReactElement {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const el = value as Record<string, unknown>;

  // Check for Rill markers
  if (el.__rillTypeMarker === '__rill_react_element__') {
    return true;
  }

  // Check for React $$typeof symbol
  if (typeof el.$$typeof === 'symbol') {
    return true;
  }

  // Heuristic: has type and props
  if ('type' in el && 'props' in el) {
    return true;
  }

  return false;
}

/**
 * Type guard for Guest component reference
 */
// Reason: Type guard input is untrusted (sandbox boundary)
export function isGuestComponentRef(value: unknown): value is GuestComponentRef {
  return (
    typeof value === 'object' &&
    value !== null &&
    '__rillComponentId' in value &&
    typeof (value as GuestComponentRef).__rillComponentId === 'string'
  );
}

// ============================================
// Virtual Node (let 内部使用)
// ============================================

/**
 * Virtual node (internal representation)
 */
export interface VNode {
  id: number;
  type: string;
  props: Record<string, unknown>;
  children: VNode[];
  parent: VNode | null;
  /** Registered callback function IDs for cleanup */
  registeredFnIds?: Set<string>;
}

// ============================================
// Style Types (from shared style-types.ts)
// ============================================

export type {
  // Value types
  ColorValue,
  DimensionValue,
  // Flex types
  FlexAlign,
  FlexDirection,
  FlexJustify,
  FlexStyle,
  GestureResponderEvent,
  ImageSource,
  ImageStyle,
  LayoutChangeEvent,
  // Event types
  LayoutEvent,
  NativeSyntheticEvent,
  ScrollEvent,
  // Style types
  StyleObject,
  StyleProp,
  TextLayoutEvent,
  TextLayoutLine,
  TextStyle,
  ViewStyle,
} from '../shared/style-types';

// ============================================
// Remote Ref Types (跨沙箱组件引用)
// ============================================

/**
 * Remote Ref - Guest 端对 Host 组件实例的引用
 *
 * 由于沙箱隔离，Guest 无法直接访问 Host 原生组件实例。
 * RemoteRef 提供异步方法调用机制，通过消息传递调用 Host 端方法。
 *
 * @example
 * const [inputRef, remoteInput] = useRemoteRef<TextInputRef>();
 * <TextInput ref={inputRef} />
 * await remoteInput?.invoke('focus');
 */
export interface RemoteRef<T = unknown> {
  /** 节点 ID */
  readonly nodeId: number;

  /**
   * 调用 Host 端组件方法
   * @param method 方法名
   * @param args 方法参数
   * @returns Promise 包装的返回值
   */
  invoke<R = unknown>(method: string, ...args: unknown[]): Promise<R>;

  /**
   * 类型安全的方法调用代理
   * 使用 Proxy 实现，调用任意方法名都会转为 invoke() 调用
   */
  call: T extends Record<string, (...args: unknown[]) => unknown>
    ? { [K in keyof T]: (...args: Parameters<T[K]>) => Promise<Awaited<ReturnType<T[K]>>> }
    : Record<string, (...args: unknown[]) => Promise<unknown>>;
}

/**
 * Measure 结果
 */
export interface MeasureResult {
  x: number;
  y: number;
  width: number;
  height: number;
  pageX: number;
  pageY: number;
}

/**
 * 可测量布局的组件方法
 */
export interface MeasurableRef {
  measure(): Promise<MeasureResult>;
  measureInWindow(): Promise<{
    x: number;
    y: number;
    width: number;
    height: number;
  }>;
}

/**
 * TextInput 组件方法
 */
export interface TextInputRef extends MeasurableRef {
  focus(): Promise<void>;
  blur(): Promise<void>;
  clear(): Promise<void>;
  isFocused(): Promise<boolean>;
  setNativeProps(props: Record<string, unknown>): Promise<void>;
}

/**
 * ScrollView 组件方法
 */
export interface ScrollViewRef extends MeasurableRef {
  scrollTo(options: { x?: number; y?: number; animated?: boolean }): Promise<void>;
  scrollToEnd(options?: { animated?: boolean }): Promise<void>;
  flashScrollIndicators(): Promise<void>;
}

/**
 * FlatList 组件方法
 */
export interface FlatListRef extends ScrollViewRef {
  scrollToIndex(params: {
    index: number;
    animated?: boolean;
    viewOffset?: number;
    viewPosition?: number;
  }): Promise<void>;
  scrollToItem(params: {
    item: ReviewedUnknown;
    animated?: boolean;
    viewPosition?: number;
  }): Promise<void>;
  scrollToOffset(params: { offset: number; animated?: boolean }): Promise<void>;
  recordInteraction(): Promise<void>;
}

/**
 * Remote Ref 回调类型
 * 用于 useRemoteRef 返回的 ref callback
 */
export type RemoteRefCallback = (instance: { nodeId: number } | null) => void;
