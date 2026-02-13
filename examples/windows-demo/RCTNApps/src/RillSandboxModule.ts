/**
 * TypeScript spec for the Windows native module.
 *
 * react-native-windows codegen reads this spec to generate C++ stubs.
 * The native side installs QuickJS sandbox JSI bindings into the host runtime.
 */
import type { TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

export interface Spec extends TurboModule {
  /**
   * Install sandbox JSI bindings for the given engine.
   * @param engine - "quickjs" (only option on Windows)
   * @returns true if installation succeeded
   */
  installEngine(engine: string): boolean;

  /**
   * Install sandbox JSI bindings with auto-detection.
   * On Windows this always installs QuickJS.
   * @returns true if installation succeeded
   */
  install(): boolean;
}

export default TurboModuleRegistry.get<Spec>('RillSandboxNative');
