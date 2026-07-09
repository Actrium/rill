// -----------------------------------------------------------------------------
// TEST-ONLY JSI HOST - excluded from the shipped pod (see RillSandboxNative.podspec
// exclude_files). This file is part of a full jsi::Runtime over JavaScriptCore. It is
// NOT the sandbox product: production hosts install the *SandboxJSI HostObject into
// their OWN runtime and never link this cluster (verified: no rill downstream links
// it). It is retained solely as a self-contained, dependency-free JSI host that lets
// the sandbox be unit- and leak-tested natively via native/jsc/run-tests.sh
// (JavaScriptCore tests build via native/jsc/Makefile and need the JSC framework, so
// they run on Apple/macOS - not plain Linux).
// Do NOT add production code that depends on this file; if you do, it must be moved
// back into the shipped source set deliberately.
// -----------------------------------------------------------------------------
/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

#pragma once

#include <jsi/jsi.h>
#include <memory.h>

namespace facebook::jsc {

std::unique_ptr<jsi::Runtime> makeJSCRuntime();

} // namespace facebook::jsc
