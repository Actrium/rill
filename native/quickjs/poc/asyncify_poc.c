/*
 * asyncify_poc.c — Milestone A proof of concept.
 *
 * Goal: prove VM-level pause/resume for wasm-compiled QuickJS on a single JS
 * thread, driven by Emscripten Asyncify. A breakpoint fired from deep inside the
 * bytecode interpreter unwinds the entire C stack back to the JS caller (the
 * eval Promise stays pending), the JS thread keeps running other work, and a
 * JS-side resume rewinds the C stack and finishes the eval from the suspend
 * point.
 *
 * This file only consumes the existing, unchanged per-context debug seam from
 * quickjs-debug.h (rill_qjs_set_debug_hook / RillQjsDebugHook). It does not
 * touch quickjs.c, the debug core, or any production build.
 *
 * Licensed under the Apache License, Version 2.0.
 */
#include <stddef.h>
#include <stdint.h>
#include <string.h>

#include <emscripten.h>

#include "quickjs.h"
#include "quickjs-debug.h"

/* Result sentinel returned when eval throws or produces a non-integer. */
#define QJS_POC_ERR (-2147483647)

static JSRuntime *g_rt = NULL;
static JSContext *g_ctx = NULL;
static int g_breakpoint_line = -1;
/* One-shot arm flag: cleared on the first hit so the rewound eval runs to
   completion instead of re-suspending on the same line forever. */
static int g_armed = 0;

/*
 * The suspend primitive. With Asyncify, calling this from C unwinds the whole
 * native call stack: the wasm export returns a pending Promise to JS, control
 * goes back to the JS event loop, and the C stack is only rewound once the
 * stored resolver runs. onPaused() lets the harness observe the pause; the
 * resolver is parked on globalThis for the harness to call.
 */
#ifdef POC_NO_ASYNCIFY
/*
 * Negative control: without Asyncify the C stack cannot unwind here. We fire
 * onPaused for parity but return immediately, so eval runs straight through and
 * the "paused while the Promise is pending" property is impossible to observe.
 */
EM_JS(void, rill_qjs_dbg_suspend, (void), {
    globalThis.__rillDbg.onPaused();
})
#else
EM_ASYNC_JS(void, rill_qjs_dbg_suspend, (void), {
    await new Promise(function (res) {
        globalThis.__rillDbg.onPaused();
        globalThis.__rillDbg.resume = res;
    });
})
#endif

/*
 * Per-context debug hook. Fires before each interpreted instruction while
 * attached. depth == 1 is top-level; requiring depth >= 2 guarantees the pause
 * happens at least one interpreter frame deep (this PoC breaks 2 frames deep).
 */
static void poc_debug_hook(JSContext *ctx, const void *script_token, int line,
                           int depth, void *opaque)
{
    (void)ctx;
    (void)script_token;
    (void)opaque;
    if (g_armed && g_breakpoint_line >= 0 && line == g_breakpoint_line &&
        depth >= 2) {
        g_armed = 0;
        rill_qjs_dbg_suspend();
    }
}

int qjs_poc_init(void)
{
    g_rt = JS_NewRuntime();
    if (!g_rt)
        return -1;
    /* Anchor the stack-overflow check to the current (wasm) stack top. */
    JS_UpdateStackTop(g_rt);
    g_ctx = JS_NewContext(g_rt);
    if (!g_ctx) {
        JS_FreeRuntime(g_rt);
        g_rt = NULL;
        return -1;
    }
    rill_qjs_set_debug_hook(g_ctx, poc_debug_hook, NULL);
    return 0;
}

void qjs_poc_set_breakpoint(int line)
{
    g_breakpoint_line = line;
    g_armed = 1;
}

/*
 * Evaluate global code and return its result as an int. When a breakpoint is
 * armed this call suspends mid-eval (via Asyncify) and only returns after the
 * JS side resumes it, at which point the value reflects work done AFTER the
 * breakpoint line.
 */
int qjs_poc_eval(const char *code)
{
    JSValue val;
    int result = 0;

    if (!g_ctx)
        return QJS_POC_ERR;

    val = JS_Eval(g_ctx, code, strlen(code), "<poc>", JS_EVAL_TYPE_GLOBAL);
    if (JS_IsException(val)) {
        JS_FreeValue(g_ctx, val);
        return QJS_POC_ERR;
    }
    if (JS_ToInt32(g_ctx, &result, val) < 0) {
        JS_FreeValue(g_ctx, val);
        return QJS_POC_ERR;
    }
    JS_FreeValue(g_ctx, val);
    return result;
}
