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
    "[rill] 不再支持 `import ... from 'rill'`。",
    '请改用：',
    "  - Host:  `import { Engine } from 'rill/host'`",
    "  - Guest: `import { View, Text } from 'rill/guest'`",
    "  - UI 预设: `import { EngineView } from 'rill/host/preset'`",
  ].join('\n')
);
