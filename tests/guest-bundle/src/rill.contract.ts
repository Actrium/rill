import { defineRillContract, rpc, subscription } from 'rill/contract';

export const contract = defineRillContract({
  version: '1.0.0',
  hostModules: {
    'host:analytics': {
      track: rpc<{ name: string; props?: Record<string, unknown> }, void>(),
    },
    'host:navigation': {
      openProfile: rpc<{ userId: string }, void>(),
    },
    'host:theme': {
      onThemeChanged: subscription<{ theme: 'light' | 'dark' }>(),
    },
  },
  guestExports: {
    refresh: rpc<{ reason: string }, void>(),
  },
});
