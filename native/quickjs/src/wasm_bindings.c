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

// Callback function pointer type (set from JS)
typedef void (*HostCallbackFn)(const char *event, const char *data);
static HostCallbackFn g_host_callback = NULL;

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

    g_context = JS_NewContext(g_runtime);
    if (!g_context) {
        JS_FreeRuntime(g_runtime);
        g_runtime = NULL;
        return -2;
    }

    return 0;
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
 * Returns 0 on success, -1 on error
 */
EXPORT int qjs_eval_void(const char *code) {
    if (!g_context) {
        return -1;
    }

    JSValue result = JS_Eval(g_context, code, strlen(code), "<eval>",
                             JS_EVAL_TYPE_GLOBAL);

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
 * Install __sendToHost function in global scope
 */
EXPORT void qjs_install_host_functions(void) {
    if (!g_context) return;

    JSValue global = JS_GetGlobalObject(g_context);

    // __sendToHost(event, data)
    JS_SetPropertyStr(g_context, global, "__sendToHost",
                      JS_NewCFunction(g_context, js_send_to_host, "__sendToHost", 2));

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
 * Returns number of jobs executed, -1 on error
 */
EXPORT int qjs_execute_pending_jobs(void) {
    if (!g_context) return -1;

    int count = 0;
    JSContext *ctx;

    while (JS_ExecutePendingJob(g_runtime, &ctx) > 0) {
        count++;
        if (count > 10000) {
            // Safety limit to prevent infinite loops
            break;
        }
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
