/* Minimal pthread shim for QuickJS CONFIG_ATOMICS on MSVC.
 * Only provides the subset used by quickjs.c Atomics.wait/notify. */
#ifndef _PTHREAD_MSVC_SHIM_H
#define _PTHREAD_MSVC_SHIM_H

#ifdef _MSC_VER

#include <windows.h>
#include <time.h>

typedef CRITICAL_SECTION pthread_mutex_t;
typedef CONDITION_VARIABLE pthread_cond_t;
typedef void *pthread_mutexattr_t;
typedef void *pthread_condattr_t;

#define PTHREAD_MUTEX_INITIALIZER {0}

static __forceinline int pthread_mutex_init(pthread_mutex_t *m, const pthread_mutexattr_t *a) {
    (void)a;
    InitializeCriticalSection(m);
    return 0;
}
static __forceinline int pthread_mutex_destroy(pthread_mutex_t *m) {
    DeleteCriticalSection(m);
    return 0;
}
static __forceinline int pthread_mutex_lock(pthread_mutex_t *m) {
    EnterCriticalSection(m);
    return 0;
}
static __forceinline int pthread_mutex_unlock(pthread_mutex_t *m) {
    LeaveCriticalSection(m);
    return 0;
}

static __forceinline int pthread_cond_init(pthread_cond_t *c, const pthread_condattr_t *a) {
    (void)a;
    InitializeConditionVariable(c);
    return 0;
}
static __forceinline int pthread_cond_destroy(pthread_cond_t *c) {
    (void)c; /* Windows CV doesn't need explicit destroy */
    return 0;
}
static __forceinline int pthread_cond_wait(pthread_cond_t *c, pthread_mutex_t *m) {
    SleepConditionVariableCS(c, m, INFINITE);
    return 0;
}
static __forceinline int pthread_cond_signal(pthread_cond_t *c) {
    WakeConditionVariable(c);
    return 0;
}
static __forceinline int pthread_cond_broadcast(pthread_cond_t *c) {
    WakeAllConditionVariable(c);
    return 0;
}

/* pthread_cond_timedwait: QuickJS uses this with struct timespec.
 * Convert absolute timespec to relative milliseconds for Windows. */
static __forceinline int pthread_cond_timedwait(pthread_cond_t *c, pthread_mutex_t *m,
                                                 const struct timespec *abstime) {
    struct timespec now;
    timespec_get(&now, TIME_UTC);
    long long ms = (abstime->tv_sec - now.tv_sec) * 1000LL
                 + (abstime->tv_nsec - now.tv_nsec) / 1000000LL;
    if (ms < 0) ms = 0;
    if (!SleepConditionVariableCS(c, m, (DWORD)ms)) {
        return 110; /* ETIMEDOUT */
    }
    return 0;
}

#endif /* _MSC_VER */
#endif /* _PTHREAD_MSVC_SHIM_H */
