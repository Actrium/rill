#import "AppDelegate.h"
#import <React/RCTBundleURLProvider.h>
#import <ReactAppDependencyProvider/RCTAppDependencyProvider.h>

// RillTestLogger - Native logging module for test output (stderr)
@interface RillTestLogger : NSObject <RCTBridgeModule>
@end

@implementation RillTestLogger

RCT_EXPORT_MODULE()

+ (BOOL)requiresMainQueueSetup {
  return NO;
}

// Use a blocking synchronous method so logs are flushed even if the app crashes.
RCT_EXPORT_BLOCKING_SYNCHRONOUS_METHOD(log:(NSString *)message)
{
  // Write directly to stderr (captured by terminal)
  fprintf(stderr, "%s\n", [message UTF8String]);
  fflush(stderr);
  return @YES;
}

@end

@implementation AppDelegate

- (void)applicationDidFinishLaunching:(NSNotification *)notification
{
  self.moduleName = @"RillMacOSTest";

  NSMutableDictionary *initialProps = [NSMutableDictionary new];
  NSString *sandboxTarget =
      [[NSProcessInfo processInfo] environment][@"RILL_SANDBOX_TARGET"];
  if (sandboxTarget != nil && [sandboxTarget length] > 0) {
    initialProps[@"rillSandbox"] = sandboxTarget;
  }
  self.initialProps = initialProps;
  self.dependencyProvider = [RCTAppDependencyProvider new];

  [super applicationDidFinishLaunching:notification];
}

- (NSURL *)sourceURLForBridge:(id)bridge
{
  return [self bundleURL];
}

- (NSURL *)bundleURL
{
  // Check for pre-bundled JS first (for non-Metro CI mode)
  NSBundle *main = [NSBundle mainBundle];
  NSURL *localBundle = [main URLForResource:@"main" withExtension:@"jsbundle"];
  if (localBundle) {
    return localBundle;
  }

#if DEBUG
  return [[RCTBundleURLProvider sharedSettings] jsBundleURLForBundleRoot:@"index"];
#else
  return [main URLForResource:@"main" withExtension:@"jsbundle"];
#endif
}

/// Enable Bridgeless mode (RCTHost-based architecture)
- (BOOL)bridgelessEnabled
{
  return YES;
}

/// Enable concurrent root (supported in Bridgeless mode)
- (BOOL)concurrentRootEnabled
{
  return YES;
}

@end
