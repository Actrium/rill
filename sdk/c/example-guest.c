/*
 * A minimal native rill guest written in C, using the C SDK (rill_guest.h).
 * On rill_init it renders View > Text("hello from c") via the render channel —
 * the same batch protocol the Rust/JS guests use, authored in C. Compiles to a
 * .wasm the Phase A WasmGuestHost loads unchanged (see sdk/c/build.sh).
 */
#include "rill_guest.h"

__attribute__((export_name("rill_init"))) void rill_init(void) {
  /* Text nodes are CREATE type "__TEXT__" with props.text — the shape the
   * host receiver renders as Text children (same as the JS reconciler). */
  rill_render("{\"version\":1,\"batchId\":1,\"operations\":["
              "{\"op\":\"CREATE\",\"id\":1,\"type\":\"View\",\"props\":{}},"
              "{\"op\":\"CREATE\",\"id\":2,\"type\":\"__TEXT__\",\"props\":{\"text\":\"hello from c\"}},"
              "{\"op\":\"APPEND\",\"id\":0,\"parentId\":1,\"childId\":2},"
              "{\"op\":\"APPEND\",\"id\":0,\"parentId\":0,\"childId\":1}"
              "]}");
}
