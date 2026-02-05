# rill_post_install.rb – OPTIONAL Podfile post_install helper for react-native-macos 0.81.x bugs.
#
# In most cases you do NOT need this file.
# Rill applies the same fixes automatically via:
#   1) npm postinstall (scripts/rill_postinstall.js)
#   2) CocoaPods prepare_command in RillSandboxNative.podspec (runs during `pod install`)
#
# This helper exists for projects that intentionally disable `prepare_command`
# (or run `pod install` in an environment without Node), or for custom CocoaPods
# flows where you want to force the patch immediately in `post_install`.
#
# Usage in consumer Podfile:
#   require_relative 'node_modules/rill/scripts/rill_post_install'
#
#   post_install do |installer|
#     react_native_post_install(installer, react_native_macos_path)
#     rill_post_install(installer, react_native_path: react_native_macos_path)
#   end

def _rill_truthy?(value)
  return false if value.nil?
  v = value.to_s.strip.downcase
  v == '1' || v == 'true' || v == 'yes' || v == 'y' || v == 'on'
end

def rill_post_install(installer, react_native_path: nil)
  return unless react_native_path
  return if _rill_truthy?(ENV['RILL_SKIP_RN_MACOS_PATCH'])

  rn_abs = File.expand_path(react_native_path, installer.sandbox.project_path.dirname)

  # Version gate: only patch 0.81.x
  pkg_json = File.join(rn_abs, 'package.json')
  return unless File.exist?(pkg_json)
  version = File.read(pkg_json)[/"version"\s*:\s*"([^"]+)"/, 1]
  return unless version
  major, minor = version.split('.').map(&:to_i)
  return unless major == 0 && minor == 81

  _rill_patch_hermes_executor_factory(rn_abs)
  _rill_patch_hermes_instance(rn_abs)
end

# react-native-macos 0.81.x: HermesExecutorFactory.cpp missing <thread> include
# (macOS SDK 26.2+ C++ headers no longer transitively include <thread>)
def _rill_patch_hermes_executor_factory(rn_path)
  file = File.join(rn_path, 'ReactCommon/hermes/executor/HermesExecutorFactory.cpp')
  return unless File.exist?(file)

  content = File.read(file)
  return if content.include?('#include <thread>')

  content = content.sub(
    '#include "HermesExecutorFactory.h"',
    "#include \"HermesExecutorFactory.h\"\n\n#include <thread>"
  )
  File.write(file, content)
rescue StandardError => e
  warn "[rill post_install] WARN: cannot patch react-native-macos (#{e.class}: #{e.message}). " \
       "If using Yarn PnP/zipfs, try `yarn unplug react-native-macos` / nodeLinker=node-modules, " \
       "or set RILL_SKIP_RN_MACOS_PATCH=1 to skip."
end

# react-native-macos 0.81.x: HermesInstance.cpp registerForProfiling() crashes on macOS
# (SamplingProfiler is not supported on macOS, causes EXC_BAD_ACCESS)
def _rill_patch_hermes_instance(rn_path)
  file = File.join(rn_path, 'ReactCommon/react/runtime/hermes/HermesInstance.cpp')
  return unless File.exist?(file)

  content = File.read(file)
  return if content.include?('TARGET_OS_OSX')

  content = content.sub(
    "runtime_->registerForProfiling();",
    "#if !TARGET_OS_OSX\n    runtime_->registerForProfiling();\n#endif"
  )
  File.write(file, content)
rescue StandardError => e
  warn "[rill post_install] WARN: cannot patch react-native-macos (#{e.class}: #{e.message}). " \
       "If using Yarn PnP/zipfs, try `yarn unplug react-native-macos` / nodeLinker=node-modules, " \
       "or set RILL_SKIP_RN_MACOS_PATCH=1 to skip."
end
