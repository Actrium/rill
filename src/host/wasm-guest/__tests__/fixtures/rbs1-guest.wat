;; Native (non-JS) rill guest that speaks the RBS1 binary-value ENVELOPE
;; (contracts/store-net-bytes.json). On rill_init it makes ONE host call
;; (host:store.putBytes) whose INPUT is an RBS1 frame carrying a byte-stream
;; value as a length-prefixed segment (control plane {"value":{"$b":0}} +
;; segment [1,2,3]). This exercises the host's receive fork (decode RBS1 ->
;; revive Uint8Array -> dispatch). The host handler returns a byte-carrying
;; result, so the host's RETURN fork encodes an RBS1 frame back; rill_resolve
;; stashes its ptr/len for the test to decode. Hand-written so the wire is
;; visible; sister to roundtrip.wat (the plain-JSON case).
(module
  (import "env" "rill_host_call"
    (func $host_call (param i32 i32 i32 i32 i32 i32 i32)))

  (memory (export "memory") 1)

  ;; static request bytes
  (data (i32.const 0)  "host:store")   ;; module @0  len 10
  (data (i32.const 16) "putBytes")     ;; method @16 len 8
  ;; RBS1 request frame @32 len 37: magic 'RBS1' + jsonLen(18) +
  ;; {"value":{"$b":0}} + segCount(1) + segLen(3) + bytes 01 02 03
  (data (i32.const 32) "RBS1\12\00\00\00{\"value\":{\"$b\":0}}\01\00\00\00\03\00\00\00\01\02\03")

  (global $bump (mut i32) (i32.const 1024))   ;; bump allocator above the request region
  (global $r_ok  (mut i32) (i32.const -1))
  (global $r_ptr (mut i32) (i32.const 0))
  (global $r_len (mut i32) (i32.const 0))

  (func (export "rill_alloc") (param $size i32) (result i32)
    (local $p i32)
    (local.set $p (global.get $bump))
    (global.set $bump (i32.add (global.get $bump) (local.get $size)))
    (local.get $p))

  (func (export "rill_resolve") (param $cb i32) (param $ok i32) (param $ptr i32) (param $len i32)
    (global.set $r_ok  (local.get $ok))
    (global.set $r_ptr (local.get $ptr))
    (global.set $r_len (local.get $len)))

  (func (export "rill_init")
    (call $host_call
      (i32.const 0)  (i32.const 10)   ;; module "host:store"
      (i32.const 16) (i32.const 8)    ;; method "putBytes"
      (i32.const 32) (i32.const 37)   ;; RBS1 request frame
      (i32.const 1)))                 ;; cb id 1

  (func (export "resolve_ok")  (result i32) (global.get $r_ok))
  (func (export "resolve_ptr") (result i32) (global.get $r_ptr))
  (func (export "resolve_len") (result i32) (global.get $r_len))
)
