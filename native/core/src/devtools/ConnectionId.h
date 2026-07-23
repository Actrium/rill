/**
 * ConnectionId.h
 *
 * Single source of truth for the WebSocket connection identifier shared between
 * the CDP transport, CDPServer, and the relay seam (IEngineDebugTarget). Kept in
 * its own header so EngineDebugTarget.h and CDPServer.h agree on the type
 * without one having to include the other.
 */
#pragma once

#include <cstdint>

namespace rill::devtools {

using ConnectionId = std::uint64_t;

}  // namespace rill::devtools
