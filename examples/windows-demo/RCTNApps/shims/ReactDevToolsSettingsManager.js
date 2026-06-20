/**
 * Windows shim for ReactDevToolsSettingsManager.
 * No-op implementation — react-native@0.81 ships .android.js and .ios.js
 * variants but no .windows.js or generic .js fallback.
 *
 * @format
 */

export function setGlobalHookSettings(settings) {}

export function getGlobalHookSettings() {
  return null;
}
