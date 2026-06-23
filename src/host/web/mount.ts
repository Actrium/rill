/**
 * Imperative mount helper for integrators without a React app of their own — mounts a
 * WebEngineView into a plain DOM node via react-dom (issue #19, L2).
 *
 * react-dom is an OPTIONAL peer dependency: integrators that already render React just use
 * the `<WebEngineView/>` component directly and never touch this. The import below uses a
 * non-literal specifier so neither tsc nor a bundler hard-requires react-dom at build time.
 */

import React, { type ReactElement } from 'react';
import { WebEngineView, type WebEngineViewProps } from './engine-view';

interface ReactDOMClientLike {
  createRoot: (container: Element | DocumentFragment) => {
    render: (node: ReactElement) => void;
    unmount: () => void;
  };
}

export interface EngineViewMount {
  /** Unmount the React tree and release the root. */
  unmount(): void;
}

/**
 * Mount a WebEngineView into `container` using the integrator-provided react-dom.
 * Returns a handle whose `unmount()` tears the React tree down.
 */
export async function mountEngineView(
  container: Element,
  props: WebEngineViewProps
): Promise<EngineViewMount> {
  // Non-literal specifier: keeps react-dom out of the static dependency graph (optional peer).
  const specifier: string = 'react-dom/client';
  const mod = (await import(specifier)) as ReactDOMClientLike;
  const root = mod.createRoot(container);
  root.render(React.createElement(WebEngineView, props));
  return {
    unmount: () => root.unmount(),
  };
}
