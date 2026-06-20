import { beforeEach, describe, expect, it, mock } from 'bun:test';

// Mock the native module
const mockContext = {
  eval: mock((code: string) => `result: ${code}`),
  inject: mock((_name: string, _value: unknown) => {}),
  extract: mock((name: string) => `global:${name}`),
  dispose: mock(() => {}),
};

const mockRuntime = {
  createContext: mock(() => mockContext),
  dispose: mock(() => {}),
};

const mockModule = {
  createRuntime: mock((_options?: { timeout?: number }) => mockRuntime),
  isAvailable: mock(() => true),
};

// Mock the native module
mock.module('../native/quickjs-module', () => ({
  isQuickJSAvailable: () => true,
  getQuickJSModule: () => mockModule,
}));

// Import after mocking
import { isQuickJSAvailable, QuickJSProvider } from '../providers/quickjs-provider.native';

describe('QuickJSProvider', () => {
  beforeEach(() => {
    mockContext.eval.mockClear();
    mockContext.inject.mockClear();
    mockContext.extract.mockClear();
    mockContext.dispose.mockClear();
    mockRuntime.createContext.mockClear();
    mockRuntime.dispose.mockClear();
    mockModule.createRuntime.mockClear();
  });

  describe('isQuickJSAvailable', () => {
    it('should return true when module is available', () => {
      expect(isQuickJSAvailable()).toBe(true);
    });
  });

  describe('constructor', () => {
    it('should create provider without options', () => {
      const provider = new QuickJSProvider();
      expect(provider).toBeDefined();
    });

    it('should create provider with timeout option', () => {
      const provider = new QuickJSProvider({ timeout: 5000 });
      expect(provider).toBeDefined();
    });
  });

  describe('createRuntime', () => {
    it('should create runtime and pass timeout option', () => {
      const provider = new QuickJSProvider({ timeout: 3000 });
      const runtime = provider.createRuntime();

      expect(runtime).toBeDefined();
      expect(mockModule.createRuntime).toHaveBeenCalledWith({ timeout: 3000 });
    });

    it('should create runtime without options when timeout not specified', () => {
      const provider = new QuickJSProvider();
      provider.createRuntime();

      expect(mockModule.createRuntime).toHaveBeenCalledWith(undefined);
    });

    it('should return runtime with createContext and dispose', () => {
      const provider = new QuickJSProvider();
      const runtime = provider.createRuntime();

      expect(runtime.createContext).toBeDefined();
      expect(runtime.dispose).toBeDefined();
    });
  });

  describe('context operations', () => {
    it('should call native eval', () => {
      const provider = new QuickJSProvider();
      const runtime = provider.createRuntime();
      const context = runtime.createContext();

      const result = context.eval('1 + 1');

      expect(mockContext.eval).toHaveBeenCalledWith('1 + 1');
      expect(result).toBe('result: 1 + 1');
    });

    it('should call native inject', () => {
      const provider = new QuickJSProvider();
      const runtime = provider.createRuntime();
      const context = runtime.createContext();

      context.inject('testVar', 42);

      expect(mockContext.inject).toHaveBeenCalledWith('testVar', 42);
    });

    it('should call native extract', () => {
      const provider = new QuickJSProvider();
      const runtime = provider.createRuntime();
      const context = runtime.createContext();

      const result = context.extract('myVar');

      expect(mockContext.extract).toHaveBeenCalledWith('myVar');
      expect(result).toBe('global:myVar');
    });

    it('should call native dispose on context', () => {
      const provider = new QuickJSProvider();
      const runtime = provider.createRuntime();
      const context = runtime.createContext();

      context.dispose();

      expect(mockContext.dispose).toHaveBeenCalled();
    });
  });

  describe('runtime dispose', () => {
    it('should call native runtime dispose', () => {
      const provider = new QuickJSProvider();
      const runtime = provider.createRuntime();

      runtime.dispose();

      expect(mockRuntime.dispose).toHaveBeenCalled();
    });
  });
});
