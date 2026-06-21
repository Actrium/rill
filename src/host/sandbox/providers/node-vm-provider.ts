import vm from 'node:vm';
import type { JSEngineProvider, JSEngineRuntime, SandboxScope } from '../types/provider';

/**
 * An implementation of JSEngineProvider that uses the Node.js `vm` module.
 * This provides a secure, native sandbox for executing code in Node.js/Bun environments.
 *
 * Timeout Support:
 * - Hard timeout: YES. Uses vm.Script.runInContext({ timeout }) which is a true hard interrupt.
 */
export class NodeVMProvider implements JSEngineProvider {
  private options: { timeout?: number };

  constructor(options?: { timeout?: number }) {
    this.options = options || {};
  }

  createRuntime(): JSEngineRuntime {
    const timeout = this.options.timeout;
    const contexts: SandboxScope[] = [];

    const createContext = (): SandboxScope => {
      const vmContext = vm.createContext({});

      const context: SandboxScope = {
        eval: (code: string) => {
          const script = new vm.Script(code);
          // vm.Script timeout provides hard interrupt capability
          return script.runInContext(vmContext, { timeout });
        },

        inject: (name: string, value: unknown) => {
          vmContext[name] = value;
        },

        extract: (name: string) => {
          return vmContext[name];
        },

        dispose: () => {
          // In vm, the context is just an object that can be garbage collected.
          // Clear all properties to help GC
          for (const key of Object.keys(vmContext)) {
            delete vmContext[key];
          }
        },
      };

      contexts.push(context);
      return context;
    };

    return {
      createContext,
      dispose: () => {
        // Dispose all contexts created by this runtime
        for (const ctx of contexts) {
          ctx.dispose();
        }
        contexts.length = 0;
      },
    };
  }
}
