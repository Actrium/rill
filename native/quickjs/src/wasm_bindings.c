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
// Binary staging table (first-class ArrayBuffer marshalling)
// ============================================
//
// The JSON string bridge cannot carry bytes (JSON.stringify(ArrayBuffer) is
// "{}"), so a buffer crossing the bridge is parked here and referenced from
// the JSON payload as {"$bin":id}. Ids are monotonic, starting at 1 (0 means
// staging failed), and every staged block is consumed EXACTLY ONCE by the
// receiving side:
//   guest -> host: the guest calls __rill_stageBinary(bufferOrView) -> id;
//     the host reads qjs_binary_ptr/qjs_binary_len, copies the window out of
//     linear memory, and MUST call qjs_binary_free(id).
//   host -> guest: the host copies bytes into linear memory (_malloc) and
//     calls qjs_binary_stage(ptr,len) (the table takes ownership of ptr);
//     the guest calls __rill_takeBinary(id), which adopts the block into a
//     JS ArrayBuffer (no extra copy) and removes the entry.
// qjs_destroy() clears leftovers so an aborted payload cannot outlive the
// context; qjs_binary_count() exists for zero-leak assertions in tests.

typedef struct BinaryEntry {
    uint32_t id;
    uint8_t *data; // malloc'd; owned by the table until consumed
    size_t len;
    struct BinaryEntry *next;
} BinaryEntry;

static BinaryEntry *g_binary_head = NULL;
static uint32_t g_binary_next_id = 0;
static size_t g_binary_bytes = 0;

// Insert an already-malloc'd block; the table takes ownership. Returns the
// new id, or 0 on OOM (the block is freed, the caller never owns it again).
static uint32_t binary_table_insert(uint8_t *data, size_t len) {
    BinaryEntry *e = malloc(sizeof(BinaryEntry));
    if (!e) {
        free(data);
        return 0;
    }
    e->id = ++g_binary_next_id;
    e->data = data;
    e->len = len;
    e->next = g_binary_head;
    g_binary_head = e;
    g_binary_bytes += len;
    return e->id;
}

// Unlink an entry and hand it to the caller (who now owns entry->data), or
// NULL when the id is unknown / already consumed.
static BinaryEntry *binary_table_detach(uint32_t id) {
    BinaryEntry **p = &g_binary_head;
    while (*p) {
        if ((*p)->id == id) {
            BinaryEntry *e = *p;
            *p = e->next;
            g_binary_bytes -= e->len;
            return e;
        }
        p = &(*p)->next;
    }
    return NULL;
}

static void binary_table_clear(void) {
    while (g_binary_head) {
        BinaryEntry *e = g_binary_head;
        g_binary_head = e->next;
        free(e->data);
        free(e);
    }
    g_binary_bytes = 0;
}

/**
 * Host -> guest staging: `data` was malloc'd by the host via _malloc and
 * ownership moves to the table. Returns the id for the {"$bin":id} sentinel,
 * 0 on OOM.
 */
EXPORT uint32_t qjs_binary_stage(uint8_t *data, size_t len) {
    return binary_table_insert(data, len);
}

/**
 * Peek a staged block (guest -> host direction). Returns NULL for an
 * unknown / consumed id or a zero-length block; pair with qjs_binary_len.
 */
EXPORT uint8_t *qjs_binary_ptr(uint32_t id) {
    for (BinaryEntry *e = g_binary_head; e; e = e->next) {
        if (e->id == id) return e->data;
    }
    return NULL;
}

EXPORT size_t qjs_binary_len(uint32_t id) {
    for (BinaryEntry *e = g_binary_head; e; e = e->next) {
        if (e->id == id) return e->len;
    }
    return 0;
}

/**
 * Consume a staged block without reading it. No-op for an unknown or
 * already-consumed id, so a sender may blanket-free every id of a payload
 * on its failure path (consume-exactly-once stays intact).
 */
EXPORT void qjs_binary_free(uint32_t id) {
    BinaryEntry *e = binary_table_detach(id);
    if (e) {
        free(e->data);
        free(e);
    }
}

/**
 * Number of staged blocks still awaiting consumption. Steady-state MUST be
 * 0 between bridge crossings; tests assert this to prove zero leakage.
 */
EXPORT int qjs_binary_count(void) {
    int n = 0;
    for (BinaryEntry *e = g_binary_head; e; e = e->next) n++;
    return n;
}

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
    g_host_binary_callback = NULL;
    // Backstop for the consume-exactly-once discipline: any block a failed
    // payload left behind is released with the context.
    binary_table_clear();
    g_deadline_ms = 0;
    g_interrupted = 0;
}

// ============================================
// Guest error encoding
// ============================================

// JSON-escape `s` into a freshly malloc'd string body (no surrounding
// quotes): `"` and `\` get a backslash, control chars < 0x20 become \u00XX.
// Returns NULL on OOM.
static char *json_escape_dup(const char *s) {
    static const char hex[] = "0123456789abcdef";
    size_t n = 0;
    const unsigned char *p;
    for (p = (const unsigned char *)s; *p; p++) {
        unsigned char c = *p;
        if (c == '"' || c == '\\') n += 2;
        else if (c < 0x20) n += 6;
        else n += 1;
    }
    char *out = malloc(n + 1);
    if (!out) return NULL;
    char *q = out;
    for (p = (const unsigned char *)s; *p; p++) {
        unsigned char c = *p;
        if (c == '"' || c == '\\') {
            *q++ = '\\';
            *q++ = (char)c;
        } else if (c < 0x20) {
            *q++ = '\\';
            *q++ = 'u';
            *q++ = '0';
            *q++ = '0';
            *q++ = hex[(c >> 4) & 0xF];
            *q++ = hex[c & 0xF];
        } else {
            *q++ = (char)c;
        }
    }
    *q = '\0';
    return out;
}

// Best-effort rich encoder for a guest exception. Returns a freshly malloc'd,
// wire-valid JSON string; caller owns it. Tries globalThis.__rill.__errenc
// (installed by the provider prelude); on ANY failure drains the pending
// exception and falls back to a C-escaped
// {"error":"<msg>","errorDetail":{"name":"Error"}}.
//
// Marker-forgery defense: the host provider classifies a deadline interrupt
// by exact string match on QJS_INTERRUPTED_ERROR_JSON, so no output of this
// function may ever be byte-identical to it. globalThis.__rill is a plain
// writable global — a guest can replace it wholesale and install its own
// __errenc — so the invariant is ENFORCED HERE, not merely by construction:
// an __errenc return equal to the bare marker is discarded and the fallback
// (whose errorDetail sibling is mandatory) is used instead. MUST NOT be
// called while g_interrupted is set: any JS re-entry here could be
// re-interrupted.
//
// Exception discipline: every JS re-entry in here (JS_Call, the fallback
// JS_ToCString which may invoke a hostile toString) can leave a pending
// exception. This function guarantees no pending exception remains on return.
static char *encode_guest_error(JSContext *ctx, JSValueConst exception) {
    char *out = NULL;
    JSValue global = JS_GetGlobalObject(ctx);
    JSValue rill = JS_GetPropertyStr(ctx, global, "__rill");
    JSValue enc =
        (JS_IsException(rill) || JS_IsUndefined(rill) || JS_IsNull(rill))
            ? JS_UNDEFINED
            : JS_GetPropertyStr(ctx, rill, "__errenc");

    if (JS_IsFunction(ctx, enc)) {
        JSValue arg = JS_DupValue(ctx, exception);
        JSValue r = JS_Call(ctx, enc, JS_UNDEFINED, 1, &arg);
        JS_FreeValue(ctx, arg);
        if (!JS_IsException(r) && JS_IsString(r)) {
            const char *s = JS_ToCString(ctx, r);
            if (s) {
                // Reject a forged bare interrupt marker (see header comment);
                // out stays NULL and the fallback below re-encodes the real
                // exception with the mandatory errorDetail sibling.
                if (strcmp(s, QJS_INTERRUPTED_ERROR_JSON) != 0) {
                    out = strdup(s);
                }
                JS_FreeCString(ctx, s);
            }
            // If JS_ToCString on a plain string somehow failed, it left a
            // pending exception; the fallback region below drains it.
        } else if (JS_IsException(r)) {
            // Drain so the encoder failure cannot poison the next entry.
            JSValue pend = JS_GetException(ctx);
            JS_FreeValue(ctx, pend);
        }
        JS_FreeValue(ctx, r);
    }
    JS_FreeValue(ctx, enc);
    JS_FreeValue(ctx, rill);
    JS_FreeValue(ctx, global);

    if (!out) {
        // Fallback: message-only, C-escaped, WITH the mandatory errorDetail
        // sibling. Never lose the original message; never emit a bare
        // {"error":...} that could collide with the interrupt marker.
        static const char pre[] = "{\"error\":\"";
        static const char post[] = "\",\"errorDetail\":{\"name\":\"Error\"}}";
        const char *msg = JS_ToCString(ctx, exception); // may run guest toString
        char *esc = json_escape_dup(msg ? msg : "unknown");
        if (msg) JS_FreeCString(ctx, msg);
        if (esc) {
            out = malloc(sizeof(pre) - 1 + strlen(esc) + sizeof(post) - 1 + 1);
            if (out) {
                strcpy(out, pre);
                strcat(out, esc);
                strcat(out, post);
            }
            free(esc);
        }
        if (!out) {
            out = strdup(
                "{\"error\":\"unknown\",\"errorDetail\":{\"name\":\"Error\"}}");
        }
        // Unconditional drain: a hostile toString on the thrown value makes
        // JS_ToCString return NULL and leave a pending exception.
        // JS_GetException returns JS_NULL when none is pending, so this is
        // harmless in the common case and guarantees a clean context.
        JSValue pend = JS_GetException(ctx);
        JS_FreeValue(ctx, pend);
    }
    return out;
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
        char *error_json = encode_guest_error(g_context, exception);
        JS_FreeValue(g_context, exception);
        // If the encoder itself tripped the deadline (a hostile getter looped
        // until the interrupt handler fired), discard the rich payload and
        // return the fixed marker — preserves the host's exact-match contract
        // and clears the flag for the next entry.
        if (g_interrupted) {
            g_interrupted = 0;
            // encode_guest_error guarantees a clean context, but a re-armed
            // interrupt may have left a fresh pending exception AFTER that
            // drain; clear it so the next host entry starts clean (mirrors
            // the flag-first interrupt early-return above).
            JSValue pend = JS_GetException(g_context);
            JS_FreeValue(g_context, pend);
            free(error_json);
            return strdup(QJS_INTERRUPTED_ERROR_JSON);
        }
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

    // Marker-forgery defense, success path: JSON.stringify of the completion
    // value ({error:"interrupted: execution deadline exceeded"}) yields bytes
    // identical to the interrupt marker. g_interrupted is 0 here, so this is
    // a genuine guest value, not a deadline — append the mandatory
    // errorDetail sibling so the host classifies it like any other
    // {error:"<non-empty>"} completion value (which already surfaces as a
    // normal error host-side) instead of a spoofed timeout.
    if (output && strcmp(output, QJS_INTERRUPTED_ERROR_JSON) == 0) {
        free(output);
        output = strdup(
            "{\"error\":\"interrupted: execution deadline exceeded\","
            "\"errorDetail\":{\"name\":\"Error\"}}");
    }

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
 * __rill_stageBinary(arrayBufferOrView) -> id
 *
 * Guest -> host staging: copies the EXACT byte window of an ArrayBuffer or a
 * typed-array view (byteOffset/byteLength respected — never the whole backing
 * buffer) into the staging table and returns the id for a {"$bin":id}
 * sentinel. Throws a TypeError on non-binary input so a marshalling bug
 * surfaces in the guest instead of silently dropping bytes.
 */
static JSValue js_rill_stage_binary(JSContext *ctx, JSValueConst this_val,
                                    int argc, JSValueConst *argv) {
    if (argc < 1) {
        return JS_ThrowTypeError(ctx, "__rill_stageBinary: missing argument");
    }

    const uint8_t *src = NULL;
    size_t len = 0;
    JSValue backing = JS_UNDEFINED;

    size_t size = 0;
    uint8_t *data = JS_GetArrayBuffer(ctx, &size, argv[0]);
    if (data || JS_IsArrayBuffer(ctx, argv[0])) {
        // Plain ArrayBuffer (data may be NULL for a zero-length buffer).
        src = data;
        len = size;
    } else {
        // Not an ArrayBuffer: JS_GetArrayBuffer set an exception — clear it,
        // then probe for a typed-array view and take its byte window.
        JS_FreeValue(ctx, JS_GetException(ctx));
        size_t offset = 0, length = 0, bpe = 0;
        backing = JS_GetTypedArrayBuffer(ctx, argv[0], &offset, &length, &bpe);
        if (JS_IsException(backing)) {
            JS_FreeValue(ctx, JS_GetException(ctx));
            return JS_ThrowTypeError(
                ctx, "__rill_stageBinary: expected an ArrayBuffer or view");
        }
        size_t backing_size = 0;
        uint8_t *backing_data = JS_GetArrayBuffer(ctx, &backing_size, backing);
        if (!backing_data || offset + length > backing_size) {
            JS_FreeValue(ctx, JS_GetException(ctx));
            JS_FreeValue(ctx, backing);
            return JS_ThrowTypeError(ctx,
                                     "__rill_stageBinary: detached view");
        }
        src = backing_data + offset;
        len = length;
    }

    uint8_t *copy = NULL;
    if (len > 0) {
        copy = malloc(len);
        if (!copy) {
            JS_FreeValue(ctx, backing);
            return JS_ThrowOutOfMemory(ctx);
        }
        memcpy(copy, src, len);
    }
    JS_FreeValue(ctx, backing);

    uint32_t id = binary_table_insert(copy, len);
    if (id == 0) {
        return JS_ThrowOutOfMemory(ctx);
    }
    return JS_NewUint32(ctx, id);
}

// Free-func handed to JS_NewArrayBuffer for adopted staging blocks: every
// block was plain-malloc'd (host _malloc or js_rill_stage_binary), so plain
// free() matches.
static void binary_js_free(JSRuntime *rt, void *opaque, void *ptr) {
    (void)rt;
    (void)opaque;
    free(ptr);
}

/**
 * __rill_takeBinary(id) -> ArrayBuffer
 *
 * Host -> guest consumption: removes the staged block and adopts it into a
 * JS ArrayBuffer (zero-copy; the ArrayBuffer's free func releases the block).
 * Throws on an unknown or already-consumed id — each id is single-use by
 * design, and a double take indicates a marshalling bug.
 */
static JSValue js_rill_take_binary(JSContext *ctx, JSValueConst this_val,
                                   int argc, JSValueConst *argv) {
    uint32_t id = 0;
    if (argc < 1 || JS_ToUint32(ctx, &id, argv[0])) {
        return JS_ThrowTypeError(ctx, "__rill_takeBinary: bad id");
    }

    BinaryEntry *e = binary_table_detach(id);
    if (!e) {
        return JS_ThrowTypeError(
            ctx, "__rill_takeBinary: unknown or already-consumed id");
    }
    uint8_t *data = e->data;
    size_t len = e->len;
    free(e);

    if (len == 0 || !data) {
        // JS_NewArrayBuffer would adopt the NULL/empty block as-is; allocate
        // a real empty buffer instead so the guest sees a normal ArrayBuffer.
        free(data);
        return JS_NewArrayBufferCopy(ctx, NULL, 0);
    }

    JSValue ab = JS_NewArrayBuffer(ctx, data, len, binary_js_free, NULL, 0);
    if (JS_IsException(ab)) {
        // On failure QuickJS does NOT invoke the free func — release here.
        free(data);
    }
    return ab;
}

/**
 * Install __sendToHost / __sendBinaryToHost / binary staging helpers in
 * global scope
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

    // Binary staging helpers backing the {"$bin":id} JSON sentinel: the guest
    // codec (__rill.__binenc/__binrev, injected by the provider) is their only
    // intended caller.
    JS_SetPropertyStr(g_context, global, "__rill_stageBinary",
                      JS_NewCFunction(g_context, js_rill_stage_binary,
                                      "__rill_stageBinary", 1));
    JS_SetPropertyStr(g_context, global, "__rill_takeBinary",
                      JS_NewCFunction(g_context, js_rill_take_binary,
                                      "__rill_takeBinary", 1));

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
 *
 * Includes bytes parked in the binary staging table: they are runtime-owned
 * transit memory JS_ComputeMemoryUsage cannot see (plain malloc, not the JS
 * heap), and ignoring them would hide a marshalling leak from this metric.
 */
EXPORT size_t qjs_get_memory_usage(void) {
    if (!g_runtime) return 0;

    JSMemoryUsage usage;
    JS_ComputeMemoryUsage(g_runtime, &usage);
    return usage.memory_used_size + g_binary_bytes;
}
