;; Adversarial guest whose rill_alloc ALWAYS returns 0 (NULL) — the SDK bump
;; allocator's exhaustion signal. Address 0 is inside linear memory, so a host
;; that treats 0 as a normal pointer would write its JSON result / event payload
;; over the guest's low memory (here: the request bytes at address 0). The host
;; must treat ptr 0 + len > 0 as allocation failure and fail closed instead:
;;  - a host-call resolution is abandoned (rill_resolve never runs, $r_ok stays -1),
;;  - an emitEvent is dropped (rill_on_event never runs, $events stays 0),
;;  - the bytes at address 0 stay intact.
(module
  (import "env" "rill_host_call"
    (func $host_call (param i32 i32 i32 i32 i32 i32 i32)))

  (memory (export "memory") 1)

  ;; static request bytes — the canary the host must NOT overwrite
  (data (i32.const 0)  "host:store")                       ;; module @0  len 10
  (data (i32.const 16) "putText")                          ;; method @16 len 7
  (data (i32.const 32) "{\"key\":\"a\",\"text\":\"b\"}")  ;; input  @32 len 22

  (global $r_ok   (mut i32) (i32.const -1))
  (global $events (mut i32) (i32.const 0))

  ;; exhausted allocator: every allocation fails
  (func (export "rill_alloc") (param $size i32) (result i32)
    (i32.const 0))

  ;; must never run: the host abandons the cb when rill_alloc fails
  (func (export "rill_resolve") (param $cb i32) (param $ok i32) (param $ptr i32) (param $len i32)
    (global.set $r_ok (local.get $ok)))

  ;; must never run: the host drops the event when rill_alloc fails
  (func (export "rill_on_event") (param $np i32) (param $nl i32) (param $pp i32) (param $pl i32)
    (global.set $events (i32.add (global.get $events) (i32.const 1))))

  ;; entry: make one host:* call so the resolve path exercises rill_alloc
  (func (export "rill_init")
    (call $host_call
      (i32.const 0)  (i32.const 10)
      (i32.const 16) (i32.const 7)
      (i32.const 32) (i32.const 22)
      (i32.const 1)))

  (func (export "resolve_ok")  (result i32) (global.get $r_ok))
  (func (export "event_count") (result i32) (global.get $events))
)
