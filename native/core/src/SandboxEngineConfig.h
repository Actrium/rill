#pragma once

// Sandbox engine constants.
//
// NOTE: Keep this header free of React Native / folly includes so it can be used
// from core C++ translation units without pulling in RN headers.

#define RILL_SANDBOX_ENGINE_JSC 1
#define RILL_SANDBOX_ENGINE_HERMES 2
#define RILL_SANDBOX_ENGINE_QUICKJS 3

// Sandbox engine selection (default to JSC if not specified by build system).
#ifndef RILL_SANDBOX_ENGINE
#define RILL_SANDBOX_ENGINE RILL_SANDBOX_ENGINE_JSC
#endif

