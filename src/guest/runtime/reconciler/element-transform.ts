/**
 * Guest Element Transformation
 *
 * Handles transformation of Guest React elements to Host-compatible format.
 * - Symbol registry differences between Guest (JSC) and Host (Hermes)
 * - JSI-safe component type transport via registration
 * - Function prop serialization for sandbox components
 */

// Use internal React shim - avoid external @types/react dependency
// biome-ignore lint/suspicious/noExplicitAny: Internal type alias for flexibility
type ReactElement = any;

import React from 'react';
import type { GuestElement } from '../../../sdk/types';
import { isGuestReactElement } from '../../../sdk/types';
import type { ReviewedUnknown, SerializedValue } from '../../../shared';
import { deserializeProps, serializeProps } from './guest-encoder';

// ============================================
// Type Definitions
// ============================================

/**
 * Sandbox wrapper component interface
 * Marks components that wrap Guest function components
 */
interface SandboxWrapper extends React.FC<Record<string, unknown>> {
  __rillSandboxWrapper: true;
  displayName?: string;
}

/**
 * Guest React element with runtime fields
 * Extends GuestReactElement to access internal markers and fields
 */
interface GuestElementRuntime {
  __rillTypeMarker?: string;
  __rillFragmentType?: string;
  $$typeof?: symbol;
  type?: ReviewedUnknown;
  props?: Record<string, unknown>;
  key?: React.Key | null;
  ref?: ReviewedUnknown;
}

/**
 * Component type reference from sandbox
 */
interface ComponentTypeRef {
  __rillComponentId: string;
  displayName?: string;
}

/**
 * Type guard for component type reference
 */
function isComponentTypeRef(value: unknown): value is ComponentTypeRef {
  return (
    typeof value === 'object' &&
    value !== null &&
    '__rillComponentId' in value &&
    typeof (value as ComponentTypeRef).__rillComponentId === 'string'
  );
}

// ============================================
// Constants
// ============================================

const RILL_ELEMENT_MARKER = '__rill_react_element__';
const RILL_FRAGMENT_MARKER = '__rill_react_fragment__';
const REACT_FRAGMENT_TYPE = Symbol.for('react.fragment');

// ============================================
// Component Type Registry
// ============================================
// JSI-safe function component transport
// In some sandboxes, functions inside returned object graphs lose callability.
// We register function component handles on the Host side and reference them by id.

// biome-ignore lint/complexity/noBannedTypes: WeakMap requires Function type for component tracking
const componentTypeIdByFn = new WeakMap<Function, string>();
// biome-ignore lint/complexity/noBannedTypes: Map stores component functions by ID
const componentTypeFnById = new Map<string, Function>();
const componentTypeOwnerById = new Map<string, string>();
let componentTypeCounter = 0;

// PERF: No console calls in render hot path!
// In XPC ViewBridge + JSC sandbox, ANY console call (log/warn/error) triggers
// JSI value conversion that traverses React fiber circular references.
// React DEV mode also patches console to inject component stacks (with fiber refs).
// Result: each console call costs 100-500ms due to millions of circular ref traversals.

export function registerComponentType(fn: unknown, ownerId = 'global'): string | null {
  if (typeof fn !== 'function') return null;
  const existing = componentTypeIdByFn.get(fn);
  if (existing) return existing;

  const id = `cmp_${ownerId}_${++componentTypeCounter}`;
  componentTypeIdByFn.set(fn, id);
  componentTypeFnById.set(id, fn);
  componentTypeOwnerById.set(id, ownerId);
  return id;
}

export function unregisterComponentTypes(ownerId: string): void {
  for (const [id, currentOwner] of componentTypeOwnerById) {
    if (currentOwner !== ownerId) continue;
    componentTypeOwnerById.delete(id);
    const fn = componentTypeFnById.get(id);
    componentTypeFnById.delete(id);
    if (fn) componentTypeIdByFn.delete(fn);
  }
}

// ============================================
// Component Wrapper Cache
// ============================================

// biome-ignore lint/suspicious/noExplicitAny: Component wrapper cache accepts any props type
const componentWrappers = new WeakMap<object, React.ComponentType<any>>();
let hookInstanceCounter = 0;
const hookInstancePrefix = Math.random().toString(36).slice(2, 7);

function getOrCreateWrappedComponent(
  // biome-ignore lint/complexity/noBannedTypes: Function type required for component wrapping
  originalType: Function,
  displayName?: string
  // biome-ignore lint/suspicious/noExplicitAny: Wrapped component accepts any props type
): React.ComponentType<any> {
  const key = originalType as unknown as object;
  if (componentWrappers.has(key)) {
    return componentWrappers.get(key)!;
  }

  const wrapped: SandboxWrapper = Object.assign(
    (props: Record<string, unknown>) => {
      const hookIdRef = React.useRef<string>('');
      if (!hookIdRef.current) {
        hookIdRef.current = `inst_${hookInstancePrefix}_${++hookInstanceCounter}`;
      }
      try {
        // Props arrive serialized (function markers from transformGuestElement's serializeProps).
        // Deserialize to restore callable proxies so Guest components can call prop functions.
        // Both sandbox wrapper and Guest component run in the same JSC runtime,
        // so the lightweight proxies invoke directly via globalCallbackRegistry.
        const rawProps =
          props && typeof props === 'object' ? (props as Record<string, unknown>) : {};
        const deserialized = deserializeProps(rawProps);
        // Always shallow-copy to avoid mutating the original (React may freeze props)
        const safeProps = deserialized === rawProps ? { ...rawProps } : deserialized;
        safeProps.__rillHookInstanceId = hookIdRef.current;

        // Set current instance ID for shims' hooks to use per-instance state
        // This enables multiple component instances to have separate hook state
        const globalState = globalThis as Record<string, unknown>;
        const prevInstanceId = globalState.__rillCurrentInstanceId;
        globalState.__rillCurrentInstanceId = hookIdRef.current;

        try {
          const result = originalType(safeProps);
          return transformGuestElement(result);
        } finally {
          // Restore previous instance ID (for nested component calls)
          globalState.__rillCurrentInstanceId = prevInstanceId;
        }
      } catch (err) {
        // Surface error as simple strings to avoid JSI circular ref traversal
        const msg = err instanceof Error ? err.message : String(err);
        const stack = err instanceof Error ? (err.stack ?? '') : '';
        console.error(`[rill:reconciler] render error in ${displayName ?? 'unknown'}: ${msg}`);
        if (stack) console.error(`[rill:reconciler] stack: ${stack}`);
        // Store on globalThis for Host-side inspection
        const g = globalThis as Record<string, unknown>;
        if (!g.__rillRenderErrors) g.__rillRenderErrors = [];
        (g.__rillRenderErrors as string[]).push(`${displayName ?? 'unknown'}: ${msg}`);
        return null;
      }
    },
    {
      // Mark: this is a sandbox wrapper (for transformGuestElement to decide children handling)
      __rillSandboxWrapper: true as const,
      displayName: displayName,
    }
  ) as SandboxWrapper;

  // Copy static properties from originalType
  try {
    Object.assign(wrapped, originalType);
  } catch {
    // ignore
  }

  componentWrappers.set(key, wrapped);
  return wrapped;
}

// ============================================
// Guest Element Transformation
// ============================================

/**
 * Transform Guest element to use Host's Symbol registry
 *
 * When Guest (JSC sandbox) creates React elements, it uses its own Symbol registry.
 * Host (Hermes) has a different Symbol registry, so Symbol.for('react.element')
 * returns different Symbols in each engine. Additionally, JSI doesn't preserve
 * Symbols across the engine boundary at all - they become undefined.
 *
 * We use string markers (__rillTypeMarker, __rillFragmentType) that survive
 * JSI serialization to identify React elements from the Guest.
 *
 * This function recursively transforms Guest elements to use Host Symbols.
 */
export function transformGuestElement(
  element: GuestElement,
  autoKey?: string
): ReactElement | null {
  if (element === null || element === undefined) {
    return null;
  }

  // Handle primitive values (text nodes)
  if (typeof element !== 'object') {
    return element as unknown as ReactElement;
  }

  // Handle arrays (children)
  if (Array.isArray(element)) {
    return element.map((child, idx) =>
      transformGuestElement(child, String(idx))
    ) as unknown as ReactElement;
  }

  // At this point, element must be a GuestReactElement
  if (!isGuestReactElement(element)) {
    // Unexpected type, return as-is
    return element as unknown as ReactElement;
  }

  const el = element as GuestElementRuntime;

  // Check if this is a Rill Guest element using the string marker
  // This marker survives JSI serialization while Symbols don't
  const isRillElement = el.__rillTypeMarker === RILL_ELEMENT_MARKER;

  // Also check for $$typeof Symbol (works when not crossing JSI, e.g., NoSandbox provider)
  const hasSymbolType = typeof el.$$typeof === 'symbol';

  // If already Host ReactElement (has $$typeof symbol but no Rill marker), return directly,
  // avoiding double transform/wrap, especially avoiding passing Host ReactElement back to sandbox.
  if (hasSymbolType && !isRillElement) {
    if (
      autoKey !== undefined &&
      (el.key === undefined || el.key === null) &&
      typeof React.cloneElement === 'function'
    ) {
      try {
        return React.cloneElement(element as ReactElement, { key: autoKey });
      } catch {
        // ignore
      }
    }
    return element as ReactElement;
  }

  // Heuristic: some elements lose both marker and $$typeof across JSI bridge.
  // If shape still looks like a React element (has type/props), treat it as one.
  const looksLikeElement =
    !isRillElement && !hasSymbolType && Object.hasOwn(el, 'type') && Object.hasOwn(el, 'props');

  // DEBUG: log element being processed
  const elType = typeof el.type === 'string' ? el.type : 'non-string';
  if (elType === 'TouchableOpacity') {
    const propKeys = el.props ? Object.keys(el.props as Record<string, unknown>) : [];
    const hasOnPress = el.props && 'onPress' in (el.props as Record<string, unknown>);
    console.log(
      `[rill:transform] TouchableOpacity | isRillElement=${isRillElement} | looksLikeElement=${looksLikeElement} | propKeys=${propKeys.join(',')} | hasOnPress=${hasOnPress}`
    );
  }

  // Note: looksLikeElement fires when elements lose markers across JSI bridge.
  // No console output here — see PERF comment at top of file.

  if (!isRillElement && !hasSymbolType && !looksLikeElement) {
    // Not a React element, return as-is
    return element as ReactElement;
  }

  // Determine if this is a Fragment
  const isFragment =
    el.__rillFragmentType === RILL_FRAGMENT_MARKER ||
    (typeof el.type === 'symbol' && (el.type as symbol).description === 'react.fragment');

  // Transform the element type
  let transformedType: ReviewedUnknown = el.type;
  if (isFragment) {
    transformedType = REACT_FRAGMENT_TYPE;
  } else if (isComponentTypeRef(transformedType)) {
    const ref = transformedType;
    const resolved = componentTypeFnById.get(ref.__rillComponentId);
    if (resolved) {
      transformedType = getOrCreateWrappedComponent(resolved, ref.displayName);
    } else {
      // If registry misses, fall back to Fragment to preserve children
      transformedType = REACT_FRAGMENT_TYPE;
    }
  } else if (typeof transformedType === 'function') {
    transformedType = getOrCreateWrappedComponent(transformedType);
  } else if (typeof transformedType === 'object' && transformedType !== null) {
    // Some guests may accidentally pass a React element (object) as type
    // Try to unwrap its `type` field; otherwise bail out to avoid invalid type errors
    const typeObj = transformedType as Record<string, unknown>;
    const nestedType = typeObj.type;
    const renderType = typeObj.render;
    const defaultType = typeObj.default;
    const displayName = typeObj.displayName;
    // No console output here — see PERF comment at top of file.
    const panelId =
      typeof displayName === 'string' && displayName.toLowerCase().includes('panel.')
        ? displayName.toLowerCase().includes('left')
          ? 'left'
          : displayName.toLowerCase().includes('right')
            ? 'right'
            : null
        : null;
    if (panelId) {
      // Heuristic fallback: rebuild Panel.{Left,Right} when markers lost across bridge
      const fallbackPanel: React.FC<{ children?: React.ReactNode }> = ({ children }) =>
        React.createElement('PanelMarker', { panelId, children });
      if (typeof displayName === 'string') {
        fallbackPanel.displayName = displayName;
      }
      transformedType = fallbackPanel;
    }

    const candidates = [nestedType, renderType, defaultType];
    const chosen = candidates.find(
      (candidate) => typeof candidate === 'string' || typeof candidate === 'function'
    );
    if (!chosen) {
      if (!panelId) {
        // Fall back to Fragment to preserve children even when type metadata is lost
        transformedType = REACT_FRAGMENT_TYPE;
      }
    } else {
      transformedType = typeof chosen === 'function' ? getOrCreateWrappedComponent(chosen) : chosen;
    }
  }

  // Transform children recursively
  const props = el.props;
  let transformedProps = props;
  const isSandboxWrapper =
    typeof transformedType === 'function' &&
    '__rillSandboxWrapper' in transformedType &&
    transformedType.__rillSandboxWrapper === true;
  const shouldPreserveChildrenForSandboxWrapper =
    props && props.children !== undefined && isSandboxWrapper;

  // Serialize props for Guest components (sandbox wrappers)
  // TypeRules automatically handle function → { __type: 'function', __fnId }
  // This early serialization ensures function markers survive the JSI boundary.
  // The sandbox wrapper then deserializes markers back to lightweight callable proxies
  // so Guest components can call prop functions directly (e.g., onSubmit(...)).
  if (props && isSandboxWrapper) {
    const { children, ...restProps } = props;
    const serialized = serializeProps(restProps);
    if (children !== undefined) {
      serialized.children = children as SerializedValue;
    }
    transformedProps = serialized;
  }

  if (props && props.children !== undefined && !shouldPreserveChildrenForSandboxWrapper) {
    const transformedChildren = Array.isArray(props.children)
      ? props.children.map((child, idx) =>
          transformGuestElement(child as GuestElement, String(idx))
        )
      : transformGuestElement(props.children as GuestElement);
    transformedProps = { ...transformedProps, children: transformedChildren };
  }

  const key =
    el.key !== undefined && el.key !== null
      ? (el.key as React.Key)
      : autoKey !== undefined
        ? (autoKey as React.Key)
        : null;

  // Use React.createElement to ensure correct Symbol and structure
  const config = {
    ...transformedProps,
    key,
    ref: el.ref,
  };

  // If transformedType is fragment symbol, use React.Fragment
  if (transformedType === REACT_FRAGMENT_TYPE) {
    // Fragment only accepts key + children. Strip other props to avoid React warnings
    const fragmentKey = key as React.Key | null | undefined;
    const fragmentChildren = transformedProps?.children as React.ReactNode;
    return React.createElement(React.Fragment, { key: fragmentKey }, fragmentChildren);
  }

  return React.createElement(transformedType as React.ElementType, config);
}
