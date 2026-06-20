/**
 * rill/contract
 *
 * Single source of truth for Host capabilities and Guest exports.
 */

export type HostModuleId = `host:${string}`;

export type BoundaryDirection = 'guest->host' | 'host->guest';

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
