/**
 * EngineDebugTarget.h
 *
 * The per-tenant relay seam between CDPServer and a debug engine (Phase-2 T2.1).
 *
 * Rationale: CDP-native engines (Hermes cdp::CDPAgent, V8, JSC RemoteInspector)
 * want to own the raw CDP conversation for a domain and speak it end-to-end;
 * forcing them through a method-level interface would mean pointless
 * re-serialization. Engines with no built-in agent (QuickJS) instead need a
 * central CDP<->primitive translator. Both shapes plug in behind this one seam:
 * a target that (a) consumes a raw CDP request and (b) declares which domains it
 * owns. CDPServer becomes a domain-ownership multiplexer: owned domains are
 * forwarded verbatim; the rest keep going through CDPServer's local handlers.
 */
#pragma once

#include <functional>
#include <string>

namespace rill::devtools {

// A raw CDP message on the wire (a full JSON-RPC object): a request from the
// client, or a response/event going back to it. The relay seam moves WHOLE CDP
// messages, never parsed method-by-method.
using RawCdpMessage = std::string;

// Sink the target uses to push each raw CDP message back to the DevTools client.
// One request may produce 0..N outbound messages (its response plus any events).
// Called by the target during dispatch(); see the threading contract there.
using CdpOutboundFn = std::function<void(const RawCdpMessage&)>;

// The CDP domains a target owns end-to-end. When a target owns a domain,
// CDPServer forwards that domain's requests to it VERBATIM and does NOT
// synthesize a response — the target is the sole authority and emits the
// response (and any events) through the outbound sink. Domains not owned by any
// target (DOM/Network/Target) keep going through CDPServer's local handlers.
struct DomainSet {
  bool runtime = false;
  bool debugger = false;
  bool profiler = false;
  bool console = false;

  // `domain` is the part before the dot in a CDP method ("Runtime.evaluate" ->
  // "Runtime"). Unknown / locally-handled domains return false.
  bool owns(const std::string& domain) const {
    if (domain == "Runtime") return runtime;
    if (domain == "Debugger") return debugger;
    if (domain == "Profiler") return profiler;
    if (domain == "Console") return console;
    return false;
  }
};

// Per-tenant debug target. Two shapes plug in behind this one seam:
//   * CDPAgentTarget    — thin passthrough to an engine's built-in CDP agent
//                         (Hermes facebook::hermes::cdp::CDPAgent; V8/JSC are
//                         conceptually the same). Near-zero re-serialization.
//   * AdapterDebugTarget — wraps the method-level DebuggerAdapter/IEngineDebugger
//                         for engines with no built-in agent (QuickJS), where a
//                         central CDP<->primitive translator is the only option.
//
// CDPServer owns at most one target per tenant.
class IEngineDebugTarget {
public:
  virtual ~IEngineDebugTarget() = default;

  // Which CDP domains this target owns end-to-end. Queried per request to decide
  // forward-vs-local; keep it cheap and stable for the target's lifetime.
  virtual DomainSet ownedDomains() const = 0;

  // Consume one raw CDP request and emit 0..N raw CDP messages (its response and
  // any events) through `out`.
  //
  // Threading contract: CDPServer calls dispatch() with its internal mutex
  // RELEASED, precisely so `out` may re-enter the server (e.g. to resolve the
  // connection) without self-deadlock. Implementations must not assume the
  // server lock is held, and must not block the calling thread on the client.
  virtual void dispatch(const RawCdpMessage& rawCdpRequest,
                        const CdpOutboundFn& out) = 0;
};

}  // namespace rill::devtools
