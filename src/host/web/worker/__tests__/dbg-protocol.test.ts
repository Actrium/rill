/**
 * dbg.* protocol structured-clone tests (Milestone B web side).
 *
 * Every dbg.* message crosses the worker boundary via postMessage, so it must be
 * structured-clone-safe. These round-trip each variant and confirm the payload
 * survives byte-for-byte — a guard against accidentally introducing a function,
 * class instance, or other non-cloneable field into the wire types.
 */

import { describe, expect, it } from 'bun:test';
import type {
  DbgCallFrame,
  DbgScript,
  MainToWorkerMessage,
  WorkerToMainMessage,
} from '../protocol';

const SCRIPT: DbgScript = {
  scriptId: 's1',
  url: 'app.js',
  startLine: 0,
  endLine: 42,
  hash: 'deadbeef',
};

const FRAME: DbgCallFrame = {
  callFrameId: '0',
  functionName: 'bar',
  scriptId: 's1',
  url: 'app.js',
  line: 3,
  column: 2,
  scopeChain: [
    { type: 'local', objectId: 'o1', name: 'bar' },
    { type: 'global', objectId: 'o2' },
  ],
  thisObjectId: 't1',
};

describe('dbg.* protocol', () => {
  it('round-trips main->worker dbg requests through structuredClone', () => {
    const messages: MainToWorkerMessage[] = [
      { type: 'dbg.enable', requestId: 1 },
      { type: 'dbg.disable', requestId: 2 },
      { type: 'dbg.setBreakpoint', requestId: 3, url: 'app.js', line: 3, column: 0, condition: 'x>1' },
      { type: 'dbg.setBreakpoint', requestId: 4, scriptId: 's1', line: 5 },
      { type: 'dbg.removeBreakpoint', requestId: 5, breakpointId: 'bp-1' },
      { type: 'dbg.pause', requestId: 6 },
      { type: 'dbg.resume', requestId: 7 },
      { type: 'dbg.step', requestId: 8, action: 'over' },
      { type: 'dbg.evaluateOnCallFrame', requestId: 9, callFrameId: '0', expression: 'x * 2' },
    ];
    for (const m of messages) {
      expect(structuredClone(m)).toEqual(m);
    }
  });

  it('round-trips worker->main dbg replies and events through structuredClone', () => {
    const messages: WorkerToMainMessage[] = [
      { type: 'dbg.paused', turnId: 7, reason: 'breakpoint', callFrames: [FRAME], hitBreakpoints: ['bp-1'] },
      { type: 'dbg.resumed', turnId: 7 },
      { type: 'dbg.scriptParsed', script: SCRIPT },
      { type: 'dbg.breakpointResolved', requestId: 3, breakpointId: 'bp-1', location: { scriptId: 's1', line: 3, column: 0 } },
      { type: 'dbg.evalResult', requestId: 9, ok: true, value: { n: 42, s: 'ok' } },
      { type: 'dbg.evalResult', requestId: 9, ok: false, error: 'ReferenceError: x is not defined' },
      { type: 'dbg.ack', requestId: 1 },
    ];
    for (const m of messages) {
      expect(structuredClone(m)).toEqual(m);
    }
  });

  it('preserves nested call-frame scope chains across the clone', () => {
    const msg: WorkerToMainMessage = {
      type: 'dbg.paused',
      turnId: 1,
      reason: 'step',
      callFrames: [FRAME],
      hitBreakpoints: [],
    };
    const cloned = structuredClone(msg);
    expect(cloned).toEqual(msg);
    if (cloned.type === 'dbg.paused') {
      expect(cloned.callFrames[0].scopeChain).toEqual(FRAME.scopeChain);
      expect(cloned.callFrames[0].thisObjectId).toBe('t1');
    }
  });
});
