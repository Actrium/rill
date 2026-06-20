/**
 * ConsoleAdapter.cpp
 *
 * P3-Y.3: Console Domain Adapter Implementation
 */

#include "ConsoleAdapter.h"
#include <sstream>
#include <chrono>
#include <regex>

namespace rill::devtools {

ConsoleAdapter::ConsoleAdapter(CDPServer& server)
    : server_(server) {}

void ConsoleAdapter::onConsoleEntry(const ConsoleEntry& entry) {
  CDPEvent event = buildConsoleAPICalledEvent(entry);
  server_.sendEvent(entry.tenantId, event);
}

void ConsoleAdapter::onException(TenantId tenantId, const std::string& message,
                                  const std::string& stack, uint64_t timestamp) {
  if (timestamp == 0) {
    auto now = std::chrono::system_clock::now();
    timestamp = std::chrono::duration_cast<std::chrono::milliseconds>(
        now.time_since_epoch()).count();
  }
  
  CDPEvent event = buildExceptionThrownEvent(tenantId, message, stack, timestamp);
  server_.sendEvent(tenantId, event);
}

CDPResponse ConsoleAdapter::handleEnable(TenantId /*tenantId*/, int requestId) {
  // Console.enable just acknowledges - actual enabling is in session state
  CDPResponse response;
  response.id = requestId;
  response.result = "{}";
  return response;
}

CDPResponse ConsoleAdapter::handleDisable(TenantId /*tenantId*/, int requestId) {
  CDPResponse response;
  response.id = requestId;
  response.result = "{}";
  return response;
}

CDPResponse ConsoleAdapter::handleClearMessages(TenantId /*tenantId*/, int requestId) {
  // We don't buffer messages, so nothing to clear
  CDPResponse response;
  response.id = requestId;
  response.result = "{}";
  return response;
}

CDPEvent ConsoleAdapter::buildConsoleAPICalledEvent(const ConsoleEntry& entry) {
  CDPEvent event;
  event.method = "Runtime.consoleAPICalled";
  
  std::ostringstream params;
  params << "{";
  params << "\"type\":\"" << consoleLevelToCDP(entry.level) << "\"";
  
  // Args array
  params << ",\"args\":[";
  for (size_t i = 0; i < entry.args.size(); ++i) {
    if (i > 0) params << ",";
    params << argToRemoteObjectJSON(entry.args[i]);
  }
  params << "]";
  
  // Timestamp
  params << ",\"timestamp\":" << entry.timestamp;
  
  // Stack trace (if available)
  if (!entry.stackTrace.empty()) {
    params << ",\"stackTrace\":" << parseStackTrace(entry.stackTrace);
  }
  
  // Execution context ID (we use tenantId)
  params << ",\"executionContextId\":" << entry.tenantId;
  
  params << "}";
  
  event.params = params.str();
  return event;
}

CDPEvent ConsoleAdapter::buildExceptionThrownEvent(TenantId tenantId,
                                                    const std::string& message,
                                                    const std::string& stack,
                                                    uint64_t timestamp) {
  CDPEvent event;
  event.method = "Runtime.exceptionThrown";
  
  std::ostringstream params;
  params << "{";
  params << "\"timestamp\":" << timestamp;
  params << ",\"exceptionDetails\":{";
  params << "\"exceptionId\":1";  // We don't track exception IDs
  params << ",\"text\":\"" << cdp::escapeJSON(message) << "\"";
  params << ",\"lineNumber\":0";
  params << ",\"columnNumber\":0";
  
  // Exception object
  params << ",\"exception\":{";
  params << "\"type\":\"object\"";
  params << ",\"subtype\":\"error\"";
  params << ",\"className\":\"Error\"";
  params << ",\"description\":\"" << cdp::escapeJSON(message) << "\"";
  params << "}";
  
  // Stack trace
  if (!stack.empty()) {
    params << ",\"stackTrace\":" << parseStackTrace(stack);
  }
  
  params << ",\"executionContextId\":" << tenantId;
  params << "}";  // exceptionDetails
  params << "}";
  
  event.params = params.str();
  return event;
}

std::string ConsoleAdapter::argToRemoteObjectJSON(const ConsoleArg& arg) {
  std::ostringstream ss;
  ss << "{";
  
  switch (arg.type) {
    case ConsoleArg::Type::Undefined:
      ss << "\"type\":\"undefined\"";
      break;
      
    case ConsoleArg::Type::Null:
      ss << "\"type\":\"object\"";
      ss << ",\"subtype\":\"null\"";
      ss << ",\"value\":null";
      break;
      
    case ConsoleArg::Type::Boolean:
      ss << "\"type\":\"boolean\"";
      ss << ",\"value\":" << arg.value;
      break;
      
    case ConsoleArg::Type::Number:
      ss << "\"type\":\"number\"";
      ss << ",\"value\":" << arg.value;
      ss << ",\"description\":\"" << arg.value << "\"";
      break;
      
    case ConsoleArg::Type::String:
      ss << "\"type\":\"string\"";
      ss << ",\"value\":\"" << cdp::escapeJSON(arg.value) << "\"";
      break;
      
    case ConsoleArg::Type::Object:
      ss << "\"type\":\"object\"";
      ss << ",\"className\":\"Object\"";
      if (!arg.description.empty()) {
        ss << ",\"description\":\"" << cdp::escapeJSON(arg.description) << "\"";
      } else {
        ss << ",\"description\":\"Object\"";
      }
      break;
      
    case ConsoleArg::Type::Array:
      ss << "\"type\":\"object\"";
      ss << ",\"subtype\":\"array\"";
      ss << ",\"className\":\"Array\"";
      if (!arg.description.empty()) {
        ss << ",\"description\":\"" << cdp::escapeJSON(arg.description) << "\"";
      }
      break;
      
    case ConsoleArg::Type::Function:
      ss << "\"type\":\"function\"";
      ss << ",\"className\":\"Function\"";
      if (!arg.description.empty()) {
        ss << ",\"description\":\"function " << cdp::escapeJSON(arg.description) << "() {}\"";
      }
      break;
  }
  
  ss << "}";
  return ss.str();
}

std::string ConsoleAdapter::parseStackTrace(const std::string& stack) {
  std::ostringstream ss;
  ss << "{\"callFrames\":[";
  
  // Parse stack trace lines
  // Format: "    at functionName (filename:line:col)"
  // or: "    at filename:line:col"
  std::istringstream iss(stack);
  std::string line;
  bool first = true;
  
  while (std::getline(iss, line)) {
    // Skip empty lines and the error message line
    if (line.empty() || line.find("    at ") == std::string::npos) {
      continue;
    }
    
    if (!first) ss << ",";
    first = false;
    
    ss << "{";
    
    // Try to parse the line
    // Simple parsing - extract function name and location
    std::string functionName = "";
    std::string url = "";
    int lineNumber = 0;
    int columnNumber = 0;
    
    size_t atPos = line.find("at ");
    if (atPos != std::string::npos) {
      std::string rest = line.substr(atPos + 3);
      
      // Check for "functionName (url:line:col)" format
      size_t parenPos = rest.find(" (");
      if (parenPos != std::string::npos) {
        functionName = rest.substr(0, parenPos);
        std::string location = rest.substr(parenPos + 2);
        // Remove trailing )
        if (!location.empty() && location.back() == ')') {
          location.pop_back();
        }
        
        // Parse location
        size_t lastColon = location.rfind(':');
        if (lastColon != std::string::npos) {
          columnNumber = std::stoi(location.substr(lastColon + 1));
          location = location.substr(0, lastColon);
          
          lastColon = location.rfind(':');
          if (lastColon != std::string::npos) {
            lineNumber = std::stoi(location.substr(lastColon + 1));
            url = location.substr(0, lastColon);
          }
        }
      } else {
        // "url:line:col" format
        functionName = "(anonymous)";
        
        size_t lastColon = rest.rfind(':');
        if (lastColon != std::string::npos) {
          try {
            columnNumber = std::stoi(rest.substr(lastColon + 1));
            rest = rest.substr(0, lastColon);
            
            lastColon = rest.rfind(':');
            if (lastColon != std::string::npos) {
              lineNumber = std::stoi(rest.substr(lastColon + 1));
              url = rest.substr(0, lastColon);
            }
          } catch (...) {
            // Parsing failed, use defaults
          }
        }
      }
    }
    
    ss << "\"functionName\":\"" << cdp::escapeJSON(functionName) << "\"";
    ss << ",\"scriptId\":\"0\"";  // We don't have script IDs
    ss << ",\"url\":\"" << cdp::escapeJSON(url) << "\"";
    ss << ",\"lineNumber\":" << lineNumber;
    ss << ",\"columnNumber\":" << columnNumber;
    ss << "}";
  }
  
  ss << "]}";
  return ss.str();
}

} // namespace rill::devtools
