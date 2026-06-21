import { describe, expect, it } from 'bun:test';
import vm from 'node:vm';
import { DefaultProvider } from '../default/default-provider';
import { NodeVMProvider } from '../providers/node-vm-provider';
import { SandboxType } from '../types/provider';

describe('DefaultProvider', () => {
  describe.skipIf(!vm)('Node.js/Bun environment', () => {
    it('should implement JSEngineProvider interface', () => {
      const provider = new DefaultProvider();

      expect(provider).toBeInstanceOf(DefaultProvider);
      expect(typeof provider.createRuntime).toBe('function');
    });

    it('should auto-select NodeVMProvider in Node.js environment', () => {
      const provider = new DefaultProvider();

      // In Node.js/Bun, resolved provider should be NodeVMProvider
      expect(provider.resolvedProvider).toBeInstanceOf(NodeVMProvider);
    });

    it('should respect explicit vm sandbox mode', () => {
      const provider = new DefaultProvider({ sandbox: SandboxType.NodeVM });

      expect(provider.resolvedProvider).toBeInstanceOf(NodeVMProvider);
    });

    it('should pass timeout to provider', () => {
      const provider = new DefaultProvider({ timeout: 500 });
      const runtime = provider.createRuntime();
      const context = runtime.createContext();

      // Should timeout on infinite loop
      let threw = false;
      try {
        context.eval('for(;;){}');
      } catch {
        threw = true;
      }

      expect(threw).toBe(true);
      context.dispose();
      runtime.dispose();
    });
  });
});
