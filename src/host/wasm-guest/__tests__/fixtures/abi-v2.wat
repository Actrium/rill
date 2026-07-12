;; Guest declaring a FUTURE ABI version (2). The host supports only v1 and
;; must reject it at load (fail-closed) WITHOUT running rill_init.
(module
  (memory (export "memory") 1)
  (global $bump (mut i32) (i32.const 1024))
  (global $ran (mut i32) (i32.const 0))
  (func (export "rill_abi_version") (result i32) (i32.const 2))
  (func (export "rill_alloc") (param $size i32) (result i32)
    (local $p i32)
    (local.set $p (global.get $bump))
    (global.set $bump (i32.add (global.get $bump) (local.get $size)))
    (local.get $p))
  (func (export "rill_resolve") (param i32 i32 i32 i32))
  (func (export "rill_init") (global.set $ran (i32.const 1)))
  (func (export "init_ran") (result i32) (global.get $ran))
)
