//! Conformance tests: lock this SDK to `contracts/graphics-seams.json`, the
//! repo's SINGLE authoritative source for the graphics seam contracts.
//!
//! Two directions, so drift fails CI whichever side moves:
//!  - every request this SDK emits (module, method, body field names, op names
//!    + op field names + JSON types, enum strings) must match the contract —
//!    checked on the REAL wire path: the tests poll the actual host-call
//!    futures and inspect the bytes the `rill_host_call` test shim recorded;
//!  - every op / method / enum value / budget key the contract declares must be
//!    exercised by this SDK — an addition to the contract without SDK support
//!    fails here too.
//!
//! The gpu budget constants are GENERATED from the same file by build.rs, so
//! they cannot drift by construction; the equality tests below additionally
//! pin the generator's key→constant mapping.

use crate::mini_json::Json;
use crate::test_shims::CALLS;
use crate::{asset, canvas, gpu};
use core::future::Future;
use core::pin::Pin;
use core::task::{Context, Poll, Waker};
use std::boxed::Box;
use std::collections::BTreeSet;
use std::format;
use std::string::{String, ToString};
use std::sync::MutexGuard;
use std::vec;
use std::vec::Vec;

/// Serialize tests that drive host-call futures or the event registry: the
/// SDK's runtime statics (`rt::NEXT_CB` / `rt::RESULTS` / `events::HANDLERS`)
/// assume the single-threaded wasm world, while libtest runs tests on threads.
fn wire_lock() -> MutexGuard<'static, ()> {
    crate::wire_lock()
}

fn contract() -> Json {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../contracts/graphics-seams.json"
    );
    let src = std::fs::read_to_string(path)
        .unwrap_or_else(|e| panic!("read authoritative contract {path}: {e}"));
    Json::parse(&src).unwrap_or_else(|e| panic!("parse {path}: {e}"))
}

fn seam<'a>(root: &'a Json, name: &str) -> &'a Json {
    root.get("seams")
        .and_then(|s| s.get(name))
        .unwrap_or_else(|| panic!("contract: seams[{name:?}] missing"))
}

/// Keys of a contract object, minus `$`-prefixed annotations.
fn spec_keys(spec: &Json) -> BTreeSet<String> {
    spec.entries()
        .unwrap_or_else(|| panic!("contract node is not an object"))
        .iter()
        .map(|(k, _)| k.clone())
        .filter(|k| !k.starts_with('$'))
        .collect()
}

fn type_matches(ty: &str, value: &Json) -> bool {
    match ty {
        "number" => matches!(value, Json::Num(_)),
        "string" => matches!(value, Json::Str(_)),
        "boolean" => matches!(value, Json::Bool(_)),
        "array" => matches!(value, Json::Arr(_)),
        other => panic!("contract: unknown wire type {other:?}"),
    }
}

/// Assert an emitted JSON object carries EXACTLY the fields (names + types) a
/// contract field-spec object declares.
fn check_fields(what: &str, emitted: &Json, spec: &Json, skip: &[&str]) {
    let expected = spec_keys(spec);
    let got: BTreeSet<String> = emitted
        .entries()
        .unwrap_or_else(|| panic!("{what}: emitted body is not an object"))
        .iter()
        .map(|(k, _)| k.clone())
        .filter(|k| !skip.contains(&k.as_str()))
        .collect();
    assert_eq!(got, expected, "{what}: wire field set != contract");
    for key in &expected {
        let ty = spec
            .get(key)
            .and_then(Json::as_str)
            .unwrap_or_else(|| panic!("contract: {what}.{key} type must be a string"));
        let value = emitted.get(key).expect("checked by set equality");
        assert!(
            type_matches(ty, value),
            "{what}.{key}: wire value {value:?} is not a {ty}"
        );
    }
}

/// Assert every emitted op matches the contract op table, and that the table
/// is FULLY covered (each contract op emitted at least once).
fn check_ops(what: &str, emitted_ops: &Json, spec: &Json) {
    let mut seen = BTreeSet::new();
    for op in emitted_ops
        .items()
        .unwrap_or_else(|| panic!("{what}: 'ops' is not an array"))
    {
        let name = op
            .get("op")
            .and_then(Json::as_str)
            .unwrap_or_else(|| panic!("{what}: op without an 'op' name: {op:?}"));
        let op_spec = spec
            .get(name)
            .unwrap_or_else(|| panic!("{what}: emitted op {name:?} is not in the contract"));
        check_fields(&format!("{what}.{name}"), op, op_spec, &["op"]);
        seen.insert(name.to_string());
    }
    assert_eq!(
        seen,
        spec_keys(spec),
        "{what}: the test must exercise every contract op (and no unknown ones)"
    );
}

fn enum_values(seam_spec: &Json, key: &str) -> Vec<String> {
    seam_spec
        .get(key)
        .and_then(Json::items)
        .unwrap_or_else(|| panic!("contract: {key} missing"))
        .iter()
        .map(|v| v.as_str().expect("enum entries are strings").to_string())
        .collect()
}

// ---- driving real host-call futures against the recording shim ----

fn poll_once<F: Future>(fut: Pin<&mut F>) -> Poll<F::Output> {
    let mut cx = Context::from_waker(Waker::noop());
    fut.poll(&mut cx)
}

/// A host call captured mid-flight: the future was polled once (issuing the
/// real `rill_host_call`), and the recorded wire bytes are parsed for
/// inspection. `resolve()` completes the round trip.
struct Issued<F: Future> {
    fut: Pin<Box<F>>,
    module: String,
    method: String,
    body: Json,
    cb: u32,
}

fn issue<F: Future>(f: F) -> Issued<F> {
    CALLS.lock().unwrap_or_else(|e| e.into_inner()).clear();
    let mut fut = Box::pin(f);
    assert!(
        poll_once(fut.as_mut()).is_pending(),
        "host-call future must park on first poll"
    );
    let mut calls = CALLS.lock().unwrap_or_else(|e| e.into_inner());
    assert_eq!(calls.len(), 1, "expected exactly one rill_host_call");
    let (module, method, input, cb) = calls.pop().expect("len checked");
    drop(calls);
    let text = core::str::from_utf8(&input).expect("request body must be UTF-8");
    let body = Json::parse(text).unwrap_or_else(|e| {
        panic!("{module}.{method}: request body is not valid JSON ({e}): {text}")
    });
    Issued {
        fut,
        module,
        method,
        body,
        cb,
    }
}

impl<F: Future> Issued<F> {
    /// Feed the host's response back through the real `rill_resolve` path and
    /// return the completed future's output.
    fn resolve(mut self, ok: u32, response: &str) -> F::Output {
        unsafe { crate::rt::resolve(self.cb, ok, response.as_ptr(), response.len()) };
        match poll_once(self.fut.as_mut()) {
            Poll::Ready(out) => out,
            Poll::Pending => panic!("future did not complete after resolve"),
        }
    }
}

/// Look up a method spec and verify the captured module/method/body against it.
fn check_method<F: Future>(root: &Json, seam_name: &str, issued: &Issued<F>) {
    assert_eq!(issued.module, seam_name, "wire module name");
    let method_spec = seam(root, seam_name)
        .get("methods")
        .and_then(|m| m.get(&issued.method))
        .unwrap_or_else(|| {
            panic!(
                "contract: method {}.{} missing — the SDK emits it",
                seam_name, issued.method
            )
        });
    if let Some(request) = method_spec.get("request") {
        check_fields(
            &format!("{}.{}", seam_name, issued.method),
            &issued.body,
            request,
            &[],
        );
    }
}

// ---- generated constants ↔ contract ----

#[test]
fn gpu_budget_constants_match_contract() {
    let root = contract();
    let budget = seam(&root, "host:gpu")
        .get("budget")
        .expect("contract: host:gpu.budget");
    let val = |key: &str| {
        budget
            .get(key)
            .and_then(Json::as_u64)
            .unwrap_or_else(|| panic!("contract: budget.{key} missing"))
    };
    assert_eq!(gpu::MAX_CMDS as u64, val("maxCmds"));
    assert_eq!(gpu::MAX_DRAW_CALLS as u64, val("maxDrawCalls"));
    assert_eq!(gpu::MAX_PRIMITIVES, val("maxPrimitives"));
    assert_eq!(
        gpu::MAX_INSTANCES_PER_DRAW as u64,
        val("maxInstancesPerDraw")
    );
    assert_eq!(gpu::MAX_INSTANCES_TOTAL, val("maxInstancesTotal"));
    assert_eq!(gpu::MAX_ELEMENTS_PER_DRAW as u64, val("maxElementsPerDraw"));
    assert_eq!(gpu::MAX_PIXELS, val("maxPixels"));
    assert_eq!(gpu::MAX_BUFFER_BYTES as u64, val("maxBufferBytes"));
    // No contract budget key may go unmirrored: the set must be exactly the
    // eight the SDK (and this test) know about.
    let known: BTreeSet<String> = [
        "maxCmds",
        "maxDrawCalls",
        "maxPrimitives",
        "maxInstancesPerDraw",
        "maxInstancesTotal",
        "maxElementsPerDraw",
        "maxPixels",
        "maxBufferBytes",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    assert_eq!(spec_keys(budget), known, "budget keys drifted");
}

#[test]
fn gpu_presets_match_contract() {
    let root = contract();
    let presets = seam(&root, "host:gpu")
        .get("presets")
        .expect("contract: host:gpu.presets");
    let id = |name: &str| {
        presets
            .get(name)
            .and_then(|p| p.get("id"))
            .and_then(Json::as_u64)
            .unwrap_or_else(|| panic!("contract: presets.{name}.id missing"))
    };
    assert_eq!(gpu::preset::SOLID_2D as u64, id("SOLID_2D"));
    assert_eq!(gpu::preset::TEXTURED_2D as u64, id("TEXTURED_2D"));
    assert_eq!(
        spec_keys(presets),
        ["SOLID_2D", "TEXTURED_2D"]
            .iter()
            .map(|s| s.to_string())
            .collect::<BTreeSet<_>>(),
        "preset set drifted (add the SDK constant + this assert together)"
    );
}

// ---- host:canvas ----

#[test]
fn canvas_draw_wire_matches_contract() {
    let _guard = wire_lock();
    let root = contract();
    let canvas_seam = seam(&root, "host:canvas");
    assert_eq!(
        spec_keys(canvas_seam.get("methods").expect("methods")),
        ["draw", "present"].iter().map(|s| s.to_string()).collect(),
        "host:canvas method set drifted"
    );

    // Exercise EVERY display-list op the contract declares.
    let mut list = canvas::DrawList::new();
    list.begin_path()
        .close_path()
        .move_to(1.0, 2.0)
        .line_to(3.0, 4.0)
        .rect(0.0, 0.0, 10.0, 10.0)
        .arc(5.0, 5.0, 4.0, 0.0, core::f64::consts::PI)
        .fill()
        .stroke()
        .fill_rect(0.0, 0.0, 8.0, 8.0)
        .stroke_rect(1.0, 1.0, 6.0, 6.0)
        .clear_rect(2.0, 2.0, 4.0, 4.0)
        .set_fill_style("#112233")
        .set_stroke_style("#445566")
        .set_line_width(2.0)
        .fill_text("rill", 3.0, 9.0)
        .save()
        .restore()
        .translate(1.0, 1.0)
        .scale(2.0, 2.0)
        .rotate(0.5)
        .set_transform(1.0, 0.0, 0.0, 1.0, 0.0, 0.0);
    assert!(list.is_valid());

    // Under the WIP binary feature, `canvas::draw` first probes
    // `host:canvas.getInfo` (the capability handshake). Answer "binary
    // unsupported" so the guest falls back to the JSON op-list THIS test
    // validates against the contract; without the feature the JSON call is the
    // first and only one.
    #[cfg(feature = "wip-binary-protocol")]
    let issued = draw_after_handshake(canvas::draw("scene", &list));
    #[cfg(not(feature = "wip-binary-protocol"))]
    let issued = issue(canvas::draw("scene", &list));
    assert_eq!(issued.method, "draw");
    check_method(&root, "host:canvas", &issued);
    check_ops(
        "host:canvas.draw",
        issued.body.get("ops").expect("ops"),
        canvas_seam.get("ops").expect("contract: canvas ops"),
    );
    let out = issued.resolve(1, r#"{"ok":true,"dropped":0}"#);
    assert!(out.is_ok(), "draw must surface the host's ok response");
}

/// Under the WIP binary feature, `canvas::draw` probes `host:canvas.getInfo`
/// before it emits. Drive that probe, answer "binary unsupported" (so the guest
/// falls back to the JSON op-list), and return the `Issued` positioned at the
/// follow-up JSON `draw` call so the existing contract checks apply unchanged.
#[cfg(feature = "wip-binary-protocol")]
fn draw_after_handshake<F: Future>(f: F) -> Issued<F> {
    CALLS.lock().unwrap_or_else(|e| e.into_inner()).clear();
    let mut fut = Box::pin(f);
    assert!(
        poll_once(fut.as_mut()).is_pending(),
        "getInfo probe must park on first poll"
    );
    let (module, method, _in, cb) = {
        let mut calls = CALLS.lock().unwrap_or_else(|e| e.into_inner());
        assert_eq!(calls.len(), 1, "expected exactly the getInfo probe");
        calls.pop().expect("len checked")
    };
    assert_eq!(module, "host:canvas", "handshake module");
    assert_eq!(method, "getInfo", "draw must probe getInfo first under wip");
    // Answer the probe as unsupported -> the guest emits the JSON op-list.
    CALLS.lock().unwrap_or_else(|e| e.into_inner()).clear();
    let resp = r#"{"binaryDraw":false,"wireVersion":1}"#;
    unsafe { crate::rt::resolve(cb, 1, resp.as_ptr(), resp.len()) };
    assert!(
        poll_once(fut.as_mut()).is_pending(),
        "the JSON draw call must park after the handshake"
    );
    let (module2, method2, input2, cb2) = {
        let mut calls = CALLS.lock().unwrap_or_else(|e| e.into_inner());
        assert_eq!(calls.len(), 1, "expected exactly the JSON draw call");
        calls.pop().expect("len checked")
    };
    let text = core::str::from_utf8(&input2).expect("request body must be UTF-8");
    let body = Json::parse(text)
        .unwrap_or_else(|e| panic!("{module2}.{method2}: body not JSON ({e}): {text}"));
    Issued {
        fut,
        module: module2,
        method: method2,
        body,
        cb: cb2,
    }
}

#[test]
fn canvas_present_wire_matches_contract() {
    let _guard = wire_lock();
    let root = contract();
    let canvas_seam = seam(&root, "host:canvas");
    let formats = enum_values(canvas_seam, "presentFormats");

    let surface = canvas::Surface::new(2, 3);
    let issued = issue(canvas::present("viewport", &surface));
    assert_eq!(issued.method, "present");
    check_method(&root, "host:canvas", &issued);
    let format = issued
        .body
        .get("format")
        .and_then(Json::as_str)
        .expect("present carries a format")
        .to_string();
    assert!(
        formats.contains(&format),
        "present format {format:?} not in contract {formats:?}"
    );
    assert_eq!(issued.body.get("width").and_then(Json::as_u64), Some(2));
    assert_eq!(issued.body.get("height").and_then(Json::as_u64), Some(3));
    let out = issued.resolve(1, r#"{"ok":true,"dropped":0}"#);
    assert!(out.is_ok());
}

// ---- host:gpu ----

#[test]
fn gpu_wire_matches_contract() {
    let _guard = wire_lock();
    let root = contract();
    let gpu_seam = seam(&root, "host:gpu");
    assert_eq!(
        spec_keys(gpu_seam.get("methods").expect("methods")),
        ["configure", "createResource", "submit"]
            .iter()
            .map(|s| s.to_string())
            .collect(),
        "host:gpu method set drifted"
    );
    let modes = enum_values(gpu_seam, "modes");
    let index_formats = enum_values(gpu_seam, "indexFormats");
    let resource_kinds = enum_values(gpu_seam, "resourceKinds");
    // Both directions for the enums: the SDK exercises every value below, so
    // the lists must be exactly the variants the SDK has.
    assert_eq!(modes.len(), 2, "gpu mode set drifted");
    assert_eq!(index_formats.len(), 2, "index format set drifted");
    assert_eq!(resource_kinds.len(), 3, "resource kind set drifted");

    // configure — one call per Mode variant; the wire string must be a
    // contract mode value and the ok:true response must parse as success.
    for (mode, expect_wire) in [(gpu::Mode::Webgpu, "webgpu"), (gpu::Mode::Webgl2, "webgl2")] {
        let issued = issue(gpu::configure("viewport", mode));
        assert_eq!(issued.method, "configure");
        check_method(&root, "host:gpu", &issued);
        let wire_mode = issued
            .body
            .get("mode")
            .and_then(Json::as_str)
            .expect("configure carries a mode")
            .to_string();
        assert_eq!(wire_mode, expect_wire);
        assert!(
            modes.contains(&wire_mode),
            "mode {wire_mode:?} not in contract"
        );
        assert!(issued.resolve(1, r#"{"ok":true}"#));
    }

    // createResource — every kind variant, checked against its request variant.
    let variants = gpu_seam
        .get("methods")
        .and_then(|m| m.get("createResource"))
        .and_then(|m| m.get("requestVariants"))
        .expect("contract: createResource.requestVariants");
    assert_eq!(
        spec_keys(variants),
        resource_kinds.iter().cloned().collect::<BTreeSet<_>>(),
        "createResource request variants must cover exactly resourceKinds"
    );

    let data = [0u8; 24];
    let vertex = {
        let issued = issue(gpu::create_vertex_buffer("viewport", &data));
        assert_eq!(issued.module, "host:gpu");
        assert_eq!(issued.method, "createResource");
        check_fields(
            "host:gpu.createResource[vertex]",
            &issued.body,
            variants.get("vertex").expect("vertex variant"),
            &[],
        );
        assert_eq!(
            issued.body.get("kind").and_then(Json::as_str),
            Some("vertex")
        );
        issued
            .resolve(1, r#"{"ok":true,"handle":1}"#)
            .expect("vertex handle")
    };
    assert_eq!(vertex.id(), 1);

    let mut index = None;
    for (format, expect_wire, handle) in [
        (gpu::IndexFormat::Uint16, "uint16", 2u32),
        (gpu::IndexFormat::Uint32, "uint32", 3u32),
    ] {
        let issued = issue(gpu::create_index_buffer("viewport", &data, format));
        check_fields(
            "host:gpu.createResource[index]",
            &issued.body,
            variants.get("index").expect("index variant"),
            &[],
        );
        assert_eq!(
            issued.body.get("kind").and_then(Json::as_str),
            Some("index")
        );
        let wire_format = issued
            .body
            .get("format")
            .and_then(Json::as_str)
            .expect("index upload carries a format")
            .to_string();
        assert_eq!(wire_format, expect_wire);
        assert!(index_formats.contains(&wire_format));
        let response = format!("{{\"ok\":true,\"handle\":{handle}}}");
        index = issued.resolve(1, &response);
        assert_eq!(index.expect("index handle").id(), handle);
    }
    let index = index.expect("index handle");

    let texture = {
        let issued = issue(gpu::create_texture("viewport", "logo"));
        check_fields(
            "host:gpu.createResource[texture]",
            &issued.body,
            variants.get("texture").expect("texture variant"),
            &[],
        );
        assert_eq!(
            issued.body.get("kind").and_then(Json::as_str),
            Some("texture")
        );
        issued
            .resolve(1, r#"{"ok":true,"handle":4}"#)
            .expect("texture handle")
    };

    // submit — exercise EVERY opcode the contract whitelists.
    let mut cmds = gpu::CommandBuffer::new();
    cmds.begin_pass(0.0, 0.0, 0.0, 1.0)
        .set_pipeline(gpu::preset::TEXTURED_2D)
        .set_bind_group(0, texture)
        .set_vertex(vertex)
        .set_index(index, gpu::IndexFormat::Uint32)
        .set_viewport(0.0, 0.0, 64.0, 64.0)
        .draw(3)
        .draw_indexed(6)
        .draw_instanced(3, 2)
        .end_pass()
        .finish();
    assert!(cmds.is_valid() && cmds.within_budget());

    let issued = issue(gpu::submit("viewport", &cmds));
    assert_eq!(issued.method, "submit");
    check_method(&root, "host:gpu", &issued);
    check_ops(
        "host:gpu.submit",
        issued.body.get("ops").expect("ops"),
        gpu_seam.get("ops").expect("contract: gpu ops"),
    );
    let out = issued.resolve(1, r#"{"ok":true,"dropped":0}"#);
    assert!(out.is_ok());
}

#[test]
fn gpu_cost_formula_matches_contract() {
    let root = contract();
    let formula = seam(&root, "host:gpu")
        .get("costFormula")
        .expect("contract: host:gpu.costFormula");
    let vpp = formula
        .get("verticesPerPrimitive")
        .and_then(Json::as_u64)
        .expect("contract: verticesPerPrimitive");

    let mut cmds = gpu::CommandBuffer::new();
    cmds.set_viewport(0.0, 0.0, 100.0, 100.0);
    cmds.draw_instanced(6, 2);
    cmds.draw(9);
    let cost = cmds.cost();
    let d1 = (6 / vpp) * 2; // instanced draw
    let d2 = 9 / vpp; // plain draw counts as 1 instance
    assert_eq!(cost.primitives, d1 + d2, "primitives formula drifted");
    assert_eq!(cost.instances, 2 + 1, "instances accounting drifted");
    assert_eq!(
        cost.pixels,
        100 * 100 * (d1 + d2),
        "pixels (fill-rate proxy) formula drifted"
    );
}

// ---- host:asset ----

#[test]
fn asset_wire_matches_contract() {
    let _guard = wire_lock();
    let root = contract();
    let asset_seam = seam(&root, "host:asset");
    assert_eq!(
        spec_keys(asset_seam.get("methods").expect("methods")),
        ["info", "blit"].iter().map(|s| s.to_string()).collect(),
        "host:asset method set drifted"
    );

    // info — and the response FIELD NAMES the SDK parses are the contract's.
    let info_response = asset_seam
        .get("methods")
        .and_then(|m| m.get("info"))
        .and_then(|m| m.get("response"))
        .expect("contract: info.response");
    assert_eq!(
        spec_keys(info_response),
        ["width", "height"].iter().map(|s| s.to_string()).collect(),
        "info response fields drifted (SDK parses width/height)"
    );
    let issued = issue(asset::info("logo"));
    check_method(&root, "host:asset", &issued);
    assert_eq!(
        issued.resolve(1, r#"{"width":7,"height":9}"#),
        Some((7, 9)),
        "SDK must parse the contract's response field names"
    );

    // blit — dstCap must be the destination buffer length.
    let mut dst = vec![0u8; 16];
    let issued = issue(asset::blit("logo", &mut dst));
    check_method(&root, "host:asset", &issued);
    assert_eq!(issued.body.get("dstCap").and_then(Json::as_u64), Some(16));
    assert_eq!(issued.resolve(1, r#"{"ok":true,"written":16}"#), Some(16));
}

// ---- events ----

#[test]
fn event_names_match_contract() {
    let _guard = wire_lock();
    let root = contract();

    // gpu.deviceLost: the SDK's on_device_lost subscription must fire for the
    // event name the contract declares.
    let gpu_events = seam(&root, "host:gpu").get("events").expect("gpu events");
    assert!(
        gpu_events.get("gpu.deviceLost").is_some(),
        "contract: gpu.deviceLost event missing"
    );
    let fired = std::rc::Rc::new(core::cell::Cell::new(false));
    let seen = fired.clone();
    let id = gpu::on_device_lost(move |_payload| seen.set(true));
    let name = "gpu.deviceLost";
    let payload = br#"{"canvasId":"viewport","reason":"tdr"}"#;
    unsafe {
        crate::events::dispatch(name.as_ptr(), name.len(), payload.as_ptr(), payload.len());
    }
    crate::events::off(id);
    assert!(
        fired.get(),
        "on_device_lost must fire for the contract's event name"
    );

    // canvas.frame: no SDK wrapper (guests subscribe by name), but the contract
    // must keep declaring it with the payload the host emits.
    let frame = seam(&root, "host:canvas")
        .get("events")
        .and_then(|e| e.get("canvas.frame"))
        .expect("contract: canvas.frame event missing");
    assert_eq!(
        spec_keys(frame.get("payload").expect("payload")),
        ["canvasId", "t", "dt", "frame"]
            .iter()
            .map(|s| s.to_string())
            .collect(),
        "canvas.frame payload drifted"
    );
}
