import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHostModuleDispatch, defineRillContract, implementHostModules, rpc } from '../../../contract';
import { ComponentRegistry } from '../../registry';
import { Receiver } from '../../receiver';
import { WasmGuestHost } from '../wasm-guest-host';

// Real Rust guests built via the rill-guest canvas/asset/gpu SDK (crates/build.sh).
// These drive the SDK modules end-to-end over the native-guest ABI: rill knows
// nothing about host:canvas / host:gpu, so a test-local dispatch RECORDS what the
// guest emitted — exactly as storeDispatch does for host:store in wasm-guest-host.test.ts.
const fx = (n: string) => readFileSync(join(import.meta.dir, 'fixtures', n));
const CANVAS_GUEST = fx('canvas-guest.wasm'); // ① host:canvas.draw display list
const PRESENT_GUEST = fx('canvas-present-guest.wasm'); // ② framebuffer present
const GPU_GUEST = fx('canvas-gpu-guest.wasm'); // ③ host:gpu command buffer
const ESCAPE_GUEST = fx('canvas-escape-guest.wasm'); // guest->host JSON escaping

const field = (o: Record<string, unknown>, k: string): unknown => o[k];
const asNum = (v: unknown): number => Number(v) || 0;
const asStr = (v: unknown): string => String(v ?? '');
const ops = (v: unknown): Array<Record<string, unknown>> =>
  (Array.isArray(v) ? v : []) as Array<Record<string, unknown>>;
const opNames = (v: unknown): Set<string> => new Set(ops(v).map((o) => asStr((o as { op?: unknown })?.op)));

type Call = { method: string; input: Record<string, unknown> };

// host:canvas dispatch that records draw/present and resolves them so the guest
// proceeds. Pass-through parseInput (the test asserts the raw wire the guest sent).
// `failPresent` makes present() REJECT so the guest's await resolves ok=0 (the
// SDK's fail-closed path) while still recording the attempt.
function canvasDispatch(options: { failPresent?: boolean } = {}) {
  const calls: Call[] = [];
  const contract = defineRillContract({
    version: '1',
    hostModules: {
      'host:canvas': {
        draw: rpc<Record<string, unknown>, { ok: boolean; dropped: number }>({
          schema: {
            parseInput: (x) => (x ?? {}) as Record<string, unknown>,
            parseOutput: (x) => ({
              ok: !!(x as { ok?: unknown })?.ok,
              dropped: asNum((x as { dropped?: unknown })?.dropped),
            }),
          },
        }),
        present: rpc<Record<string, unknown>, { ok: boolean }>({
          schema: {
            parseInput: (x) => (x ?? {}) as Record<string, unknown>,
            parseOutput: (x) => ({ ok: !!(x as { ok?: unknown })?.ok }),
          },
        }),
      },
    },
    guestExports: {},
  });
  const impl = implementHostModules(contract, {
    'host:canvas': {
      draw: async (input: Record<string, unknown>) => {
        calls.push({ method: 'draw', input });
        return { ok: true, dropped: 0 };
      },
      present: async (input: Record<string, unknown>) => {
        calls.push({ method: 'present', input });
        if (options.failPresent) throw new Error('present rejected');
        return { ok: true };
      },
    },
  });
  return { table: createHostModuleDispatch(contract, impl), calls };
}

// host:gpu dispatch that records configure/createResource/submit.
function gpuDispatch() {
  const calls: Call[] = [];
  let nextHandle = 1;
  const contract = defineRillContract({
    version: '1',
    hostModules: {
      'host:gpu': {
        configure: rpc<Record<string, unknown>, { ok: boolean; mode: string }>({
          schema: {
            parseInput: (x) => (x ?? {}) as Record<string, unknown>,
            parseOutput: (x) => ({
              ok: !!(x as { ok?: unknown })?.ok,
              mode: asStr((x as { mode?: unknown })?.mode),
            }),
          },
        }),
        createResource: rpc<Record<string, unknown>, { ok: boolean; handle: number }>({
          schema: {
            parseInput: (x) => (x ?? {}) as Record<string, unknown>,
            parseOutput: (x) => ({
              ok: !!(x as { ok?: unknown })?.ok,
              handle: asNum((x as { handle?: unknown })?.handle),
            }),
          },
        }),
        submit: rpc<Record<string, unknown>, { ok: boolean; dropped: number }>({
          schema: {
            parseInput: (x) => (x ?? {}) as Record<string, unknown>,
            parseOutput: (x) => ({
              ok: !!(x as { ok?: unknown })?.ok,
              dropped: asNum((x as { dropped?: unknown })?.dropped),
            }),
          },
        }),
      },
    },
    guestExports: {},
  });
  const impl = implementHostModules(contract, {
    'host:gpu': {
      configure: async (input: Record<string, unknown>) => {
        calls.push({ method: 'configure', input });
        return { ok: true, mode: asStr(field(input, 'mode')) };
      },
      createResource: async (input: Record<string, unknown>) => {
        calls.push({ method: 'createResource', input });
        return { ok: true, handle: nextHandle++ };
      },
      submit: async (input: Record<string, unknown>) => {
        calls.push({ method: 'submit', input });
        return { ok: true, dropped: 0 };
      },
    },
  });
  return { table: createHostModuleDispatch(contract, impl), calls };
}

function makeReceiver() {
  const registry = new ComponentRegistry();
  for (const t of ['View', 'Text', 'Canvas']) {
    // biome-ignore lint/suspicious/noExplicitAny: registry stores an opaque materializer; irrelevant here.
    registry.register(t, t as any);
  }
  return new Receiver(
    registry,
    () => {},
    () => {}
  );
}

describe('canvas guests — ① host:canvas.draw display list', () => {
  it('canvas-guest emits a host:canvas.draw with the scene ops on init', async () => {
    const { table, calls } = canvasDispatch();
    const host = new WasmGuestHost({ dispatch: table });
    await host.load(CANVAS_GUEST);
    await host.drain();

    // draw is called exactly once, on init, with no event needed.
    const draws = calls.filter((c) => c.method === 'draw');
    expect(draws).toHaveLength(1);
    const draw = draws[0];
    expect(asStr(field(draw.input, 'canvasId'))).toBe('scene');

    const list = field(draw.input, 'ops');
    const names = opNames(list);
    // The house scene exercises many distinct 2D ctx ops; the op NAMES on the wire
    // match host-canvas.ts OP_SPECS exactly (camelCase ctx method names).
    for (const op of [
      'setFillStyle',
      'fillRect',
      'beginPath',
      'arc',
      'fill',
      'moveTo',
      'lineTo',
      'closePath',
      'setStrokeStyle',
      'setLineWidth',
      'strokeRect',
      'fillText',
    ]) {
      expect(names.has(op)).toBe(true);
    }
    expect(names.size).toBeGreaterThanOrEqual(10);

    // String args (CSS colors) survive as JSON strings — a color op carries a
    // non-empty '#rrggbb' string, not a number/undefined.
    const fillStyle = ops(list).find((o) => asStr(o.op) === 'setFillStyle');
    expect(typeof fillStyle?.color).toBe('string');
    expect(asStr(fillStyle?.color)).toMatch(/^#[0-9a-f]{6}$/);
    // Every color op (fill + stroke styles) carries a string color.
    for (const o of ops(list).filter((o) => /Style$/.test(asStr(o.op)))) {
      expect(typeof o.color).toBe('string');
      expect(asStr(o.color).length).toBeGreaterThan(0);
    }
    // The text label round-trips its string content.
    const text = ops(list).find((o) => asStr(o.op) === 'fillText');
    expect(asStr(text?.text)).toBe('rill');

    // arc carries its numeric geometry (radius > 0) — numbers survive too.
    const arc = ops(list).find((o) => asStr(o.op) === 'arc');
    expect(asNum(arc?.r)).toBeGreaterThan(0);
  });
});

describe('canvas guests — ② framebuffer present', () => {
  it('canvas-present-guest mounts a <Canvas> and presents its framebuffer on each frame', async () => {
    const receiver = makeReceiver();
    const { table, calls } = canvasDispatch();
    const host = new WasmGuestHost({ dispatch: table, onRenderBatch: (b) => receiver.applyBatch(b) });
    await host.load(PRESENT_GUEST);
    await host.drain();

    const tree = receiver.getComponentTree();
    expect(tree?.type).toBe('View');
    expect(tree?.children[0].type).toBe('Canvas');
    // No present until a frame ticks (present is driven by canvas.frame).
    expect(calls.some((c) => c.method === 'present')).toBe(false);

    host.emitEvent('canvas.frame', { canvasId: 'viewport', t: 0, dt: 0, frame: 1 });
    await host.drain();

    const present = calls.find((c) => c.method === 'present');
    expect(present).toBeDefined();
    const p = present?.input ?? {};
    expect(asStr(field(p, 'canvasId'))).toBe('viewport');
    expect(asNum(field(p, 'width'))).toBeGreaterThan(0);
    expect(asNum(field(p, 'height'))).toBeGreaterThan(0);
    expect(asStr(field(p, 'format'))).toBe('rgba8');
    // ptr is a real offset into the guest's own linear memory (non-negative).
    expect(asNum(field(p, 'ptr'))).toBeGreaterThanOrEqual(0);
    expect(calls.filter((c) => c.method === 'present')).toHaveLength(1);

    // A SECOND frame presents AGAIN: rt::wake re-drives the parked async loop.
    host.emitEvent('canvas.frame', { canvasId: 'viewport', t: 16, dt: 16, frame: 2 });
    await host.drain();
    expect(calls.filter((c) => c.method === 'present')).toHaveLength(2);
  });
});

describe('canvas guests — ③ host:gpu command buffer', () => {
  it('canvas-gpu-guest mounts a webgpu <Canvas> and configures + submits on a frame', async () => {
    const receiver = makeReceiver();
    const { table, calls } = gpuDispatch();
    const host = new WasmGuestHost({ dispatch: table, onRenderBatch: (b) => receiver.applyBatch(b) });
    await host.load(GPU_GUEST);
    await host.drain();

    // The <Canvas> mounts in webgpu mode — the mode prop reaches the host (this is
    // the ui::canvas_mode fix that made host:gpu.configure match the canvas family
    // instead of failing closed).
    const tree = receiver.getComponentTree();
    expect(tree?.children[0].type).toBe('Canvas');
    expect(asStr(field(tree?.children[0].props ?? {}, 'mode'))).toBe('webgpu');
    // No gpu traffic before a frame ticks.
    expect(calls).toHaveLength(0);

    host.emitEvent('canvas.frame', { canvasId: 'viewport', t: 0, dt: 0, frame: 1 });
    await host.drain();

    const methods = calls.map((c) => c.method);
    expect(methods).toContain('configure'); // bind the canvas to a gpu mode
    expect(methods).toContain('createResource'); // upload the vertex buffer
    expect(methods).toContain('submit'); // a validated command buffer

    // configure targets the webgpu backend the <Canvas> was mounted with.
    const configure = calls.find((c) => c.method === 'configure');
    expect(asStr(field(configure?.input ?? {}, 'mode'))).toBe('webgpu');

    const submit = calls.find((c) => c.method === 'submit');
    const names = opNames(field(submit?.input ?? {}, 'ops'));
    // The full validated draw pass crosses the seam...
    for (const op of ['BEGIN_PASS', 'SET_VIEWPORT', 'SET_PIPELINE', 'SET_VERTEX', 'DRAW', 'END_PASS', 'SUBMIT']) {
      expect(names.has(op)).toBe(true);
    }
    // ...and NO shader-compile or readback opcode EVER does (the seal): the guest
    // cannot author shaders or read pixels back off the GPU.
    for (const banned of ['COMPILE_SHADER', 'CREATE_SHADER', 'READ_PIXELS', 'READBACK', 'GET_BUFFER_SUB_DATA', 'MAP_READ']) {
      expect(names.has(banned)).toBe(false);
    }
  });
});

describe('canvas guests — SDK fail-closed (Result-based)', () => {
  it('present resolving ok=0 does NOT crash the guest; the next frame still drives cleanly', async () => {
    const receiver = makeReceiver();
    // present() REJECTS host-side -> the guest's await resolves ok=0 -> the SDK's
    // present() returns Err, which the guest ignores and loops for the next tick.
    const { table, calls } = canvasDispatch({ failPresent: true });
    const host = new WasmGuestHost({ dispatch: table, onRenderBatch: (b) => receiver.applyBatch(b) });
    await host.load(PRESENT_GUEST);
    await host.drain();

    // Frame 1: present is attempted and fails; drain must not throw.
    host.emitEvent('canvas.frame', { canvasId: 'viewport', t: 0, dt: 0, frame: 1 });
    await expect(host.drain()).resolves.toBeUndefined();
    expect(calls.filter((c) => c.method === 'present')).toHaveLength(1);

    // Frame 2: the guest survived the failure and rt::wake re-drives it — a second
    // present is attempted (fail-closed did not park the loop forever).
    host.emitEvent('canvas.frame', { canvasId: 'viewport', t: 16, dt: 16, frame: 2 });
    await expect(host.drain()).resolves.toBeUndefined();
    expect(calls.filter((c) => c.method === 'present')).toHaveLength(2);

    // The mounted <Canvas> tree is intact — the guest never corrupted its UI.
    expect(receiver.getComponentTree()?.children[0].type).toBe('Canvas');
  });

  it('an unregistered host:canvas (empty dispatch) resolves ok=0 without crashing the guest', async () => {
    // No host:canvas at all -> every present resolves ok=0 (the seal's default).
    const host = new WasmGuestHost({ dispatch: {} });
    await host.load(PRESENT_GUEST);
    await host.drain();
    host.emitEvent('canvas.frame', { canvasId: 'viewport', t: 0, dt: 0, frame: 1 });
    await expect(host.drain()).resolves.toBeUndefined();
    // A second tick still drives without a throw — no busy loop, no crash.
    host.emitEvent('canvas.frame', { canvasId: 'viewport', t: 16, dt: 16, frame: 2 });
    await expect(host.drain()).resolves.toBeUndefined();
  });
});

describe('canvas guests — guest->host JSON escaping', () => {
  it('a canvasId / color / text with JSON metachars + multi-byte UTF-8 round-trips exactly', async () => {
    const { table, calls } = canvasDispatch();
    const host = new WasmGuestHost({ dispatch: table });
    await host.load(ESCAPE_GUEST);
    await host.drain();

    // If the SDK mis-escaped a byte, the host's strict JSON.parse would fail closed
    // and NO draw would be recorded. A recorded draw whose strings match EXACTLY is
    // the proof the escaping round-trips through the wire.
    const draw = calls.find((c) => c.method === 'draw');
    expect(draw).toBeDefined();
    // canvasId carries a quote, backslash, newline and tab.
    expect(asStr(field(draw?.input ?? {}, 'canvasId'))).toBe('scene"\\\n\tid');

    const list = field(draw?.input ?? {}, 'ops');
    const fillStyle = ops(list).find((o) => asStr(o.op) === 'setFillStyle');
    // A color string containing a quote + backslash survives verbatim.
    expect(fillStyle?.color).toBe('#ff0000"\\');
    const text = ops(list).find((o) => asStr(o.op) === 'fillText');
    // Metacharacters mixed with 2-byte (é) and 4-byte (emoji) UTF-8 all round-trip.
    expect(text?.text).toBe('hé"llo\\\n\t😀');
  });
});
