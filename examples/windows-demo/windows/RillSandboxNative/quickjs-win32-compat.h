/*
 * QuickJS MSVC/Win32 compatibility header.
 * Force-included before all QuickJS C sources via /FI compiler flag.
 */
#ifndef QUICKJS_WIN32_COMPAT_H
#define QUICKJS_WIN32_COMPAT_H

#ifdef _MSC_VER

/* ── GCC builtins → MSVC intrinsics ────────────────────────────────────── */
#include <intrin.h>
#include <stdint.h>

#pragma intrinsic(_BitScanForward, _BitScanReverse)
#ifdef _WIN64
#pragma intrinsic(_BitScanForward64, _BitScanReverse64)
#endif

static __forceinline int __builtin_ctz(unsigned int x) {
    unsigned long r;
    _BitScanForward(&r, x);
    return (int)r;
}

static __forceinline int __builtin_ctzll(uint64_t x) {
    unsigned long r;
#ifdef _WIN64
    _BitScanForward64(&r, (unsigned __int64)x);
#else
    if ((uint32_t)x) { _BitScanForward(&r, (unsigned long)x); }
    else { _BitScanForward(&r, (unsigned long)(x >> 32)); r += 32; }
#endif
    return (int)r;
}

static __forceinline int __builtin_clz(unsigned int x) {
    unsigned long r;
    _BitScanReverse(&r, x);
    return 31 - (int)r;
}

static __forceinline int __builtin_clzll(uint64_t x) {
    unsigned long r;
#ifdef _WIN64
    _BitScanReverse64(&r, (unsigned __int64)x);
    return 63 - (int)r;
#else
    if ((uint32_t)(x >> 32)) {
        _BitScanReverse(&r, (unsigned long)(x >> 32));
        return 31 - (int)r;
    }
    _BitScanReverse(&r, (unsigned long)x);
    return 63 - (int)r;
#endif
}

/* ── GCC attributes → MSVC equivalents ─────────────────────────────────── */
#define __builtin_expect(x, y) (x)
#define __attribute__(x)
#define __attribute(x)

#undef force_inline
#define force_inline __forceinline

#undef no_inline
#define no_inline __declspec(noinline)

#undef __maybe_unused
#define __maybe_unused

/* ── DIRECT_DISPATCH requires computed gotos (GCC/Clang extension) ─────── */
#define DIRECT_DISPATCH 0

/* ── <sys/time.h> replacement ──────────────────────────────────────────── */
#include <winsock2.h>  /* struct timeval */
#include <windows.h>

static __forceinline int gettimeofday(struct timeval *tv, void *tz) {
    (void)tz;
    FILETIME ft;
    GetSystemTimeAsFileTime(&ft);
    /* FILETIME is 100-ns intervals since 1601-01-01.
     * Unix epoch starts 1970-01-01 = 11644473600 seconds later. */
    uint64_t t = ((uint64_t)ft.dwHighDateTime << 32) | ft.dwLowDateTime;
    t -= 116444736000000000ULL;
    tv->tv_sec  = (long)(t / 10000000ULL);
    tv->tv_usec = (long)((t % 10000000ULL) / 10);
    return 0;
}

/* ── malloc_usable_size ────────────────────────────────────────────────── */
#include <malloc.h>
#define malloc_usable_size(p) _msize(p)

/* ── ssize_t ───────────────────────────────────────────────────────────── */
#include <BaseTsd.h>
typedef SSIZE_T ssize_t;

/* ── popen / pclose (not used in sandbox but referenced) ───────────────── */
#define popen  _popen
#define pclose _pclose

/* ── abort() tracing for debugging crashes ─────────────────────────────── */
#include <stdio.h>
#include <signal.h>
#include <stdlib.h>

#ifdef __cplusplus
#include <exception>

static void rill_sigabrt_handler(int sig) {
    (void)sig;
    FILE *f = fopen("D:\\rill_abort_trace.txt", "a");
    if (f) {
        fprintf(f, "SIGABRT received\n");
        fclose(f);
    }
    _exit(98);
}

static void rill_terminate_handler() {
    FILE *f = fopen("D:\\rill_abort_trace.txt", "a");
    if (f) {
        fprintf(f, "std::terminate() called - uncaught C++ exception\n");
        try {
            auto ep = std::current_exception();
            if (ep) std::rethrow_exception(ep);
        } catch (const std::exception& e) {
            fprintf(f, "Exception: %s\n", e.what());
        } catch (...) {
            fprintf(f, "Unknown exception type\n");
        }
        fclose(f);
    }
    _exit(99);
}

/* Global initializer: register handlers in C++ TUs */
static struct RillAbortTraceInstaller {
    RillAbortTraceInstaller() {
        signal(SIGABRT, rill_sigabrt_handler);
        std::set_terminate(rill_terminate_handler);
    }
} rill_abort_trace_installer_;
#endif /* __cplusplus */

#endif /* _MSC_VER */
#endif /* QUICKJS_WIN32_COMPAT_H */
