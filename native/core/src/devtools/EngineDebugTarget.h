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

#include "ConnectionId.h"

#include <functional>
#include <string>

namespace rill::devtools {

// A raw CDP message on the wire (a full JSON-RPC object): a request from the
// client, or a response/event going back to it. The relay seam moves WHOLE CDP
// messages, never parsed method-by-method.
using RawCdpMessage = std::string;

// Persistent per-connection sink the target uses to push raw CDP messages back
// to the DevTools client. Installed once at onClientConnect() and used for the
// life of the connection — because a CDP-native agent emits its responses AND
// its async events (Debugger.paused, scriptParsed, ...) OUTSIDE the scope of any
// single request. One request may produce 0..N outbound messages, and events
// may arrive with no request in flight at all.
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

  // A DevTools client has connected and its first owned-domain request is about
  // to arrive. `persistentSink` is how the target pushes every subsequent raw
  // CDP message for this connection — responses AND async events — for the life
  // of the connection. Called once per (connection, target) pair, before the
  // first dispatch() for that connection.
  virtual void onClientConnect(ConnectionId conn, CdpOutboundFn persistentSink) = 0;

  // The client connection is gone. Tear down any per-connection state (e.g. a
  // CDP agent) and drop the persistent sink. After this, the sink must not be
  // called for `conn` again.
  virtual void onClientDisconnect(ConnectionId conn) = 0;

  // Consume one raw CDP request from `conn`. Responses and events are emitted
  // asynchronously through that connection's persistent sink (see
  // onClientConnect) — NOT returned here — because a CDP-native agent may reply
  // and raise events from another thread after this returns.
  //
  // Threading contract: CDPServer calls onClientConnect()/dispatch() with its
  // internal mutex RELEASED, precisely so the sink may re-enter the server
  // (sendToConnection) without self-deadlock. Implementations must not assume
  // the server lock is held, and must not block the calling thread on the client.
  virtual void dispatch(ConnectionId conn, const RawCdpMessage& rawCdpRequest) = 0;
};

}  // namespace rill::devtools
