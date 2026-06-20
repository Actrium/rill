import { defineRillContract, rpc, subscription } from 'rill/contract';

// Boundary schemas parse untrusted cross-runtime values. They run on the host
// side: parseInput before a host implementation sees guest arguments, parseEvent
// before a host event reaches a guest subscription handler. A rejected value
// throws (fail-closed) and never crosses the boundary.

function asObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object') {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

export const contract = defineRillContract({
  version: '1.0.0',
  hostModules: {
    'host:analytics': {
      track: rpc<{ name: string; props?: Record<string, unknown> }, void>({
        schema: {
          parseInput: (value) => {
            const input = asObject(value, 'track input');
            if (typeof input.name !== 'string' || input.name.length === 0) {
              throw new Error('track input.name must be a non-empty string');
            }
            if (input.props !== undefined && typeof input.props !== 'object') {
              throw new Error('track input.props must be an object when present');
            }
            return { name: input.name, props: input.props as Record<string, unknown> | undefined };
          },
        },
      }),
    },
    'host:navigation': {
      openProfile: rpc<{ userId: string }, void>({
        schema: {
          parseInput: (value) => {
            const input = asObject(value, 'openProfile input');
            if (typeof input.userId !== 'string' || input.userId.length === 0) {
              throw new Error('openProfile input.userId must be a non-empty string');
            }
            return { userId: input.userId };
          },
        },
      }),
    },
    'host:theme': {
      onThemeChanged: subscription<{ theme: 'light' | 'dark' }>({
        schema: {
          parseEvent: (value) => {
            const event = asObject(value, 'theme event');
            if (event.theme !== 'light' && event.theme !== 'dark') {
              throw new Error('theme event.theme must be "light" or "dark"');
            }
            return { theme: event.theme };
          },
        },
      }),
    },
  },
  guestExports: {
    refresh: rpc<{ reason: string }, void>(),
  },
});
