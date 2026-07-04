;; Minimal native (non-JS) rill guest — proves the linear-memory host:* ABI.
;; On rill_init it makes ONE host call (test:kv.put); the host writes the result
;; back into this module's memory (via rill_alloc) and calls rill_resolve, which
;; stashes ok/ptr/len into globals the test reads. Hand-written so the ABI is
;; visible at the wire level; see docs/native-guest.zh.md.
(module
  ;; host -> guest import: rill_host_call(mod_ptr,mod_len, method_ptr,method_len, in_ptr,in_len, cb_id)
  (import "env" "rill_host_call"
    (func $host_call (param i32 i32 i32 i32 i32 i32 i32)))

  (memory (export "memory") 1)

  ;; static request bytes
  (data (i32.const 0)  "host:kv")                     ;; module @0  len 7
  (data (i32.const 16) "put")                         ;; method @16 len 3
  (data (i32.const 32) "{\"k\":\"a\",\"v\":\"b\"}")   ;; input  @32 len 17

  (global $bump (mut i32) (i32.const 1024))           ;; bump allocator (above the request region)
  (global $r_ok  (mut i32) (i32.const -1))
  (global $r_ptr (mut i32) (i32.const 0))
  (global $r_len (mut i32) (i32.const 0))

  ;; host asks the guest to allocate a buffer to write a result into
  (func (export "rill_alloc") (param $size i32) (result i32)
    (local $p i32)
    (local.set $p (global.get $bump))
    (global.set $bump (i32.add (global.get $bump) (local.get $size)))
    (local.get $p))

  ;; host resolves a pending call: stash ok/ptr/len for the test to inspect
  (func (export "rill_resolve") (param $cb i32) (param $ok i32) (param $ptr i32) (param $len i32)
    (global.set $r_ok  (local.get $ok))
    (global.set $r_ptr (local.get $ptr))
    (global.set $r_len (local.get $len)))

  ;; entry: make one host:* call
  (func (export "rill_init")
    (call $host_call
      (i32.const 0)  (i32.const 7)
      (i32.const 16) (i32.const 3)
      (i32.const 32) (i32.const 17)
      (i32.const 1)))

  (func (export "resolve_ok")  (result i32) (global.get $r_ok))
  (func (export "resolve_ptr") (result i32) (global.get $r_ptr))
  (func (export "resolve_len") (result i32) (global.get $r_len))
)
