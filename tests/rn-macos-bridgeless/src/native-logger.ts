import { NativeModules } from 'react-native';

const { RillTestLogger } = NativeModules;

/**
 * Native logger that writes directly to stderr (captured by terminal).
 *
 * Uses the RillTestLogger native module (fprintf to stderr), falls back to
 * console.log when the native module is not available.
 */
export const nativeLog = (message: string): void => {
  if (RillTestLogger?.log) {
    RillTestLogger.log(message);
  } else {
    console.log(message);
  }
};
