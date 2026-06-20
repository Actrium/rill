/**
 * @format
 */

import {AppRegistry} from 'react-native';
import App from './App';

// Rill sandbox JSI bindings are auto-installed via RillSandboxNative's
// constructor swizzle on [RCTHost start]. No manual TurboModule loading needed.

AppRegistry.registerComponent('RillMacOSTest', () => App);
