/**
 * @rill/shared/bridge - Communication Layer
 *
 * Host/Guest
 */

// P3-X.5: Binary Protocol Support
export {
  BinaryProtocol,
  type BinaryProtocolConfig,
  createBinaryProtocol,
  detectPayloadEncoding,
  type PayloadEncoding,
  type ProtocolStats,
} from './binary-protocol';
export { Bridge, type BridgeOptions, type EncodeBatchResult } from './bridge';
export {
  PromiseManager,
  type PromiseManagerOptions,
  type PromiseSettleResult,
} from './promise-manager';
