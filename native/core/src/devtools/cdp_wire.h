/*
 * cdp_wire.h — the pure-string CDP JSON wire helpers, split out of CDPServer so
 * they can be compiled without the networking server. The QuickJS debug wasm
 * embeds the CDP engine (DebuggerAdapter / AdapterDebugTarget / the engine
 * debugger) and needs exactly these helpers; pulling them here keeps the wasm
 * build free of CDPServer.cpp (sockets, threads). CDPServer keeps the HTTP /
 * discovery helpers (buildHttpResponse / parseRequestLine / injectSessionId),
 * which depend on its own types.
 *
 * SessionId is just std::string, so buildEventJSON takes std::optional<std::string>
 * here to avoid depending on CDPServer.h's alias.
 *
 * Licensed under the Apache License, Version 2.0.
 */
#pragma once

#include <optional>
#include <string>

namespace rill::devtools {
namespace cdp {

// Build a CDP event JSON object: {"method":..,"params":..[,"sessionId":..]}.
// params must be a JSON object; invalid input falls back to "{}".
std::string buildEventJSON(const std::string& method, const std::string& params,
                           const std::optional<std::string>& sessionId = std::nullopt);

// Build a CDP response JSON object: {"id":..,"result":..}.
std::string buildResponseJSON(int id, const std::string& result);

// Build a CDP error response JSON object: {"id":..,"error":{..}}.
std::string buildErrorJSON(int id, int code, const std::string& message);

// Escape a string for embedding in JSON (quotes, backslashes, control chars).
std::string escapeJSON(const std::string& str);

// Extract a string value for `key` from a flat JSON object (naive, escape-aware).
std::optional<std::string> parseJSONString(const std::string& json, const std::string& key);

// Extract an int value for `key` from a flat JSON object (naive, overflow-safe).
std::optional<int> parseJSONInt(const std::string& json, const std::string& key);

}  // namespace cdp
}  // namespace rill::devtools
