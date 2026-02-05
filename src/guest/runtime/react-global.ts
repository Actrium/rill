/**
 * React Global Setup (Guest Runtime)
 *
 * Sets up React and JSX runtimes on globalThis for:
 * - Guest bundles that reference globals (externalized builds)
 * - Engine.require('react' | 'react/jsx-runtime') resolution
 *
 * NOTE: This module must run before rill/guest is evaluated, because
 * rill/guest defines some exports (e.g., ErrorBoundary) at module init time.
 */

import * as React from 'react';
import * as ReactJSXRuntime from 'react/jsx-runtime';

// Mark React as loaded (using real React, not shim)
(globalThis as Record<string, unknown>).__REACT_SHIM__ = false;
(globalThis as Record<string, unknown>).__REACT_REAL__ = true;

// Export React to globalThis
(globalThis as Record<string, unknown>).React = React;
(globalThis as Record<string, unknown>).ReactJSXRuntime = ReactJSXRuntime;
(globalThis as Record<string, unknown>).ReactJSXDevRuntime = ReactJSXRuntime; // Same as JSXRuntime in React 19
