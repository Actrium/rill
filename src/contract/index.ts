/**
 * rill/contract
 *
 * Single source of truth for Host capabilities and Guest exports.
 */

export type HostModuleId = `host:${string}`;

export interface BoundarySchema<Input, Output> {
  // Reason: Boundary schemas parse untrusted cross-runtime input.
  parseInput?: (value: unknown) => Input;
  // Reason: Boundary schemas parse untrusted cross-runtime output.
  parseOutput?: (value: unknown) => Output;
}

export interface RpcOptions<Input, Output> {
  timeoutMs?: number;
  schema?: BoundarySchema<Input, Output>;
}

export interface RpcDescriptor<Input = void, Output = void> {
  readonly kind: 'rpc';
  readonly timeoutMs?: number;
  readonly schema?: BoundarySchema<Input, Output>;
  readonly __input?: Input;
  readonly __output?: Output;
}

export interface SubscriptionOptions<Event> {
  schema?: {
    // Reason: Subscription schemas parse untrusted cross-runtime events.
    parseEvent?: (value: unknown) => Event;
  };
}

export interface SubscriptionDescriptor<Event = unknown> {
  readonly kind: 'subscription';
  readonly schema?: {
    // Reason: Subscription schemas parse untrusted cross-runtime events.
    parseEvent?: (value: unknown) => Event;
  };
  readonly __event?: Event;
}

export type HostCapabilityDescriptor = RpcDescriptor<unknown, unknown> | SubscriptionDescriptor;

export type HostModuleSpec = Record<string, HostCapabilityDescriptor>;

export interface RillContractShape {
  version: string;
  hostModules: Record<HostModuleId, HostModuleSpec>;
  guestExports: Record<string, RpcDescriptor<unknown, unknown>>;
}

export type RpcInput<T> = T extends RpcDescriptor<infer Input, unknown> ? Input : never;

export type RpcOutput<T> = T extends RpcDescriptor<unknown, infer Output> ? Output : never;

export type SubscriptionEvent<T> = T extends SubscriptionDescriptor<infer Event> ? Event : never;

// biome-ignore lint/suspicious/noConfusingVoidType: rpc<void, T> is the public no-input contract spelling.
type RpcArgs<Input> = [Input] extends [void] ? [] : [input: Input];

export type RpcImplementation<Input, Output> = (
  ...args: RpcArgs<Input>
) => Output | Promise<Output>;

export type SubscriptionImplementation<Event> = (
  handler: (event: Event) => void
) => undefined | (() => void);

export type HostModuleImplementation<TModule extends HostModuleSpec> = {
  [Key in keyof TModule]: TModule[Key] extends RpcDescriptor<infer Input, infer Output>
    ? RpcImplementation<Input, Output>
    : TModule[Key] extends SubscriptionDescriptor<infer Event>
      ? SubscriptionImplementation<Event>
      : never;
};

export type HostModulesImplementation<TContract extends RillContractShape> = {
  [ModuleId in keyof TContract['hostModules']]: TContract['hostModules'][ModuleId] extends HostModuleSpec
    ? HostModuleImplementation<TContract['hostModules'][ModuleId]>
    : never;
};

/**
 * Structural (non-generic) shape of a host module implementation map.
 *
 * Used by the runtime backend (Engine) where the concrete contract type is not
 * statically available. `(...args: never[]) => unknown` is the top function type
 * under contravariance, so any concrete `HostModulesImplementation<TContract>` is
 * assignable to it.
 */
export type HostModuleImplementationMap = Record<
  string,
  Record<string, (...args: never[]) => unknown>
>;

export type GuestExportsClient<TContract extends RillContractShape> = {
  [ExportName in keyof TContract['guestExports']]: TContract['guestExports'][ExportName] extends RpcDescriptor<
    infer Input,
    infer Output
  >
    ? (...args: RpcArgs<Input>) => Promise<Output>
    : never;
};

export interface RillCapabilitiesManifest {
  contractVersion: string;
  hostCapabilities: string[];
  guestExports: string[];
}

/**
 * A single dispatch-wrapped host capability, ready to be exposed to the Guest.
 *
 * Wrapping enforces the contract's boundary schemas: rpc capabilities run
 * `parseInput` before the implementation and `parseOutput` on its result;
 * subscription capabilities run `parseEvent` on every event before it reaches
 * the Guest handler. Validation failures throw (fail-closed).
 */
// Reason: dispatch handlers cross the runtime boundary with arbitrary argument shapes.
export type HostModuleDispatchHandler = (...args: unknown[]) => unknown;

/** Dispatch-wrapped capabilities of a single host module, keyed by export name. */
export type HostModuleDispatchModule = Record<string, HostModuleDispatchHandler>;

/** Dispatch-wrapped host modules, keyed by host module id (e.g. `host:analytics`). */
export type HostModuleDispatchTable = Record<string, HostModuleDispatchModule>;

/** Boundary phase at which a dispatch wrapper rejected a value. */
export type HostModuleBoundaryPhase = 'input' | 'output' | 'event';

export interface HostModuleDispatchContext {
  moduleId: string;
  exportName: string;
  phase: HostModuleBoundaryPhase;
}

export interface HostModuleDispatchOptions {
  /**
   * Invoked when a boundary schema rejects a value. The dispatch wrapper still
   * throws after this hook runs; the hook is for host-side diagnostics/logging.
   */
  onError?: (error: Error, context: HostModuleDispatchContext) => void;
}

const HOST_MODULE_ID_PATTERN = /^host:[a-z0-9_-]+(?:\/[a-z0-9_-]+)*$/;
const GUEST_EXPORT_NAME_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

export function rpc<Input = void, Output = void>(
  options: RpcOptions<Input, Output> = {}
): RpcDescriptor<Input, Output> {
  return freezeDescriptor({
    kind: 'rpc',
    timeoutMs: options.timeoutMs,
    schema: options.schema,
  });
}

export function subscription<Event = unknown>(
  options: SubscriptionOptions<Event> = {}
): SubscriptionDescriptor<Event> {
  return freezeDescriptor({
    kind: 'subscription',
    schema: options.schema,
  });
}

export function isHostModuleId(value: string): value is HostModuleId {
  return HOST_MODULE_ID_PATTERN.test(value);
}

export function assertHostModuleId(value: string): asserts value is HostModuleId {
  if (!isHostModuleId(value)) {
    throw new Error(
      `[rill/contract] Invalid host module id "${value}". Expected format: host:<domain>[/subdomain].`
    );
  }
}

export function defineRillContract<const TContract extends RillContractShape>(
  contract: TContract
): Readonly<TContract> {
  validateContract(contract);
  return deepFreeze(contract);
}

export function implementHostModules<const TContract extends RillContractShape>(
  contract: TContract,
  implementation: HostModulesImplementation<TContract>
): HostModulesImplementation<TContract> {
  validateHostModulesImplementation(contract, implementation);
  return implementation;
}

/**
 * Build the dispatch table that the runtime backend exposes to the Guest.
 *
 * This is the runtime counterpart of {@link implementHostModules}: it pairs each
 * contract descriptor with its implementation and returns boundary-enforcing
 * wrappers. The Engine injects the result into the sandbox as
 * `globalThis.__rill.hostModules`, where the Guest's rewritten `host:*` imports
 * resolve it.
 *
 * Enforcement (fail-closed):
 * - rpc: `schema.parseInput(args)` runs before the implementation; `schema.parseOutput(result)`
 *   runs on the resolved value (awaited for async implementations). Either failing throws.
 * - subscription: `schema.parseEvent(event)` runs on every event before it reaches the Guest
 *   handler; a rejected event throws and never reaches the Guest.
 * - The implementation's own errors propagate unchanged.
 *
 * The implementation must exactly match the contract (validated here), so a guest
 * capability that is declared but not implemented is impossible; an undeclared
 * `host:*` import is rejected at build time and, defensively, by the runtime resolver.
 */
export function createHostModuleDispatch(
  contract: RillContractShape,
  implementation: HostModuleImplementationMap,
  options: HostModuleDispatchOptions = {}
): HostModuleDispatchTable {
  assertImplementationMatchesContract(contract, implementation);

  const implementationRecord = implementation as Record<
    string,
    Record<string, HostModuleDispatchHandler>
  >;
  const table: HostModuleDispatchTable = {};

  for (const [moduleId, moduleSpec] of Object.entries(contract.hostModules)) {
    const moduleImpl = implementationRecord[moduleId];
    if (!moduleImpl) continue;

    const moduleDispatch: HostModuleDispatchModule = {};

    for (const [exportName, descriptor] of Object.entries(moduleSpec)) {
      const impl = moduleImpl[exportName];
      if (typeof impl !== 'function') continue;

      moduleDispatch[exportName] =
        descriptor.kind === 'subscription'
          ? wrapSubscriptionDispatch(moduleId, exportName, descriptor, impl, options)
          : wrapRpcDispatch(moduleId, exportName, descriptor, impl, options);
    }

    table[moduleId] = moduleDispatch;
  }

  return table;
}

export function createCapabilitiesManifest(contract: RillContractShape): RillCapabilitiesManifest {
  validateContract(contract);

  const hostCapabilities = Object.entries(contract.hostModules)
    .flatMap(([moduleId, moduleSpec]) =>
      Object.keys(moduleSpec).map((exportName) => `${moduleId}.${exportName}`)
    )
    .sort();

  const guestExports = Object.keys(contract.guestExports).sort();

  return {
    contractVersion: contract.version,
    hostCapabilities,
    guestExports,
  };
}

export function validateContract(contract: RillContractShape): void {
  if (!contract || typeof contract !== 'object') {
    throw new Error('[rill/contract] Contract must be an object.');
  }

  if (!contract.version || typeof contract.version !== 'string') {
    throw new Error('[rill/contract] Contract version must be a non-empty string.');
  }

  validateHostModules(contract.hostModules);
  validateGuestExports(contract.guestExports);
}

function validateHostModules(hostModules: RillContractShape['hostModules']): void {
  if (!hostModules || typeof hostModules !== 'object') {
    throw new Error('[rill/contract] hostModules must be an object.');
  }

  for (const [moduleId, moduleSpec] of Object.entries(hostModules)) {
    assertHostModuleId(moduleId);

    if (!moduleSpec || typeof moduleSpec !== 'object') {
      throw new Error(`[rill/contract] Host module "${moduleId}" must be an object.`);
    }

    for (const [exportName, descriptor] of Object.entries(moduleSpec)) {
      validateExportName(exportName, `host module "${moduleId}"`);
      validateDescriptor(descriptor, `${moduleId}.${exportName}`);
    }
  }
}

function validateGuestExports(guestExports: RillContractShape['guestExports']): void {
  if (!guestExports || typeof guestExports !== 'object') {
    throw new Error('[rill/contract] guestExports must be an object.');
  }

  for (const [exportName, descriptor] of Object.entries(guestExports)) {
    validateExportName(exportName, 'guest exports');

    if (descriptor.kind !== 'rpc') {
      throw new Error(`[rill/contract] Guest export "${exportName}" must be rpc().`);
    }

    validateDescriptor(descriptor, `guest.${exportName}`);
  }
}

function validateHostModulesImplementation<const TContract extends RillContractShape>(
  contract: TContract,
  implementation: HostModulesImplementation<TContract>
): void {
  assertImplementationMatchesContract(contract, implementation as HostModuleImplementationMap);
}

/**
 * Assert that an implementation map exactly covers a contract's host modules:
 * every declared module/export has a function implementation, and no extra
 * (undeclared) modules or exports are present.
 */
function assertImplementationMatchesContract(
  contract: RillContractShape,
  implementation: HostModuleImplementationMap
): void {
  validateContract(contract);

  const implementationRecord = implementation as Record<string, Record<string, unknown>>;

  for (const moduleId of Object.keys(implementationRecord)) {
    if (!(moduleId in contract.hostModules)) {
      throw new Error(`[rill/contract] Host module implementation "${moduleId}" is not declared.`);
    }
  }

  for (const [moduleId, moduleSpec] of Object.entries(contract.hostModules)) {
    const moduleImpl = implementationRecord[moduleId];

    if (!moduleImpl || typeof moduleImpl !== 'object') {
      throw new Error(`[rill/contract] Missing implementation for host module "${moduleId}".`);
    }

    for (const exportName of Object.keys(moduleImpl)) {
      if (!(exportName in moduleSpec)) {
        throw new Error(
          `[rill/contract] Host module implementation "${moduleId}.${exportName}" is not declared.`
        );
      }
    }

    for (const exportName of Object.keys(moduleSpec)) {
      const impl = moduleImpl[exportName];

      if (typeof impl !== 'function') {
        throw new Error(
          `[rill/contract] Missing function implementation for "${moduleId}.${exportName}".`
        );
      }
    }
  }
}

function validateDescriptor(
  // Reason: Descriptor validation accepts arbitrary runtime values before narrowing.
  value: unknown,
  label: string
): asserts value is HostCapabilityDescriptor {
  if (!value || typeof value !== 'object') {
    throw new Error(
      `[rill/contract] Descriptor "${label}" must be created with rpc() or subscription().`
    );
  }

  // Reason: Descriptor kind is read from an arbitrary runtime value after object narrowing.
  const kind = (value as { kind?: unknown }).kind;

  if (kind !== 'rpc' && kind !== 'subscription') {
    throw new Error(`[rill/contract] Descriptor "${label}" must be rpc() or subscription().`);
  }
}

function validateExportName(value: string, owner: string): void {
  if (!GUEST_EXPORT_NAME_PATTERN.test(value)) {
    throw new Error(`[rill/contract] Invalid export name "${value}" in ${owner}.`);
  }
}

function wrapRpcDispatch(
  moduleId: string,
  exportName: string,
  descriptor: RpcDescriptor<unknown, unknown>,
  impl: HostModuleDispatchHandler,
  options: HostModuleDispatchOptions
): HostModuleDispatchHandler {
  const schema = descriptor.schema;

  return (...args: unknown[]): unknown => {
    // Boundary: parse the untrusted input the Guest sent before it reaches the host impl.
    let callArgs = args;
    if (schema?.parseInput) {
      const parsed = runBoundary(
        schema.parseInput,
        args[0],
        moduleId,
        exportName,
        'input',
        options
      );
      callArgs = [parsed];
    }

    const result = impl(...(callArgs as never[]));

    if (!schema?.parseOutput) {
      return result;
    }

    const parseOutput = schema.parseOutput;
    if (isThenable(result)) {
      // Boundary: parse the host impl's resolved output before it crosses back to the Guest.
      return Promise.resolve(result).then((resolved) =>
        runBoundary(parseOutput, resolved, moduleId, exportName, 'output', options)
      );
    }

    return runBoundary(parseOutput, result, moduleId, exportName, 'output', options);
  };
}

function wrapSubscriptionDispatch(
  moduleId: string,
  exportName: string,
  descriptor: SubscriptionDescriptor,
  impl: HostModuleDispatchHandler,
  options: HostModuleDispatchOptions
): HostModuleDispatchHandler {
  const schema = descriptor.schema;

  return (...args: unknown[]): unknown => {
    const handler = args[0];
    if (typeof handler !== 'function') {
      throw new Error(
        `[rill/contract] Subscription "${moduleId}.${exportName}" requires a handler function.`
      );
    }

    // Reason: the Guest handler and its events cross the runtime boundary as untrusted values.
    const guestHandler = handler as (event: unknown) => void;
    const wrappedHandler = schema?.parseEvent
      ? (event: unknown): void => {
          // Boundary: parse every event before it reaches the Guest handler.
          const parsed = runBoundary(
            schema.parseEvent!,
            event,
            moduleId,
            exportName,
            'event',
            options
          );
          guestHandler(parsed);
        }
      : guestHandler;

    return impl(wrappedHandler as never);
  };
}

// Reason: boundary parsers receive arbitrary cross-runtime input and return a narrowed value.
function runBoundary(
  parse: (value: unknown) => unknown,
  value: unknown,
  moduleId: string,
  exportName: string,
  phase: HostModuleBoundaryPhase,
  // Reason: returns the parsed (narrowed) value, or throws when the boundary rejects it.
  options: HostModuleDispatchOptions
): unknown {
  try {
    return parse(value);
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    const error = new Error(
      `[rill/contract] Boundary ${phase} validation failed for "${moduleId}.${exportName}": ${reason}`
    );
    // Reason: preserve the original validation error for host-side diagnostics.
    (error as { cause?: unknown }).cause = cause;
    options.onError?.(error, { moduleId, exportName, phase });
    throw error;
  }
}

// Reason: type guard narrows an arbitrary runtime value to a thenable.
function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    value != null &&
    (typeof value === 'object' || typeof value === 'function') &&
    // Reason: probe the value's then property without assuming its shape.
    typeof (value as { then?: unknown }).then === 'function'
  );
}

function freezeDescriptor<T extends object>(descriptor: T): Readonly<T> {
  return Object.freeze(descriptor);
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) {
    return value as Readonly<T>;
  }

  for (const key of Object.keys(value as Record<string, unknown>)) {
    const child = (value as Record<string, unknown>)[key];
    if (child && typeof child === 'object') {
      deepFreeze(child);
    }
  }

  return Object.freeze(value);
}
