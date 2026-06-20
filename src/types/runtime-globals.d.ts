type RuntimeReviewedUnknown = import('../shared/types').ReviewedUnknown;

declare const process:
  | {
      versions?: {
        node?: string;
      };
    }
  | undefined;

declare const global: typeof globalThis;

// biome-ignore lint/suspicious/noExplicitAny: mirrors the CommonJS require type from @types/node.
declare function require(moduleName: string): any;

declare module 'node:vm' {
  export type Context = Record<string, RuntimeReviewedUnknown>;

  export type RunningScriptOptions = {
    timeout?: number;
  };

  export class Script {
    constructor(code: string);
    runInContext(context: Context, options?: RunningScriptOptions): RuntimeReviewedUnknown;
  }

  export function createContext(sandbox?: Record<string, RuntimeReviewedUnknown>): Context;

  const vm: {
    Script: typeof Script;
    createContext: typeof createContext;
  };

  export default vm;
}
