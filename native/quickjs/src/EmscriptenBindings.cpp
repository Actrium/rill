/**
 * Emscripten Bindings for QuickJS Sandbox
 *
 * Exposes C++ JSI API to JavaScript/TypeScript
 */

#include <emscripten/bind.h>
#include <emscripten/val.h>
#include <cstring>
#include <vector>
#include "QuickJSSandboxJSI.h"
#include "QuickJSRuntimeFactory.h"
#include "jsi/jsi.h"

using namespace emscripten;
using namespace facebook::jsi;

/**
 * WASM-compatible wrapper for QuickJS Runtime
 *
 * Bridges the JSI C++ API to JavaScript via Emscripten
 */
class QuickJSWASMRuntime {
private:
    std::shared_ptr<Runtime> runtime_;

public:
    QuickJSWASMRuntime() {
        // Create QuickJS runtime using the existing factory
        runtime_ = rill::createQuickJSRuntime();
    }

    ~QuickJSWASMRuntime() {
        // Runtime automatically cleaned up
    }

    /**
     * Evaluate JavaScript code
     *
     * @param code JavaScript code string
     * @return Result as JSON string (or error)
     */
    std::string eval(const std::string& code) {
        try {
            auto result = runtime_->evaluateJavaScript(
                std::make_shared<StringBuffer>(code),
                "eval"
            );

            // Convert JSI Value to JSON string
            return valueToJSON(result);
        } catch (const JSError& e) {
            return std::string("{\"error\":\"") + e.getMessage() + "\"}";
        } catch (const std::exception& e) {
            return std::string("{\"error\":\"") + e.what() + "\"}";
        }
    }

    /**
     * Set a global variable
     *
     * @param name Variable name
     * @param valueJSON Value as JSON string
     */
    void inject(const std::string& name, const std::string& valueJSON) {
        try {
            // Parse JSON to JSI Value
            auto value = parseJSON(valueJSON);
            runtime_->global().setProperty(*runtime_, name.c_str(), value);
        } catch (const std::exception& e) {
            // Log error
            fprintf(stderr, "inject failed: %s\n", e.what());
        }
    }

    /**
     * Get a global variable
     *
     * @param name Variable name
     * @return Value as JSON string
     */
    std::string extract(const std::string& name) {
        try {
            auto value = runtime_->global().getProperty(*runtime_, name.c_str());
            return valueToJSON(value);
        } catch (const std::exception& e) {
            return std::string("{\"error\":\"") + e.what() + "\"}";
        }
    }

    /**
     * Set a global ArrayBuffer from WASM memory
     *
     * @param name Variable name
     * @param ptr Pointer to data in WASM linear memory
     * @param length Data length in bytes
     */
    void injectArrayBuffer(const std::string& name, uintptr_t ptr, size_t length) {
        try {
            // Create a MutableBuffer that wraps the WASM memory
            class WASMBuffer : public MutableBuffer {
            private:
                std::vector<uint8_t> data_;

            public:
                WASMBuffer(const uint8_t* src, size_t len) : data_(src, src + len) {}

                size_t size() const override {
                    return data_.size();
                }

                uint8_t* data() override {
                    return data_.data();
                }
            };

            // Copy data from WASM memory to buffer
            auto buffer = std::make_shared<WASMBuffer>(
                reinterpret_cast<const uint8_t*>(ptr),
                length
            );

            // Create ArrayBuffer
            auto arrayBuffer = runtime_->createArrayBuffer(buffer);

            // Set as global
            runtime_->global().setProperty(*runtime_, name.c_str(), std::move(arrayBuffer));
        } catch (const std::exception& e) {
            fprintf(stderr, "injectArrayBuffer failed: %s\n", e.what());
        }
    }

    /**
     * Get a global ArrayBuffer and copy to WASM memory
     *
     * @param name Variable name
     * @param ptr Pointer to destination in WASM linear memory
     * @param maxLength Maximum bytes to copy
     * @return Actual bytes copied, or 0 on error
     */
    size_t extractArrayBuffer(const std::string& name, uintptr_t ptr, size_t maxLength) {
        try {
            auto value = runtime_->global().getProperty(*runtime_, name.c_str());

            if (!value.isObject()) {
                return 0;
            }

            auto obj = value.getObject(*runtime_);

            // Check if it's an ArrayBuffer
            if (!obj.isArrayBuffer(*runtime_)) {
                return 0;
            }

            auto arrayBuffer = obj.getArrayBuffer(*runtime_);

            // Get size and data
            size_t bufferSize = arrayBuffer.size(*runtime_);
            uint8_t* bufferData = arrayBuffer.data(*runtime_);

            // Copy to WASM memory (limited by maxLength)
            size_t copySize = std::min(bufferSize, maxLength);
            std::memcpy(reinterpret_cast<void*>(ptr), bufferData, copySize);

            return copySize;
        } catch (const std::exception& e) {
            fprintf(stderr, "extractArrayBuffer failed: %s\n", e.what());
            return 0;
        }
    }

    /**
     * Get the size of a global ArrayBuffer
     *
     * @param name Variable name
     * @return Size in bytes, or 0 if not an ArrayBuffer
     */
    size_t extractArrayBufferSize(const std::string& name) {
        try {
            auto value = runtime_->global().getProperty(*runtime_, name.c_str());

            if (!value.isObject()) {
                return 0;
            }

            auto obj = value.getObject(*runtime_);

            if (!obj.isArrayBuffer(*runtime_)) {
                return 0;
            }

            auto arrayBuffer = obj.getArrayBuffer(*runtime_);
            return arrayBuffer.size(*runtime_);
        } catch (const std::exception& e) {
            fprintf(stderr, "extractArrayBufferSize failed: %s\n", e.what());
            return 0;
        }
    }

private:
    /**
     * Convert JSI Value to JSON string
     */
    std::string valueToJSON(const Value& value) {
        if (value.isUndefined()) {
            return "undefined";
        }
        if (value.isNull()) {
            return "null";
        }
        if (value.isBool()) {
            return value.getBool() ? "true" : "false";
        }
        if (value.isNumber()) {
            return std::to_string(value.getNumber());
        }
        if (value.isString()) {
            // Escape string
            std::string str = value.getString(*runtime_).utf8(*runtime_);
            return "\"" + escapeJSON(str) + "\"";
        }
        if (value.isObject()) {
            // Use JSON.stringify
            auto json = runtime_->global()
                .getPropertyAsObject(*runtime_, "JSON")
                .getPropertyAsFunction(*runtime_, "stringify");
            auto result = json.call(*runtime_, value);
            return result.getString(*runtime_).utf8(*runtime_);
        }
        return "null";
    }

    /**
     * Parse JSON string to JSI Value
     */
    Value parseJSON(const std::string& json) {
        auto jsonParse = runtime_->global()
            .getPropertyAsObject(*runtime_, "JSON")
            .getPropertyAsFunction(*runtime_, "parse");
        return jsonParse.call(*runtime_, String::createFromUtf8(*runtime_, json));
    }

    /**
     * Escape string for JSON
     */
    std::string escapeJSON(const std::string& str) {
        std::string escaped;
        for (char c : str) {
            switch (c) {
                case '"': escaped += "\\\""; break;
                case '\\': escaped += "\\\\"; break;
                case '\b': escaped += "\\b"; break;
                case '\f': escaped += "\\f"; break;
                case '\n': escaped += "\\n"; break;
                case '\r': escaped += "\\r"; break;
                case '\t': escaped += "\\t"; break;
                default: escaped += c;
            }
        }
        return escaped;
    }
};

// ⭐ Emscripten Bindings - Expose to JavaScript
EMSCRIPTEN_BINDINGS(quickjs_sandbox) {
    class_<QuickJSWASMRuntime>("QuickJSRuntime")
        .constructor<>()
        .function("eval", &QuickJSWASMRuntime::eval)
        .function("inject", &QuickJSWASMRuntime::inject)
        .function("extract", &QuickJSWASMRuntime::extract)
        .function("injectArrayBuffer", &QuickJSWASMRuntime::injectArrayBuffer)
        .function("extractArrayBuffer", &QuickJSWASMRuntime::extractArrayBuffer)
        .function("extractArrayBufferSize", &QuickJSWASMRuntime::extractArrayBufferSize);
}
