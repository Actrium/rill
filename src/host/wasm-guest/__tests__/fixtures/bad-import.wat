;; Adversarial guest that imports an UNDECLARED function. The host provides only
;; rill_host_call / rill_send_batch / rill_log in its importObject, so
;; WebAssembly.instantiate must reject this with a LinkError — the seal is the
;; import allowlist, enforced by the engine.
(module
  (import "env" "evil" (func $evil))
  (memory (export "memory") 1)
  (func (export "rill_init") (call $evil))
)
