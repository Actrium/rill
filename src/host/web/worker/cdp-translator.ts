/**
 * CdpTranslator (Milestone B web side) — a PURE Chrome DevTools Protocol (CDP)
 * <-> dbg.* translator, the web counterpart of native `AdapterDebugTarget`
 * (native/core/src/devtools/AdapterDebugTarget.cpp).
 *
 * QuickJS has no built-in CDP agent, so — exactly as on native — a central
 * translator is the only option: inbound raw CDP JSON-RPC (`Debugger.*` requests)
 * becomes rill's structured `dbg.*` messages, and the worker's outbound `dbg.*`
 * replies/events become CDP responses and `Debugger.paused/resumed/scriptParsed`
 * events. It owns the `Debugger` domain end-to-end; `Runtime`/`DOM`/`Network`
 * stay on their own handlers (mirrors `AdapterDebugTarget::ownedDomains`).
 *
 * Correlation is trivial and stateless: the CDP request `id` is reused verbatim
 * as the dbg `requestId`, so an inbound `{id}` and its later `dbg.ack{requestId}`
 * line up without any per-request bookkeeping. That keeps this class a pure
 * string-in / string-out function suitable for golden unit tests.
 *
 * The field layout of every emitted CDP object mirrors the native builders in
 * DebuggerAdapter.cpp (`callFrameToJSON`, `scriptInfoToJSON`, `onPaused`, ...).
 */

import type {
  DbgCallFrame,
  DbgPropertyDescriptor,
  DbgScript,
  MainToWorkerDbgMessage,
  WorkerToMainDbgMessage,
} from './protocol';

/** The CDP domains this translator owns end-to-end (mirrors native `DomainSet`). */
export interface CdpDomainSet {
  runtime: boolean;
  debugger: boolean;
  profiler: boolean;
  console: boolean;
}

/** Outcome of translating one inbound CDP client message. */
export interface TranslatedInbound {
  /** dbg.* message to post to the worker, or null when nothing is forwarded. */
  message: MainToWorkerDbgMessage | null;
  /**
   * An immediate raw-CDP response to send straight back to the client (no worker
   * round-trip), or null. Used for no-op/unsupported methods so DevTools is not
   * left waiting on a reply that will never come.
   */
  response: string | null;
}

// CDP JSON-RPC error codes (subset; mirrors native CDPErrorCode).
const CDP_METHOD_NOT_FOUND = -32601;

// Reason: parsed JSON-RPC objects off the wire are arbitrary until validated
type Json = Record<string, unknown>;

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

// Reason: parsed JSON-RPC fields off the wire are arbitrary until validated
function asInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

// Reason: parsed JSON-RPC fields off the wire are arbitrary until validated
function asObject(value: unknown): Json | undefined {
  return typeof value === 'object' && value !== null ? (value as Json) : undefined;
}

export class CdpTranslator {
  /** Which CDP domains this target owns (queried per request to route forward-vs-local). */
  ownedDomains(): CdpDomainSet {
    // Only the Debugger domain: Runtime stays on the local runtime handler.
    return { runtime: false, debugger: true, profiler: false, console: false };
  }

  /** `domain` is the part before the dot in a CDP method ("Debugger.enable" -> "Debugger"). */
  owns(domain: string): boolean {
    return this.ownedDomains().debugger && domain === 'Debugger';
  }

  /**
   * Translate one inbound raw CDP request into a dbg.* message (and/or an
   * immediate response). Non-`Debugger` domains return `{message:null,
   * response:null}` — the caller routes those elsewhere. A malformed message or
   * an unknown `Debugger.*` method yields a CDP error response.
   */
  translateInbound(rawCdp: string): TranslatedInbound {
    let parsed: Json;
    try {
      parsed = JSON.parse(rawCdp) as Json;
    } catch {
      return { message: null, response: null };
    }

    const method = asString(parsed.method);
    if (!method) return { message: null, response: null };

    const id = asInt(parsed.id) ?? 0;
    const dot = method.indexOf('.');
    const domain = dot === -1 ? method : method.slice(0, dot);
    const command = dot === -1 ? method : method.slice(dot + 1);

    // `Runtime.getProperties` is nominally a Runtime-domain method, but while the
    // guest is paused it expands a scope/object handle that only the debugger owns
    // (exactly as native routes it into `DebuggerAdapter::getProperties`). Claim
    // just this one Runtime method so the paused-scope expansion reaches the worker
    // as a control-plane `dbg.getProperties`; all other Runtime methods stay local.
    if (method === 'Runtime.getProperties') {
      const gpParams = asObject(parsed.params) ?? {};
      const objectId = asString(gpParams.objectId);
      if (objectId === undefined) return this.#error(id, 'Missing objectId');
      return { message: { type: 'dbg.getProperties', requestId: id, objectId }, response: null };
    }

    if (!this.owns(domain)) return { message: null, response: null };

    const params = asObject(parsed.params) ?? {};

    switch (command) {
      case 'enable':
        return { message: { type: 'dbg.enable', requestId: id }, response: null };
      case 'disable':
        return { message: { type: 'dbg.disable', requestId: id }, response: null };
      case 'setBreakpointByUrl':
        return this.#setBreakpointByUrl(id, params);
      case 'setBreakpoint':
        return this.#setBreakpoint(id, params);
      case 'removeBreakpoint': {
        const breakpointId = asString(params.breakpointId);
        if (breakpointId === undefined) return this.#error(id, 'Missing breakpointId');
        return {
          message: { type: 'dbg.removeBreakpoint', requestId: id, breakpointId },
          response: null,
        };
      }
      case 'pause':
        return { message: { type: 'dbg.pause', requestId: id }, response: null };
      case 'resume':
        return { message: { type: 'dbg.resume', requestId: id }, response: null };
      case 'stepOver':
        return { message: { type: 'dbg.step', requestId: id, action: 'over' }, response: null };
      case 'stepInto':
        return { message: { type: 'dbg.step', requestId: id, action: 'into' }, response: null };
      case 'stepOut':
        return { message: { type: 'dbg.step', requestId: id, action: 'out' }, response: null };
      case 'evaluateOnCallFrame': {
        const callFrameId = asString(params.callFrameId);
        const expression = asString(params.expression);
        if (callFrameId === undefined || expression === undefined) {
          return this.#error(id, 'Missing callFrameId or expression');
        }
        return {
          message: {
            type: 'dbg.evaluateOnCallFrame',
            requestId: id,
            callFrameId,
            expression,
          },
          response: null,
        };
      }
      case 'setPauseOnExceptions':
        // Accepted as a no-op so DevTools does not wait on a reply. Real pause-on-
        // exception wiring is deferred with the asyncify debug build.
        return { message: null, response: okResponse(id, {}) };
      default:
        return this.#error(id, `Unknown Debugger method: ${method}`);
    }
  }

  /**
   * Translate one outbound worker `dbg.*` message into a raw CDP response or
   * event. Returns null for messages that carry no CDP wire meaning.
   */
  translateOutbound(message: WorkerToMainDbgMessage): string | null {
    switch (message.type) {
      case 'dbg.ack':
        return okResponse(message.requestId, {});
      case 'dbg.breakpointResolved': {
        const locations = message.location
          ? [
              {
                scriptId: message.location.scriptId,
                lineNumber: message.location.line,
                columnNumber: message.location.column,
              },
            ]
          : [];
        return okResponse(message.requestId, { breakpointId: message.breakpointId, locations });
      }
      case 'dbg.evalResult': {
        if (message.ok) {
          return okResponse(message.requestId, { result: remoteObject(message.value) });
        }
        return okResponse(message.requestId, {
          result: { type: 'undefined' },
          exceptionDetails: {
            exceptionId: 0,
            text: message.error ?? 'Uncaught',
            lineNumber: 0,
            columnNumber: 0,
          },
        });
      }
      case 'dbg.propertiesResult':
        return okResponse(message.requestId, { result: message.properties.map(propertyToCdp) });
      case 'dbg.paused': {
        const params: Json = {
          callFrames: message.callFrames.map(callFrameToCdp),
          reason: message.reason,
        };
        if (message.hitBreakpoints.length > 0) {
          params.hitBreakpoints = message.hitBreakpoints;
        }
        return cdpEvent('Debugger.paused', params);
      }
      case 'dbg.resumed':
        return cdpEvent('Debugger.resumed', {});
      case 'dbg.scriptParsed':
        return cdpEvent('Debugger.scriptParsed', scriptToCdp(message.script));
      default:
        return null;
    }
  }

  #setBreakpointByUrl(id: number, params: Json): TranslatedInbound {
    const line = asInt(params.lineNumber);
    if (line === undefined) return this.#error(id, 'Missing lineNumber');
    const url = asString(params.url) ?? asString(params.urlRegex);
    return {
      message: {
        type: 'dbg.setBreakpoint',
        requestId: id,
        url,
        line,
        column: asInt(params.columnNumber),
        condition: asString(params.condition),
      },
      response: null,
    };
  }

  #setBreakpoint(id: number, params: Json): TranslatedInbound {
    // Real CDP Debugger.setBreakpoint nests the target under `location`.
    const location = asObject(params.location);
    const scriptId = asString(location?.scriptId);
    const line = asInt(location?.lineNumber);
    if (scriptId === undefined || line === undefined) {
      return this.#error(id, 'Missing location.scriptId or location.lineNumber');
    }
    return {
      message: {
        type: 'dbg.setBreakpoint',
        requestId: id,
        scriptId,
        line,
        column: asInt(location?.columnNumber),
        condition: asString(params.condition),
      },
      response: null,
    };
  }

  #error(id: number, message: string): TranslatedInbound {
    return { message: null, response: errorResponse(id, CDP_METHOD_NOT_FOUND, message) };
  }
}

// ============================================
// Raw CDP builders (field layout mirrors native DebuggerAdapter.cpp)
// ============================================

function okResponse(id: number, result: Json): string {
  return JSON.stringify({ id, result });
}

function errorResponse(id: number, code: number, message: string): string {
  return JSON.stringify({ id, error: { code, message } });
}

function cdpEvent(method: string, params: Json): string {
  return JSON.stringify({ method, params });
}

function callFrameToCdp(frame: DbgCallFrame): Json {
  return {
    callFrameId: frame.callFrameId,
    functionName: frame.functionName,
    location: {
      scriptId: frame.scriptId,
      lineNumber: frame.line,
      columnNumber: frame.column,
    },
    url: frame.url,
    scopeChain: frame.scopeChain.map((scope) => {
      const out: Json = {
        type: scope.type,
        object: { type: 'object', objectId: scope.objectId },
      };
      if (scope.name) out.name = scope.name;
      return out;
    }),
    this: frame.thisObjectId
      ? { type: 'object', objectId: frame.thisObjectId }
      : { type: 'object' },
  };
}

function propertyToCdp(prop: DbgPropertyDescriptor): Json {
  return {
    name: prop.name,
    value: remoteObject(prop.value),
    writable: prop.writable,
    configurable: prop.configurable,
    enumerable: prop.enumerable,
  };
}

function scriptToCdp(script: DbgScript): Json {
  return {
    scriptId: script.scriptId,
    url: script.url,
    startLine: script.startLine,
    startColumn: 0,
    endLine: script.endLine,
    endColumn: 0,
    executionContextId: 0,
    hash: script.hash,
    hasSourceURL: false,
  };
}

// Reason: a guest eval result is an arbitrary serializable value
function remoteObject(value: unknown): Json {
  if (value === null) return { type: 'object', subtype: 'null', value: null };
  const t = typeof value;
  if (t === 'undefined') return { type: 'undefined' };
  if (t === 'string' || t === 'number' || t === 'boolean') {
    return { type: t, value };
  }
  // Non-primitive: no objectId is minted here (that needs a live guest handle).
  return { type: 'object', value };
}
