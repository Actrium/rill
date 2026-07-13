/**
 * QuickJS WASM Bindings
 *
 * Simple C API for WASM that exposes QuickJS functionality
 * for E2E testing in Node.js/Browser environments.
 */

#include <quickjs.h>
#include <stdlib.h>
#include <string.h>

#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#define EXPORT EMSCRIPTEN_KEEPALIVE
#else
#define EXPORT
#endif

// Global runtime and context (one per WASM instance)
static JSRuntime *g_runtime = NULL;
static JSContext *g_context = NULL;

// Execution deadline (absolute, in emscripten_get_now() milliseconds).
// 0 means no limit. Armed by the host via qjs_set_deadline() before every
// entry into guest code; checked by the interrupt handler the engine polls
// from its interpreter loop, so a guest `while(true){}` can be aborted.
static double g_deadline_ms = 0;
// Set by the interrupt handler when it fires; consumed (reset) by the entry
// point that observes the resulting exception, so the host can tell a
// deadline interrupt apart from an ordinary guest error.
static int g_interrupted = 0;

// Fixed error payload for deadline interrupts. The exception QuickJS throws
// on interrupt is uncatchable and formatting it via JS_ToCString could
// itself be interrupted (the deadline is still expired), so the interrupt
// path returns this constant instead of stringifying the exception. The
// host-side provider matches on this exact message.
#define QJS_INTERRUPTED_ERROR_JSON \
    "{\"error\":\"interrupted: execution deadline exceeded\"}"

static double qjs_now_ms(void) {
#ifdef __EMSCRIPTEN__
    return emscripten_get_now();
#else
    return 0; // Non-Emscripten builds never arm a deadline.
#endif
}

// JSInterruptHandler: return non-zero to abort execution (QuickJS then
// throws an uncatchable InternalError). Keeps returning non-zero while the
// deadline stays expired, so nested/outer interpreter frames unwind too.
static int qjs_interrupt_handler(JSRuntime *rt, void *opaque) {
    (void)rt;
    (void)opaque;
    if (g_deadline_ms > 0 && qjs_now_ms() > g_deadline_ms) {
        g_interrupted = 1;
        return 1;
    }
    return 0;
}

// Callback function pointer type (set from JS)
typedef void (*HostCallbackFn)(const char *event, const char *data);
static HostCallbackFn g_host_callback = NULL;

// Binary host callback: hands the host a (ptr,len) window into wasm linear
// memory — the dedicated channel for ArrayBuffer payloads, which the JSON
// string bridge above cannot carry (JSON.stringify(ArrayBuffer) === "{}",
// silently destroying the bytes). Same technique as the native-guest
// rill_send_batch channel: no serialisation, the host reads HEAPU8 directly.
typedef void (*HostBinaryCallbackFn)(const char *event, const uint8_t *data,
                                     size_t len);
static HostBinaryCallbackFn g_host_binary_callback = NULL;

// ============================================
// Lifecycle
// ============================================

EXPORT int qjs_init(void) {
    if (g_runtime != NULL) {
        return 0; // Already initialized
    }

    g_runtime = JS_NewRuntime();
    if (!g_runtime) {
        return -1;
    }

    // Set memory limit (64MB)
    JS_SetMemoryLimit(g_runtime, 64 * 1024 * 1024);

    // Set max stack size (1MB)
    JS_SetMaxStackSize(g_runtime, 1024 * 1024);

    // Interrupt runaway guest code (e.g. `while(true){}`) once the
    // host-armed deadline expires.
    JS_SetInterruptHandler(g_runtime, qjs_interrupt_handler, NULL);

    g_context = JS_NewContext(g_runtime);
    if (!g_context) {
        JS_FreeRuntime(g_runtime);
        g_runtime = NULL;
        return -2;
    }

    return 0;
}

/**
 * Arm (or clear) the guest execution deadline.
 *
 * ms_from_now > 0: guest code entered after this call is interrupted once
 * `ms_from_now` milliseconds elapse. <= 0: clears the limit. The host sets
 * this before every entry into guest code and clears it after the outermost
 * entry returns.
 */
EXPORT void qjs_set_deadline(double ms_from_now) {
    if (ms_from_now > 0) {
        g_deadline_ms = qjs_now_ms() + ms_from_now;
    } else {
        g_deadline_ms = 0;
    }
    g_interrupted = 0;
}

EXPORT void qjs_destroy(void) {
    if (g_context) {
        JS_FreeContext(g_context);
        g_context = NULL;
    }
    if (g_runtime) {
        JS_FreeRuntime(g_runtime);
        g_runtime = NULL;
    }
    g_host_callback = NULL;
    g_deadline_ms = 0;
    g_interrupted = 0;
}

// ============================================
// Code Evaluation
// ============================================

/**
 * Evaluate JavaScript code and return result as JSON string
 * Caller must free the returned string
 */
EXPORT char *qjs_eval(const char *code) {
    if (!g_context) {
        return strdup("{\"error\":\"Context not initialized\"}");
    }

    JSValue result = JS_Eval(g_context, code, strlen(code), "<eval>",
                             JS_EVAL_TYPE_GLOBAL);

    // Deadline interrupt: checked via the flag, NOT the exception state —
    // promise machinery (reaction jobs, executors) catches exceptions at the
    // C level and would convert the interrupt into a mere rejection. Also
    // don't stringify anything: any JS re-entry could be interrupted again
    // while the deadline is still expired. Return the fixed marker instead.
    if (g_interrupted) {
        g_interrupted = 0;
        JS_FreeValue(g_context, result);
        JSValue exception = JS_GetException(g_context);
        JS_FreeValue(g_context, exception);
        return strdup(QJS_INTERRUPTED_ERROR_JSON);
    }

    if (JS_IsException(result)) {
        JSValue exception = JS_GetException(g_context);
        const char *msg = JS_ToCString(g_context, exception);
        char *error_json = malloc(strlen(msg) + 32);
        sprintf(error_json, "{\"error\":\"%s\"}", msg ? msg : "unknown");
        if (msg) JS_FreeCString(g_context, msg);
        JS_FreeValue(g_context, exception);
        return error_json;
    }

    // Convert result to JSON
    JSValue json_str = JS_JSONStringify(g_context, result, JS_UNDEFINED, JS_UNDEFINED);
    JS_FreeValue(g_context, result);

    if (JS_IsException(json_str)) {
        JS_FreeValue(g_context, json_str);
        // Clear the pending exception so it can't poison the next entry;
        // stringification itself may have hit the deadline (toJSON/getter).
        JSValue exception = JS_GetException(g_context);
        JS_FreeValue(g_context, exception);
        if (g_interrupted) {
            g_interrupted = 0;
            return strdup(QJS_INTERRUPTED_ERROR_JSON);
        }
        return strdup("{\"value\":\"[unstringifiable]\"}");
    }

    const char *str = JS_ToCString(g_context, json_str);
    char *output = str ? strdup(str) : strdup("null");
    if (str) JS_FreeCString(g_context, str);
    JS_FreeValue(g_context, json_str);

    return output;
}

/**
 * Evaluate code without returning result (for module/setup code)
 * Returns 0 on success, -1 on error, -2 on deadline interrupt
 */
EXPORT int qjs_eval_void(const char *code) {
    if (!g_context) {
        return -1;
    }

    JSValue result = JS_Eval(g_context, code, strlen(code), "<eval>",
                             JS_EVAL_TYPE_GLOBAL);

    // Flag check first: promise machinery can swallow the interrupt
    // exception C-side, leaving a non-exception result (see qjs_eval).
    if (g_interrupted) {
        g_interrupted = 0;
        JS_FreeValue(g_context, result);
        JSValue exception = JS_GetException(g_context);
        JS_FreeValue(g_context, exception);
        return -2;
    }

    if (JS_IsException(result)) {
        JSValue exception = JS_GetException(g_context);
        JS_FreeValue(g_context, exception);
        JS_FreeValue(g_context, result);
        return -1;
    }

    JS_FreeValue(g_context, result);
    return 0;
}

// ============================================
// Global Variables
// ============================================

/**
 * Set a global variable from JSON string
 */
EXPORT int qjs_inject_json(const char *name, const char *json_value) {
    if (!g_context) return -1;

    JSValue global = JS_GetGlobalObject(g_context);
    JSValue value = JS_ParseJSON(g_context, json_value, strlen(json_value), "<json>");

    if (JS_IsException(value)) {
        JS_FreeValue(g_context, global);
        return -1;
    }

    JS_SetPropertyStr(g_context, global, name, value);
    JS_FreeValue(g_context, global);
    return 0;
}

/**
 * Get a global variable as JSON string
 * Caller must free the returned string
 */
EXPORT char *qjs_extract_json(const char *name) {
    if (!g_context) return strdup("null");

    JSValue global = JS_GetGlobalObject(g_context);
    JSValue value = JS_GetPropertyStr(g_context, global, name);
    JS_FreeValue(g_context, global);

    JSValue json_str = JS_JSONStringify(g_context, value, JS_UNDEFINED, JS_UNDEFINED);
    JS_FreeValue(g_context, value);

    if (JS_IsException(json_str)) {
        JS_FreeValue(g_context, json_str);
        return strdup("null");
    }

    const char *str = JS_ToCString(g_context, json_str);
    char *output = str ? strdup(str) : strdup("null");
    if (str) JS_FreeCString(g_context, str);
    JS_FreeValue(g_context, json_str);

    return output;
}

// ============================================
// Host Callback (for __sendToHost, etc.)
// ============================================

/**
 * Set the host callback function pointer
 */
EXPORT void qjs_set_host_callback(HostCallbackFn callback) {
    g_host_callback = callback;
}

/**
 * Native function that can be called from JS to send data to host
 */
static JSValue js_send_to_host(JSContext *ctx, JSValueConst this_val,
                                int argc, JSValueConst *argv) {
    if (!g_host_callback || argc < 2) {
        return JS_UNDEFINED;
    }

    const char *event = JS_ToCString(ctx, argv[0]);
    JSValue json_data = JS_JSONStringify(ctx, argv[1], JS_UNDEFINED, JS_UNDEFINED);
    const char *data = JS_ToCString(ctx, json_data);

    if (event && data) {
        g_host_callback(event, data);
    }

    if (event) JS_FreeCString(ctx, event);
    if (data) JS_FreeCString(ctx, data);
    JS_FreeValue(ctx, json_data);

    return JS_UNDEFINED;
}

/**
 * Set the binary host callback function pointer
 */
EXPORT void qjs_set_host_binary_callback(HostBinaryCallbackFn callback) {
    g_host_binary_callback = callback;
}

/**
 * Native function callable from JS to send BINARY data to the host:
 * __sendBinaryToHost(event, arrayBufferOrView). The bytes are handed over as
 * a (ptr,len) window into linear memory — copied host-side before this call
 * returns. Non-binary payloads are ignored (the JSON channel is for those).
 */
static JSValue js_send_binary_to_host(JSContext *ctx, JSValueConst this_val,
                                      int argc, JSValueConst *argv) {
    if (!g_host_binary_callback || argc < 2) {
        return JS_UNDEFINED;
    }

    const char *event = JS_ToCString(ctx, argv[0]);
    if (!event) {
        return JS_UNDEFINED;
    }

    size_t size = 0;
    uint8_t *data = JS_GetArrayBuffer(ctx, &size, argv[1]);
    if (data || JS_IsArrayBuffer(ctx, argv[1])) {
        // Plain ArrayBuffer (data may be NULL for a zero-length buffer).
        g_host_binary_callback(event, data, size);
    } else {
        // Not an ArrayBuffer: JS_GetArrayBuffer set an exception — clear it,
        // then probe for a typed-array view and send its byte window.
        JS_FreeValue(ctx, JS_GetException(ctx));
        size_t offset = 0, length = 0, bpe = 0;
        JSValue backing =
            JS_GetTypedArrayBuffer(ctx, argv[1], &offset, &length, &bpe);
        if (!JS_IsException(backing)) {
            size_t backing_size = 0;
            uint8_t *backing_data =
                JS_GetArrayBuffer(ctx, &backing_size, backing);
            if (backing_data && offset + length <= backing_size) {
                g_host_binary_callback(event, backing_data + offset, length);
            }
            JS_FreeValue(ctx, backing);
        } else {
            // Not a view either — drop silently; callers gate on typeof.
            JS_FreeValue(ctx, JS_GetException(ctx));
        }
    }

    JS_FreeCString(ctx, event);
    return JS_UNDEFINED;
}

/**
 * Install __sendToHost / __sendBinaryToHost functions in global scope
 */
EXPORT void qjs_install_host_functions(void) {
    if (!g_context) return;

    JSValue global = JS_GetGlobalObject(g_context);

    // __sendToHost(event, data)
    JS_SetPropertyStr(g_context, global, "__sendToHost",
                      JS_NewCFunction(g_context, js_send_to_host, "__sendToHost", 2));

    // __sendBinaryToHost(event, arrayBufferOrView)
    JS_SetPropertyStr(g_context, global, "__sendBinaryToHost",
                      JS_NewCFunction(g_context, js_send_binary_to_host,
                                      "__sendBinaryToHost", 2));

    JS_FreeValue(g_context, global);
}

// ============================================
// Timer Support
// ============================================

static int g_timer_id = 0;

// Timer callback function pointer type
typedef void (*TimerCallbackFn)(int timer_id);
static TimerCallbackFn g_timer_callback = NULL;

EXPORT void qjs_set_timer_callback(TimerCallbackFn callback) {
    g_timer_callback = callback;
}

/**
 * Called from JS: setTimeout(callback, delay) -> timerId
 * Returns timer ID, host manages actual timing
 */
static JSValue js_set_timeout(JSContext *ctx, JSValueConst this_val,
                              int argc, JSValueConst *argv) {
    if (argc < 2) return JS_NewInt32(ctx, -1);

    // Get delay
    int32_t delay = 0;
    JS_ToInt32(ctx, &delay, argv[1]);

    // Generate timer ID
    int timer_id = ++g_timer_id;

    // Store callback in global __timers object
    JSValue global = JS_GetGlobalObject(ctx);
    JSValue timers = JS_GetPropertyStr(ctx, global, "__timers");
    if (JS_IsUndefined(timers)) {
        timers = JS_NewObject(ctx);
        JS_SetPropertyStr(ctx, global, "__timers", JS_DupValue(ctx, timers));
    }

    char id_str[16];
    snprintf(id_str, sizeof(id_str), "%d", timer_id);
    JS_SetPropertyStr(ctx, timers, id_str, JS_DupValue(ctx, argv[0]));

    JS_FreeValue(ctx, timers);
    JS_FreeValue(ctx, global);

    // Notify host to schedule timer
    if (g_timer_callback) {
        // Encode: (timer_id << 16) | delay (max delay 65535ms)
        g_timer_callback((timer_id << 16) | (delay & 0xFFFF));
    }

    return JS_NewInt32(ctx, timer_id);
}

/**
 * clearTimeout(timerId)
 */
static JSValue js_clear_timeout(JSContext *ctx, JSValueConst this_val,
                                int argc, JSValueConst *argv) {
    if (argc < 1) return JS_UNDEFINED;

    int32_t timer_id;
    JS_ToInt32(ctx, &timer_id, argv[0]);

    // Remove callback from __timers
    JSValue global = JS_GetGlobalObject(ctx);
    JSValue timers = JS_GetPropertyStr(ctx, global, "__timers");
    if (!JS_IsUndefined(timers)) {
        char id_str[16];
        snprintf(id_str, sizeof(id_str), "%d", timer_id);
        JS_DeleteProperty(ctx, timers, JS_NewAtom(ctx, id_str), 0);
    }
    JS_FreeValue(ctx, timers);
    JS_FreeValue(ctx, global);

    return JS_UNDEFINED;
}

/**
 * Fire a timer callback (called from host when timer expires)
 */
EXPORT void qjs_fire_timer(int timer_id) {
    if (!g_context) return;

    JSValue global = JS_GetGlobalObject(g_context);
    JSValue timers = JS_GetPropertyStr(g_context, global, "__timers");

    if (!JS_IsUndefined(timers)) {
        char id_str[16];
        snprintf(id_str, sizeof(id_str), "%d", timer_id);
        JSValue callback = JS_GetPropertyStr(g_context, timers, id_str);

        if (JS_IsFunction(g_context, callback)) {
            JSValue result = JS_Call(g_context, callback, JS_UNDEFINED, 0, NULL);
            if (JS_IsException(result)) {
                // Clear the pending exception (deadline interrupt included)
                // so subsequent evaluations start clean.
                JSValue exception = JS_GetException(g_context);
                JS_FreeValue(g_context, exception);
                g_interrupted = 0;
            }
            JS_FreeValue(g_context, result);

            // Remove timer after firing (setTimeout is one-shot)
            JS_DeleteProperty(g_context, timers, JS_NewAtom(g_context, id_str), 0);
        }
        JS_FreeValue(g_context, callback);
    }

    JS_FreeValue(g_context, timers);
    JS_FreeValue(g_context, global);
}

/**
 * Install timer functions in global scope
 */
EXPORT void qjs_install_timer_functions(void) {
    if (!g_context) return;

    JSValue global = JS_GetGlobalObject(g_context);

    // Create __timers storage
    JS_SetPropertyStr(g_context, global, "__timers", JS_NewObject(g_context));

    // setTimeout and clearTimeout
    JS_SetPropertyStr(g_context, global, "setTimeout",
                      JS_NewCFunction(g_context, js_set_timeout, "setTimeout", 2));
    JS_SetPropertyStr(g_context, global, "clearTimeout",
                      JS_NewCFunction(g_context, js_clear_timeout, "clearTimeout", 1));

    JS_FreeValue(g_context, global);
}

// ============================================
// Console Support
// ============================================

static JSValue js_console_log(JSContext *ctx, JSValueConst this_val,
                              int argc, JSValueConst *argv) {
    for (int i = 0; i < argc; i++) {
        const char *str = JS_ToCString(ctx, argv[i]);
        if (str) {
            if (g_host_callback) {
                g_host_callback("console.log", str);
            }
            JS_FreeCString(ctx, str);
        }
    }
    return JS_UNDEFINED;
}

static JSValue js_console_error(JSContext *ctx, JSValueConst this_val,
                                int argc, JSValueConst *argv) {
    for (int i = 0; i < argc; i++) {
        const char *str = JS_ToCString(ctx, argv[i]);
        if (str) {
            if (g_host_callback) {
                g_host_callback("console.error", str);
            }
            JS_FreeCString(ctx, str);
        }
    }
    return JS_UNDEFINED;
}

EXPORT void qjs_install_console(void) {
    if (!g_context) return;

    JSValue global = JS_GetGlobalObject(g_context);
    JSValue console = JS_NewObject(g_context);

    JS_SetPropertyStr(g_context, console, "log",
                      JS_NewCFunction(g_context, js_console_log, "log", 1));
    JS_SetPropertyStr(g_context, console, "error",
                      JS_NewCFunction(g_context, js_console_error, "error", 1));
    JS_SetPropertyStr(g_context, console, "warn",
                      JS_NewCFunction(g_context, js_console_log, "warn", 1));
    JS_SetPropertyStr(g_context, console, "info",
                      JS_NewCFunction(g_context, js_console_log, "info", 1));

    JS_SetPropertyStr(g_context, global, "console", console);
    JS_FreeValue(g_context, global);
}

// ============================================
// Pending Jobs (Promises)
// ============================================

/**
 * Execute pending jobs (microtasks/promises)
 * Returns number of jobs executed, -2 on deadline interrupt
 */
EXPORT int qjs_execute_pending_jobs(void) {
    if (!g_context) return -1;

    int count = 0;
    int ret;
    JSContext *ctx;

    while ((ret = JS_ExecutePendingJob(g_runtime, &ctx)) > 0) {
        count++;
        if (count > 10000) {
            // Safety limit to prevent infinite loops
            break;
        }
    }

    if (ret < 0) {
        // A job threw: JS_ExecutePendingJob leaves the exception pending in
        // its context — clear it so it can't poison the next evaluation.
        JSValue exception = JS_GetException(ctx ? ctx : g_context);
        JS_FreeValue(g_context, exception);
    }

    // Flag check independent of ret: a deadline interrupt inside a promise
    // reaction job is caught C-side and reported as job success (the
    // exception becomes a rejection), so only the flag is reliable.
    if (g_interrupted) {
        g_interrupted = 0;
        return -2;
    }

    return count;
}

// ============================================
// Memory
// ============================================

/**
 * Free a string allocated by qjs_eval, qjs_extract_json, etc.
 */
EXPORT void qjs_free_string(char *str) {
    if (str) free(str);
}

/**
 * Get current memory usage
 */
EXPORT size_t qjs_get_memory_usage(void) {
    if (!g_runtime) return 0;

    JSMemoryUsage usage;
    JS_ComputeMemoryUsage(g_runtime, &usage);
    return usage.memory_used_size;
}
