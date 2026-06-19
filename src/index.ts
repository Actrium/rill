/**
 * rill (root entry)
 *
 * This package enforces explicit entrypoints:
 * - Host:  `rill/host`
 * - Guest: `rill/guest`
 *
 * Do not import from `rill`.
 */

throw new Error(
  [
    "[rill] `import ... from 'rill'` is not supported.",
    'Use one of these explicit entrypoints:',
    "  - Host:  `import { Engine } from 'rill/host'`",
    "  - Guest: `import { View, Text } from 'rill/guest'`",
    "  - Contract: `import { defineRillContract } from 'rill/contract'`",
    "  - UI preset: `import { EngineView } from 'rill/host/preset'`",
  ].join('\n')
);
