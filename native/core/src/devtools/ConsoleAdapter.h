/**
 * ConsoleAdapter.h
 *
 * P3-Y.3: Console Domain Adapter
 *
 * Bridges Guest console output to CDP Runtime.consoleAPICalled events.
 * Converts DevToolsConsoleEntry to CDP format.
 */

#pragma once

#include "CDPServer.h"
#include <string>
#include <vector>
#include <functional>

namespace rill::devtools {

// ============================================
// Console Entry Types
// ============================================

/**
 * Console log level
 */
enum class ConsoleLevel {
  Log,
  Debug,
  Info,
  Warning,
  Error,
};

/**
 * Convert ConsoleLevel to CDP type string
 */
inline const char* consoleLevelToCDP(ConsoleLevel level) {
  switch (level) {
    case ConsoleLevel::Log:     return "log";
    case ConsoleLevel::Debug:   return "debug";
    case ConsoleLevel::Info:    return "info";
    case ConsoleLevel::Warning: return "warning";
    case ConsoleLevel::Error:   return "error";
    default:                    return "log";
  }
}

/**
 * Console argument (simplified representation)
 */
struct ConsoleArg {
  enum class Type {
    Undefined,
    Null,
    Boolean,
    Number,
    String,
    Object,
    Array,
    Function,
  };
  
  Type type = Type::Undefined;
  std::string value;        // String representation
  std::string description;  // Optional description for objects
  
  // Helpers
  static ConsoleArg undefined() { return {Type::Undefined, "undefined", ""}; }
  static ConsoleArg null() { return {Type::Null, "null", ""}; }
  static ConsoleArg boolean(bool v) { return {Type::Boolean, v ? "true" : "false", ""}; }
  static ConsoleArg number(double v) { return {Type::Number, std::to_string(v), ""}; }
  static ConsoleArg string(const std::string& v) { return {Type::String, v, ""}; }
  static ConsoleArg object(const std::string& desc) { return {Type::Object, "[object Object]", desc}; }
  static ConsoleArg array(const std::string& desc) { return {Type::Array, "Array", desc}; }
  static ConsoleArg function(const std::string& name) { return {Type::Function, "function", name}; }
};

/**
 * Console entry from Guest
 */
struct ConsoleEntry {
  ConsoleLevel level = ConsoleLevel::Log;
  std::vector<ConsoleArg> args;
  std::string stackTrace;      // Optional stack trace
  uint64_t timestamp = 0;      // Milliseconds since epoch
  TenantId tenantId = 0;
};

// ============================================
// Console Adapter
// ============================================

/**
 * Adapter that converts console entries to CDP events
 */
class ConsoleAdapter {
public:
  explicit ConsoleAdapter(CDPServer& server);
  ~ConsoleAdapter() = default;
  
  // Non-copyable
  ConsoleAdapter(const ConsoleAdapter&) = delete;
  ConsoleAdapter& operator=(const ConsoleAdapter&) = delete;
  
  /**
   * Called when Guest produces console output
   */
  void onConsoleEntry(const ConsoleEntry& entry);
  
  /**
   * Called when Guest throws an unhandled exception
   */
  void onException(TenantId tenantId, const std::string& message,
                   const std::string& stack, uint64_t timestamp = 0);
  
  /**
   * Handle CDP Console.enable
   */
  CDPResponse handleEnable(TenantId tenantId, int requestId);
  
  /**
   * Handle CDP Console.disable
   */
  CDPResponse handleDisable(TenantId tenantId, int requestId);
  
  /**
   * Handle CDP Console.clearMessages
   */
  CDPResponse handleClearMessages(TenantId tenantId, int requestId);

private:
  /**
   * Build CDP Runtime.consoleAPICalled event
   */
  CDPEvent buildConsoleAPICalledEvent(const ConsoleEntry& entry);
  
  /**
   * Build CDP Runtime.exceptionThrown event
   */
  CDPEvent buildExceptionThrownEvent(TenantId tenantId, const std::string& message,
                                     const std::string& stack, uint64_t timestamp);
  
  /**
   * Convert ConsoleArg to CDP RemoteObject JSON
   */
  std::string argToRemoteObjectJSON(const ConsoleArg& arg);
  
  /**
   * Parse stack trace to CDP StackTrace JSON
   */
  std::string parseStackTrace(const std::string& stack);
  
  CDPServer& server_;
};

} // namespace rill::devtools
