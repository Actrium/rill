;; Adversarial probe: detects whether the host resolves a guest call
;; SYNCHRONOUSLY (re-entering rill_resolve inside rill_host_call). The host
;; must NEVER do that: rill_resolve re-enters the guest executor, and
;; re-polling a future mid-poll is UB guest-side (see wasm-guest-host.ts
;; onHostCall). rill_init snapshots the resolve counter right after
;; rill_host_call returns: 0 = correctly deferred, 1 = invariant broken.
;; Deliberately exports NO rill_abi_version — doubles as the
;; "pre-versioning guest is tolerated" fixture.
(module
  (import "env" "rill_host_call"
    (func $host_call (param i32 i32 i32 i32 i32 i32 i32)))
  (memory (export "memory") 1)
  (data (i32.const 0)  "host:store")            ;; module @0  len 10
  (data (i32.const 16) "getText")               ;; method @16 len 7
  (data (i32.const 32) "{\"key\":\"a\"}")      ;; input  @32 len 11
  (global $bump (mut i32) (i32.const 1024))
  (global $resolved (mut i32) (i32.const 0))
  (global $during (mut i32) (i32.const -1))
  (global $last_ok (mut i32) (i32.const -1))
  (func (export "rill_alloc") (param $size i32) (result i32)
    (local $p i32)
    (local.set $p (global.get $bump))
    (global.set $bump (i32.add (global.get $bump) (local.get $size)))
    (local.get $p))
  (func (export "rill_resolve") (param $cb i32) (param $ok i32) (param $ptr i32) (param $len i32)
    (global.set $resolved (i32.add (global.get $resolved) (i32.const 1)))
    (global.set $last_ok (local.get $ok)))
  (func (export "rill_init")
    (call $host_call
      (i32.const 0)  (i32.const 10)
      (i32.const 16) (i32.const 7)
      (i32.const 32) (i32.const 11)
      (i32.const 1))
    (global.set $during (global.get $resolved)))
  (func (export "resolved_count") (result i32) (global.get $resolved))
  (func (export "resolved_during_call") (result i32) (global.get $during))
  (func (export "last_ok") (result i32) (global.get $last_ok))
)
