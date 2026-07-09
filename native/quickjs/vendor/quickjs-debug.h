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

#include "quickjs.h"

#ifdef __cplusplus
extern "C" {
#endif

/*
 * Called before each interpreted instruction while a debugger is attached.
 * `script_token` is a stable per-function opaque id (the JSFunctionBytecode);
 * resolve its source filename with rill_qjs_script_filename(). `line` is the
 * 1-based source line for the current program counter. The callback owns all
 * pause policy and may block the calling (runtime) thread to implement a pause.
 */
typedef void (*RillQjsDebugHook)(JSContext *ctx, const void *script_token,
                                 int line, void *opaque);

/* Attach (or, with hook == NULL, detach) the debug hook. */
void rill_qjs_set_debug_hook(JSRuntime *rt, RillQjsDebugHook hook, void *opaque);

/*
 * Resolve a script token's source filename. Allocates a C string owned by the
 * caller — free it with JS_FreeCString(ctx, ...). Returns NULL when the script
 * carries no debug info.
 */
const char *rill_qjs_script_filename(JSContext *ctx, const void *script_token);

#ifdef __cplusplus
}
#endif

#endif /* RILL_QUICKJS_DEBUG_H */
