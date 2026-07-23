/**
 * CdpTranslator golden tests (Milestone B web side).
 *
 * The translator is pure string-in / string-out, so these are exact goldens for
 * both directions: raw CDP Debugger.* requests -> dbg.* messages, and worker
 * dbg.* replies/events -> raw CDP responses/events. The emitted CDP field layout
 * mirrors native DebuggerAdapter.cpp (callFrameToJSON / scriptInfoToJSON / onPaused).
 */

import { describe, expect, it } from 'bun:test';
import { CdpTranslator } from '../cdp-translator';
import type { DbgCallFrame } from '../protocol';

const t = new CdpTranslator();

function inbound(msg: Record<string, unknown>) {
  return t.translateInbound(JSON.stringify(msg));
}

describe('CdpTranslator — domain ownership', () => {
  it('owns only the Debugger domain', () => {
    expect(t.owns('Debugger')).toBe(true);
    expect(t.owns('Runtime')).toBe(false);
    expect(t.ownedDomains()).toEqual({
      runtime: false,
      debugger: true,
      profiler: false,
      console: false,
    });
  });

  it('ignores non-owned domains (leaves them for local handlers)', () => {
    expect(inbound({ id: 1, method: 'Runtime.evaluate', params: {} })).toEqual({
      message: null,
      response: null,
    });
  });
});

describe('CdpTranslator — inbound CDP -> dbg.*', () => {
  it('translates Debugger.enable / disable', () => {
    expect(inbound({ id: 1, method: 'Debugger.enable' })).toEqual({
      message: { type: 'dbg.enable', requestId: 1 },
      response: null,
    });
    expect(inbound({ id: 2, method: 'Debugger.disable' }).message).toEqual({
      type: 'dbg.disable',
      requestId: 2,
    });
  });

  it('translates setBreakpointByUrl', () => {
    const r = inbound({
      id: 3,
      method: 'Debugger.setBreakpointByUrl',
      params: { lineNumber: 3, url: 'app.js', columnNumber: 0, condition: 'x > 1' },
    });
    expect(r.message).toEqual({
      type: 'dbg.setBreakpoint',
      requestId: 3,
      url: 'app.js',
      line: 3,
      column: 0,
      condition: 'x > 1',
    });
  });

  it('translates setBreakpoint with a nested location', () => {
    const r = inbound({
      id: 4,
      method: 'Debugger.setBreakpoint',
      params: { location: { scriptId: 's1', lineNumber: 5, columnNumber: 2 } },
    });
    expect(r.message).toEqual({
      type: 'dbg.setBreakpoint',
      requestId: 4,
      scriptId: 's1',
      line: 5,
      column: 2,
    });
  });

  it('translates removeBreakpoint / pause / resume', () => {
    expect(inbound({ id: 5, method: 'Debugger.removeBreakpoint', params: { breakpointId: 'bp-1' } }).message).toEqual(
      { type: 'dbg.removeBreakpoint', requestId: 5, breakpointId: 'bp-1' }
    );
    expect(inbound({ id: 6, method: 'Debugger.pause' }).message).toEqual({ type: 'dbg.pause', requestId: 6 });
    expect(inbound({ id: 7, method: 'Debugger.resume' }).message).toEqual({ type: 'dbg.resume', requestId: 7 });
  });

  it('translates the three step commands', () => {
    expect(inbound({ id: 8, method: 'Debugger.stepOver' }).message).toEqual({ type: 'dbg.step', requestId: 8, action: 'over' });
    expect(inbound({ id: 9, method: 'Debugger.stepInto' }).message).toEqual({ type: 'dbg.step', requestId: 9, action: 'into' });
    expect(inbound({ id: 10, method: 'Debugger.stepOut' }).message).toEqual({ type: 'dbg.step', requestId: 10, action: 'out' });
  });

  it('translates evaluateOnCallFrame', () => {
    expect(
      inbound({ id: 11, method: 'Debugger.evaluateOnCallFrame', params: { callFrameId: '0', expression: 'x * 2' } })
        .message
    ).toEqual({ type: 'dbg.evaluateOnCallFrame', requestId: 11, callFrameId: '0', expression: 'x * 2' });
  });

  it('claims Runtime.getProperties (paused-scope expansion) as a control-plane dbg op', () => {
    expect(
      inbound({ id: 14, method: 'Runtime.getProperties', params: { objectId: '0:local', ownProperties: true } })
        .message
    ).toEqual({ type: 'dbg.getProperties', requestId: 14, objectId: '0:local' });
  });

  it('errors on Runtime.getProperties without an objectId', () => {
    const r = inbound({ id: 15, method: 'Runtime.getProperties', params: {} });
    expect(r.message).toBeNull();
    expect(JSON.parse(r.response ?? '').error.message).toBe('Missing objectId');
  });

  it('leaves other Runtime methods for the local handler', () => {
    expect(inbound({ id: 16, method: 'Runtime.callFunctionOn', params: {} })).toEqual({
      message: null,
      response: null,
    });
  });

  it('answers setPauseOnExceptions immediately as a no-op', () => {
    const r = inbound({ id: 12, method: 'Debugger.setPauseOnExceptions', params: { state: 'none' } });
    expect(r.message).toBeNull();
    expect(JSON.parse(r.response ?? '')).toEqual({ id: 12, result: {} });
  });

  it('errors on an unknown Debugger method', () => {
    const r = inbound({ id: 13, method: 'Debugger.bogus' });
    expect(r.message).toBeNull();
    expect(JSON.parse(r.response ?? '')).toEqual({
      id: 13,
      error: { code: -32601, message: 'Unknown Debugger method: Debugger.bogus' },
    });
  });

  it('reuses the CDP request id as the dbg requestId (stateless correlation)', () => {
    const r = inbound({ id: 99, method: 'Debugger.enable' });
    expect(r.message?.requestId).toBe(99);
    const resp = JSON.parse(t.translateOutbound({ type: 'dbg.ack', requestId: 99 }) ?? '');
    expect(resp.id).toBe(99);
  });
});

describe('CdpTranslator — outbound dbg.* -> CDP', () => {
  const FRAME: DbgCallFrame = {
    callFrameId: '0',
    functionName: 'bar',
    scriptId: 's1',
    url: 'app.js',
    line: 3,
    column: 2,
    scopeChain: [{ type: 'local', objectId: 'o1', name: 'bar' }],
    thisObjectId: 't1',
  };

  it('translates dbg.paused to Debugger.paused', () => {
    const out = t.translateOutbound({
      type: 'dbg.paused',
      turnId: 1,
      reason: 'breakpoint',
      callFrames: [FRAME],
      hitBreakpoints: ['bp-1'],
    });
    expect(JSON.parse(out ?? '')).toEqual({
      method: 'Debugger.paused',
      params: {
        callFrames: [
          {
            callFrameId: '0',
            functionName: 'bar',
            location: { scriptId: 's1', lineNumber: 3, columnNumber: 2 },
            url: 'app.js',
            scopeChain: [{ type: 'local', object: { type: 'object', objectId: 'o1' }, name: 'bar' }],
            this: { type: 'object', objectId: 't1' },
          },
        ],
        reason: 'breakpoint',
        hitBreakpoints: ['bp-1'],
      },
    });
  });

  it('omits hitBreakpoints when empty and this.objectId when absent', () => {
    const out = t.translateOutbound({
      type: 'dbg.paused',
      turnId: 1,
      reason: 'other',
      callFrames: [{ ...FRAME, thisObjectId: '', scopeChain: [] }],
      hitBreakpoints: [],
    });
    const parsed = JSON.parse(out ?? '');
    expect(parsed.params.hitBreakpoints).toBeUndefined();
    expect(parsed.params.callFrames[0].this).toEqual({ type: 'object' });
  });

  it('translates dbg.resumed and dbg.scriptParsed', () => {
    expect(JSON.parse(t.translateOutbound({ type: 'dbg.resumed', turnId: 1 }) ?? '')).toEqual({
      method: 'Debugger.resumed',
      params: {},
    });
    expect(
      JSON.parse(
        t.translateOutbound({
          type: 'dbg.scriptParsed',
          script: { scriptId: 's1', url: 'app.js', startLine: 0, endLine: 9, hash: 'h' },
        }) ?? ''
      )
    ).toEqual({
      method: 'Debugger.scriptParsed',
      params: {
        scriptId: 's1',
        url: 'app.js',
        startLine: 0,
        startColumn: 0,
        endLine: 9,
        endColumn: 0,
        executionContextId: 0,
        hash: 'h',
        hasSourceURL: false,
      },
    });
  });

  it('translates dbg.ack / breakpointResolved / evalResult to responses', () => {
    expect(JSON.parse(t.translateOutbound({ type: 'dbg.ack', requestId: 1 }) ?? '')).toEqual({ id: 1, result: {} });

    expect(
      JSON.parse(
        t.translateOutbound({
          type: 'dbg.breakpointResolved',
          requestId: 2,
          breakpointId: 'bp-1',
          location: { scriptId: 's1', line: 3, column: 0 },
        }) ?? ''
      )
    ).toEqual({
      id: 2,
      result: { breakpointId: 'bp-1', locations: [{ scriptId: 's1', lineNumber: 3, columnNumber: 0 }] },
    });

    expect(JSON.parse(t.translateOutbound({ type: 'dbg.evalResult', requestId: 3, ok: true, value: 42 }) ?? '')).toEqual(
      { id: 3, result: { result: { type: 'number', value: 42 } } }
    );
  });

  it('translates dbg.propertiesResult to a Runtime.getProperties result payload', () => {
    const parsed = JSON.parse(
      t.translateOutbound({
        type: 'dbg.propertiesResult',
        requestId: 7,
        properties: [
          { name: 'x', value: 42, writable: true, configurable: true, enumerable: true },
          { name: 'obj', value: { a: 1 }, writable: false, configurable: false, enumerable: true },
        ],
      }) ?? ''
    );
    expect(parsed.id).toBe(7);
    expect(parsed.result.result).toEqual([
      { name: 'x', value: { type: 'number', value: 42 }, writable: true, configurable: true, enumerable: true },
      {
        name: 'obj',
        value: { type: 'object', value: { a: 1 } },
        writable: false,
        configurable: false,
        enumerable: true,
      },
    ]);
  });

  it('maps a failed eval to exceptionDetails', () => {
    const parsed = JSON.parse(
      t.translateOutbound({ type: 'dbg.evalResult', requestId: 4, ok: false, error: 'ReferenceError: x' }) ?? ''
    );
    expect(parsed.id).toBe(4);
    expect(parsed.result.result).toEqual({ type: 'undefined' });
    expect(parsed.result.exceptionDetails.text).toBe('ReferenceError: x');
  });
});
