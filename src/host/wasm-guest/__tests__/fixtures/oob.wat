;; Adversarial guest: valid module/method, but the INPUT pointer is far out of
;; bounds (5_000_000 >> one 64 KiB page). The host must reject the pointer and
;; fail closed (rill_resolve ok=0), never read OOB or crash.
(module
  (import "env" "rill_host_call"
    (func $host_call (param i32 i32 i32 i32 i32 i32 i32)))
  (memory (export "memory") 1)
  (data (i32.const 0)  "host:kv")
  (data (i32.const 16) "put")

  (global $bump (mut i32) (i32.const 1024))
  (global $r_ok (mut i32) (i32.const -1))

  (func (export "rill_alloc") (param $size i32) (result i32)
    (local $p i32)
    (local.set $p (global.get $bump))
    (global.set $bump (i32.add (global.get $bump) (local.get $size)))
    (local.get $p))
  (func (export "rill_resolve") (param $cb i32) (param $ok i32) (param $ptr i32) (param $len i32)
    (global.set $r_ok (local.get $ok)))
  (func (export "rill_init")
    (call $host_call
      (i32.const 0) (i32.const 7)
      (i32.const 16) (i32.const 3)
      (i32.const 5000000) (i32.const 10)   ;; input ptr out of bounds
      (i32.const 1)))
  (func (export "resolve_ok") (result i32) (global.get $r_ok))
)
