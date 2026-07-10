/*
 * cdp_wire.cpp — implementations of the pure-string CDP JSON wire helpers (see
 * cdp_wire.h). Moved out of CDPServer.cpp verbatim so the QuickJS debug wasm can
 * link them without the networking server.
 *
 * Licensed under the Apache License, Version 2.0.
 */
#include "cdp_wire.h"

#include <cctype>
#include <cstdint>
#include <iomanip>
#include <sstream>

namespace rill::devtools {
namespace cdp {

// Quick validation: params must start with '{' and end with '}'. Not a full JSON
// parser, but catches obviously malformed input.
static bool looksLikeJSONObject(const std::string& s) {
  if (s.empty()) return false;
  size_t first = 0;
  while (first < s.size() && std::isspace(static_cast<unsigned char>(s[first]))) first++;
  size_t last = s.size();
  while (last > first && std::isspace(static_cast<unsigned char>(s[last - 1]))) last--;
  return (last > first) && s[first] == '{' && s[last - 1] == '}';
}

std::string buildEventJSON(const std::string& method, const std::string& params,
                           const std::optional<std::string>& sessionId) {
  std::ostringstream ss;
  ss << "{\"method\":\"" << escapeJSON(method) << "\"";
  // Validate params is a JSON object; fallback to empty object
  ss << ",\"params\":" << (looksLikeJSONObject(params) ? params : std::string("{}"));
  if (sessionId) {
    ss << ",\"sessionId\":\"" << escapeJSON(*sessionId) << "\"";
  }
  ss << "}";
  return ss.str();
}

std::string buildResponseJSON(int id, const std::string& result) {
  std::ostringstream ss;
  ss << "{\"id\":" << id;
  ss << ",\"result\":" << result;
  ss << "}";
  return ss.str();
}

std::string buildErrorJSON(int id, int code, const std::string& message) {
  std::ostringstream ss;
  ss << "{\"id\":" << id;
  ss << ",\"error\":{\"code\":" << code;
  ss << ",\"message\":\"" << escapeJSON(message) << "\"}}";
  return ss.str();
}

std::string escapeJSON(const std::string& str) {
  std::ostringstream ss;
  for (char c : str) {
    switch (c) {
      case '"':  ss << "\\\""; break;
      case '\\': ss << "\\\\"; break;
      case '\b': ss << "\\b"; break;
      case '\f': ss << "\\f"; break;
      case '\n': ss << "\\n"; break;
      case '\r': ss << "\\r"; break;
      case '\t': ss << "\\t"; break;
      default:
        if (static_cast<unsigned char>(c) < 0x20) {
          ss << "\\u" << std::hex << std::setfill('0') << std::setw(4)
             << static_cast<int>(static_cast<unsigned char>(c));
        } else {
          ss << c;
        }
    }
  }
  return ss.str();
}

std::optional<std::string> parseJSONString(const std::string& json, const std::string& key) {
  std::string searchKey = "\"" + key + "\"";
  size_t keyPos = json.find(searchKey);
  if (keyPos == std::string::npos) {
    return std::nullopt;
  }

  // Find colon after key
  size_t colonPos = json.find(':', keyPos + searchKey.length());
  if (colonPos == std::string::npos) {
    return std::nullopt;
  }

  // Find opening quote
  size_t quoteStart = json.find('"', colonPos + 1);
  if (quoteStart == std::string::npos) {
    return std::nullopt;
  }

  // Find closing quote (handle escapes)
  size_t i = quoteStart + 1;
  std::string result;
  while (i < json.size()) {
    if (json[i] == '\\' && i + 1 < json.size()) {
      // Handle escape sequences
      switch (json[i + 1]) {
        case '"':  result += '"'; break;
        case '\\': result += '\\'; break;
        case 'n':  result += '\n'; break;
        case 'r':  result += '\r'; break;
        case 't':  result += '\t'; break;
        default:   result += json[i + 1]; break;
      }
      i += 2;
    } else if (json[i] == '"') {
      return result;
    } else {
      result += json[i];
      i++;
    }
  }

  return std::nullopt;
}

std::optional<int> parseJSONInt(const std::string& json, const std::string& key) {
  std::string searchKey = "\"" + key + "\"";
  size_t keyPos = json.find(searchKey);
  if (keyPos == std::string::npos) {
    return std::nullopt;
  }

  // Find colon after key
  size_t colonPos = json.find(':', keyPos + searchKey.length());
  if (colonPos == std::string::npos) {
    return std::nullopt;
  }

  // Skip whitespace
  size_t numStart = colonPos + 1;
  while (numStart < json.size() && std::isspace(json[numStart])) {
    numStart++;
  }

  // Parse number
  if (numStart >= json.size()) {
    return std::nullopt;
  }

  bool negative = false;
  if (json[numStart] == '-') {
    negative = true;
    numStart++;
  }

  long long result = 0;
  while (numStart < json.size() &&
         std::isdigit(static_cast<unsigned char>(json[numStart]))) {
    result = result * 10 + (json[numStart] - '0');
    if (result > INT32_MAX) {
      return std::nullopt;  // Overflow
    }
    numStart++;
  }

  int intResult = static_cast<int>(negative ? -result : result);
  return intResult;
}

}  // namespace cdp
}  // namespace rill::devtools
