/*
 * rill_guest.h — C guest SDK for rill native (non-JS) WASM guests.
 *
 * Proves the linear-memory host:* ABI (docs/native-guest.zh.md) is genuinely
 * language-neutral: a guest compiled from C binds the SAME imports/exports the
 * Rust SDK (crates/rill-guest) uses, and the Phase A WasmGuestHost loads it
 * unchanged.
 *
 * This first cut covers the one-way RENDER path (sync, no host round-trip).
 * The async host:* call import (rill_host_call) is declared for reference
 * only — the callback-resolve executor around it, and the guest-side event
 * export (rill_on_event), are NOT provided here; a full async/event runtime
 * in C is a follow-up. See the Rust SDK (crates/rill-guest) for the reference
 * implementation of both.
 */
#ifndef RILL_GUEST_H
#define RILL_GUEST_H

typedef unsigned int rill_u32; /* wasm32: 32-bit */

/* ---- ABI imports (host provides, module "env") ---- */
__attribute__((import_module("env"), import_name("rill_send_batch"))) extern void
rill_send_batch(const char *batch_ptr, rill_u32 batch_len);

__attribute__((import_module("env"), import_name("rill_host_call"))) extern void
rill_host_call(const char *mod_ptr, rill_u32 mod_len, const char *method_ptr,
               rill_u32 method_len, const char *in_ptr, rill_u32 in_len,
               rill_u32 cb_id);

/* ---- helpers ---- */
static inline rill_u32 rill_strlen(const char *s) {
  rill_u32 n = 0;
  while (s[n]) {
    n++;
  }
  return n;
}

/* Send a render batch: a NUL-terminated UTF-8 JSON operation batch. */
static inline void rill_render(const char *batch_json) {
  rill_send_batch(batch_json, rill_strlen(batch_json));
}

#endif /* RILL_GUEST_H */
