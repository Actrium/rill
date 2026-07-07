/**
 * rill/wire — zero-DOM binary wire decoders (public export surface, R1.3).
 *
 * This is the importable home for the guest→host binary wire decoders. Both
 * decoders here are STRICTLY ZERO-DOM: they reference no `document`,
 * `HTMLCanvasElement`, `CanvasRenderingContext2D`, `window`, or any other
 * browser/DOM type. They turn raw bytes into plain, JSON-shaped data (an op
 * array / a stream of operations); the host replays that data onto its own
 * surfaces. This lets the platform bundle the decoders anywhere — a worker,
 * node, an edge runtime — without special handling.
 *
 * Two sister wires, deliberately distinct (different magic, so a buffer meant
 * for one decoder fails the other's u32 magic compare immediately):
 *   - op-batch  (magic 'RILL') — UI-tree diffs over a retained node graph.
 *   - canvas    (magic 'RCNV') — a flat, per-frame 2D display list.
 *
 * Platform consumers import from here, e.g.:
 *   import { decodeCanvasBatch } from 'rill/wire';
 *
 * WIP / EXPERIMENTAL: neither decoder is on a live receive path yet; they ship
 * off, locked to the contracts + golden vectors under contracts/.
 */

// --- op-batch wire (contracts/op-batch-wire.json) ---
export {
  decodeBatchStreaming,
  WireDecodeError,
  type WireBatchHeader,
  type ApplyOp,
} from './wire-decoder';

// --- canvas wire (contracts/canvas-wire.json) ---
export {
  decodeCanvasBatch,
  decodeCanvasBatchStreaming,
  decodeCanvasFrame,
  peekCanvasHeader,
  CanvasDecodeError,
  type CanvasOp,
  type CanvasBatchHeader,
  type CanvasDecodeReason,
  type CanvasWireInput,
} from './canvas-wire-decoder';
