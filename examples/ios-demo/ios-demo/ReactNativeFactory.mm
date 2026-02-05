//
//  ReactNativeFactory.mm
//  ios-demo
//
//  Factory for creating React Native views with new architecture (bridgeless) support.
//  Rill sandbox JSI bindings are auto-installed by RillSandboxNative's constructor swizzle.
//

#import "ReactNativeFactory.h"

#import <React/RCTBundleURLProvider.h>
#import <React-RCTAppDelegate/RCTRootViewFactory.h>
#import <React/RCTRootView.h>
#import <React/RCTDevMenu.h>

// Hermes Runtime Factory for bridgeless mode
#import <React/RCTHermesInstanceFactory.h>

// Import the protocol for JS runtime configuration
#import <React-RCTAppDelegate/RCTJSRuntimeConfiguratorProtocol.h>

// TurboModule support
#import <ReactCommon/RCTTurboModuleManager.h>
#import <React/CoreModulesPlugins.h>
#import <react/nativemodule/defaults/DefaultTurboModules.h>

// Feature flags for bridgeless mode (enables microtask queue in Hermes)
#import <react/featureflags/ReactNativeFeatureFlags.h>
#import <react/featureflags/ReactNativeFeatureFlagsOverridesOSSStable.h>

// Image and Network modules for proper initialization
#import <React/RCTImageLoader.h>
#import <React/RCTBundleAssetImageLoader.h>
#import <React/RCTGIFImageDecoder.h>
#import <React/RCTNetworking.h>
#import <React/RCTHTTPRequestHandler.h>
#import <React/RCTDataRequestHandler.h>
#import <React/RCTFileRequestHandler.h>

// Module class providers for Image and Network
#import <React/RCTImagePlugins.h>
#import <React/RCTNetworkPlugins.h>

// Sandbox bridge for performance measurement
#import "RillSandboxBridge.h"

@interface ReactNativeFactory () <RCTHostDelegate, RCTJSRuntimeConfiguratorProtocol, RCTTurboModuleManagerDelegate>
@property (nonatomic, strong) RCTRootViewFactory *rootViewFactory;
@end

@implementation ReactNativeFactory

+ (instancetype)sharedInstance {
    static ReactNativeFactory *instance = nil;
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{
        instance = [[ReactNativeFactory alloc] init];
    });
    return instance;
}

- (instancetype)init {
    self = [super init];
    if (self) {
        [self setupFeatureFlags];
        [self setupRootViewFactory];
    }
    return self;
}

- (void)setupFeatureFlags {
    // Enable bridgeless architecture feature flags (required for microtask queue in Hermes)
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{
        NSLog(@"[ios-demo] Setting up React Native feature flags for bridgeless mode");
        facebook::react::ReactNativeFeatureFlags::override(
            std::make_unique<facebook::react::ReactNativeFeatureFlagsOverridesOSSStable>());
    });
}

- (void)setupRootViewFactory {
    NSLog(@"[ios-demo] Setting up RCTRootViewFactory for bridgeless mode with Hermes");

    // Configure for bridgeless (new architecture) with Hermes engine
    RCTRootViewFactoryConfiguration *configuration = [[RCTRootViewFactoryConfiguration alloc]
        initWithBundleURLBlock:^NSURL * _Nullable {
            // Always check for embedded bundle first (allows offline testing)
            NSURL *bundleURL = [[NSBundle mainBundle] URLForResource:@"main" withExtension:@"jsbundle"];
            if (bundleURL && [[NSFileManager defaultManager] fileExistsAtPath:bundleURL.path]) {
                NSLog(@"[ios-demo] Using embedded bundle: %@", bundleURL);
                return bundleURL;
            }
            #if DEBUG
            NSLog(@"[ios-demo] No embedded bundle, using Metro dev server");
            return [[RCTBundleURLProvider sharedSettings] jsBundleURLForBundleRoot:@"index"];
            #else
            return nil;
            #endif
        }
        newArchEnabled:YES];

    // Set ourselves as the JS runtime configurator delegate (provides Hermes factory)
    configuration.jsRuntimeConfiguratorDelegate = self;

    // Initialize with ourselves as TurboModule delegate and host delegate
    _rootViewFactory = [[RCTRootViewFactory alloc] initWithTurboModuleDelegate:self
                                                                  hostDelegate:self
                                                                 configuration:configuration];

    NSLog(@"[ios-demo] RCTRootViewFactory initialized with Hermes");
}

- (UIView *)createRootViewWithModuleName:(NSString *)moduleName
                       initialProperties:(NSDictionary *)initialProperties {
    NSLog(@"[ios-demo] Creating root view for module: %@", moduleName);

    if (_rootViewFactory.reactHost == nil) {
        NSLog(@"[ios-demo] Pre-initializing React host");
#if RCT_DEV_MENU
        RCTDevMenuConfiguration *devMenuConfig = [[RCTDevMenuConfiguration alloc]
            initWithDevMenuEnabled:NO
               shakeGestureEnabled:NO
          keyboardShortcutsEnabled:NO];
#else
        RCTDevMenuConfiguration *devMenuConfig = [RCTDevMenuConfiguration defaultConfiguration];
#endif
        [_rootViewFactory initializeReactHostWithLaunchOptions:nil devMenuConfiguration:devMenuConfig];
    }

    UIView *rootView = [_rootViewFactory viewWithModuleName:moduleName
                                          initialProperties:initialProperties
                                              launchOptions:nil];

    return rootView;
}

#pragma mark - RCTHostDelegate

- (void)hostDidStart:(RCTHost *)host {
    NSLog(@"[ios-demo] RCTHost did start with Hermes engine (host=%@)", host);
}

#pragma mark - RCTJSRuntimeConfiguratorProtocol

- (JSRuntimeFactoryRef)createJSRuntimeFactory {
    NSLog(@"[ios-demo] Creating Hermes runtime factory");
    return jsrt_create_hermes_factory();
}

#pragma mark - RCTTurboModuleManagerDelegate

- (Class)getModuleClassFromName:(const char *)name {
    // RillPerformanceBridge: app-local TurboModule for performance measurement.
    // Must be returned here so TurboModuleManager can resolve NativeModules.RillPerformanceBridge.
    if (strcmp(name, "RillPerformanceBridge") == 0) {
        return RillSandboxBridge.class;
    }

    Class moduleClass = RCTCoreModulesClassProvider(name);
    if (moduleClass) {
        return moduleClass;
    }

    moduleClass = RCTNetworkClassProvider(name);
    if (moduleClass) {
        return moduleClass;
    }

    moduleClass = RCTImageClassProvider(name);
    if (moduleClass) {
        return moduleClass;
    }

    return nil;
}

- (id<RCTTurboModule>)getModuleInstanceFromClass:(Class)moduleClass {
    // Return the shared singleton for RillPerformanceBridge.
    if (moduleClass == RillSandboxBridge.class) {
        return (id<RCTTurboModule>)[RillSandboxBridge sharedInstance];
    }

    if (moduleClass == RCTImageLoader.class) {
        return (id<RCTTurboModule>)[[RCTImageLoader alloc] initWithRedirectDelegate:nil
            loadersProvider:^NSArray<id<RCTImageURLLoader>> *(RCTModuleRegistry *moduleRegistry) {
                return @[[RCTBundleAssetImageLoader new]];
            }
            decodersProvider:^NSArray<id<RCTImageDataDecoder>> *(RCTModuleRegistry *moduleRegistry) {
                return @[[RCTGIFImageDecoder new]];
            }];
    }

    if (moduleClass == RCTNetworking.class) {
        return (id<RCTTurboModule>)[[RCTNetworking alloc]
            initWithHandlersProvider:^NSArray<id<RCTURLRequestHandler>> *(RCTModuleRegistry *moduleRegistry) {
                return @[
                    [RCTHTTPRequestHandler new],
                    [RCTDataRequestHandler new],
                    [RCTFileRequestHandler new],
                ];
            }];
    }

    return [[moduleClass alloc] init];
}

- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:(const std::string &)name
                                                      jsInvoker:(std::shared_ptr<facebook::react::CallInvoker>)jsInvoker {
    return facebook::react::DefaultTurboModules::getTurboModule(name, jsInvoker);
}

@end
