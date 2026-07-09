/*
 * quickjs-debug.h — dev-only source-line debug seam for the rill sandbox.
 *
 * Bellard's QuickJS ships no debugger, so a source-level debugger needs a hook
 * inside the interpreter. This header is the whole public surface of that hook;
 * the implementation lives behind RILL_QJS_DEBUG in quickjs.c (a single check in
 * the SWITCH dispatch macro, compiled out entirely when the flag is off). All
 * pause/breakpoint policy stays out of the engine — in the registered callback.
 */
#ifndef RILL_QUICKJS_DEBUG_H
#define RILL_QUICKJS_DEBUG_H

#include <stddef.h>

#include "quickjs.h"

#ifdef __cplusplus
extern "C" {
#endif

/*
 * Called before each interpreted instruction while a debugger is attached.
 * `script_token` is a stable per-function opaque id (the JSFunctionBytecode);
 * resolve its source filename with rill_qjs_script_filename(). `line` is the
 * 1-based source line for the current program counter. `depth` is the length of
 * the live call-stack chain (1 = top-level), which the callback uses to
 * implement step over/into/out. The callback owns all pause policy and may block
 * the calling (runtime) thread to implement a pause.
 */
typedef void (*RillQjsDebugHook)(JSContext *ctx, const void *script_token,
                                 int line, int depth, void *opaque);

/* Attach (or, with hook == NULL, detach) the debug hook. */
void rill_qjs_set_debug_hook(JSRuntime *rt, RillQjsDebugHook hook, void *opaque);

/*
 * Resolve a script token's source filename. Allocates a C string owned by the
 * caller — free it with JS_FreeCString(ctx, ...). Returns NULL when the script
 * carries no debug info.
 */
const char *rill_qjs_script_filename(JSContext *ctx, const void *script_token);

/*
 * Frame sink for rill_qjs_capture_frames(). Called once per live stack frame,
 * top (innermost) first. `script_token` is the frame's JSFunctionBytecode, or
 * NULL for a native/stripped frame with no source location; `line` is the
 * 1-based source line (or -1 when unavailable). `func_name` is a borrowed C
 * string (may be NULL) valid only for the duration of the call — copy it if
 * needed; do not free it.
 */
typedef void (*RillQjsFrameSink)(void *user, const void *script_token, int line,
                                 const char *func_name);

/*
 * Walk the live call stack and emit each frame to `sink`. Must be called on the
 * runtime thread while the stack is intact (e.g. from inside the debug hook, at
 * a pause). Returns the number of frames emitted.
 */
int rill_qjs_capture_frames(JSContext *ctx, RillQjsFrameSink sink, void *user);

/*
 * Borrow a script token's raw source text. Returns a NUL-terminated pointer
 * owned by the engine (do NOT free); *out_len (if non-NULL) receives its byte
 * length. Returns NULL when the script carries no source (stripped).
 */
const char *rill_qjs_script_source(const void *script_token, size_t *out_len);

#ifdef __cplusplus
}
#endif

#endif /* RILL_QUICKJS_DEBUG_H */
