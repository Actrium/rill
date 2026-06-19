//
//  RillSandboxBridge.mm
//  ios-demo
//
//  Native module for sandbox performance measurement.
//  Registered as "RillPerformanceBridge" to match the Android interface —
//  JS code uses NativeModules.RillPerformanceBridge on both platforms.
//

#import "RillSandboxBridge.h"
#import <RillSandboxNative/RillSandboxNativeTurboModule.h>
#import <QuartzCore/QuartzCore.h>
#import <mach/mach.h>

#include <jsi/jsi.h>
#include <atomic>

// React Native module support
#import <React/RCTBridgeModule.h>
#import <ReactCommon/RCTTurboModule.h>
#import <ReactCommon/RCTInteropTurboModule.h>

using namespace facebook;

// ---------------------------------------------------------------------------
// FPS tracker (main-thread CADisplayLink → atomic double)
// ---------------------------------------------------------------------------
@interface _RillFPSTracker : NSObject {
@public
    std::atomic<double> lastFPS;
    std::atomic<bool> tracking;
}
@end

@implementation _RillFPSTracker {
    CADisplayLink *_displayLink;
    CFTimeInterval _lastTimestamp;
    int _frameCount;
    CFTimeInterval _accumulator;
}

- (instancetype)init {
    self = [super init];
    if (self) {
        lastFPS = 0;
        tracking = false;
        _lastTimestamp = 0;
        _frameCount = 0;
        _accumulator = 0;
    }
    return self;
}

- (void)start {
    if (tracking.exchange(true)) return; // already started
    dispatch_async(dispatch_get_main_queue(), ^{
        self->_lastTimestamp = 0;
        self->_frameCount = 0;
        self->_accumulator = 0;
        self->lastFPS = 0;
        self->_displayLink = [CADisplayLink displayLinkWithTarget:self selector:@selector(_tick:)];
        [self->_displayLink addToRunLoop:[NSRunLoop mainRunLoop] forMode:NSRunLoopCommonModes];
    });
}

- (void)stop {
    tracking = false;
    dispatch_async(dispatch_get_main_queue(), ^{
        [self->_displayLink invalidate];
        self->_displayLink = nil;
    });
}

- (void)_tick:(CADisplayLink *)link {
    if (!tracking) return;
    CFTimeInterval ts = link.timestamp;
    if (_lastTimestamp > 0) {
        CFTimeInterval delta = ts - _lastTimestamp;
        _frameCount++;
        _accumulator += delta;
        if (_accumulator >= 0.5) {
            lastFPS = (double)_frameCount / _accumulator;
            _frameCount = 0;
            _accumulator = 0;
        }
    }
    _lastTimestamp = ts;
}

@end

// ---------------------------------------------------------------------------
// RillSandboxBridge — exposed to JS as "RillPerformanceBridge"
// ---------------------------------------------------------------------------

// Private RCTBridgeModule conformance (kept out of header for Swift compat).
@interface RillSandboxBridge () <RCTBridgeModule, RCTTurboModule>
@end

@implementation RillSandboxBridge {
    _RillFPSTracker *_fpsTracker;
}

// Register as "RillPerformanceBridge" so JS NativeModules.RillPerformanceBridge
// resolves to this module on both iOS and Android.
RCT_EXPORT_MODULE(RillPerformanceBridge)

+ (BOOL)requiresMainQueueSetup {
    return NO;
}

+ (instancetype)sharedInstance {
    static RillSandboxBridge *instance = nil;
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{
        instance = [[RillSandboxBridge alloc] init];
    });
    return instance;
}

- (instancetype)init {
    self = [super init];
    if (self) {
        _fpsTracker = [[_RillFPSTracker alloc] init];
    }
    return self;
}

#pragma mark - JS-exported methods (matching Android RillPerformanceBridge)

// ── Memory ──────────────────────────────────────────────────────────────────

RCT_EXPORT_BLOCKING_SYNCHRONOUS_METHOD(getMemoryUsage) {
    struct mach_task_basic_info info;
    mach_msg_type_number_t size = MACH_TASK_BASIC_INFO_COUNT;
    kern_return_t kr = task_info(mach_task_self(),
                                MACH_TASK_BASIC_INFO,
                                (task_info_t)&info,
                                &size);
    if (kr == KERN_SUCCESS) {
        return @((double)info.resident_size / 1024.0 / 1024.0);
    }
    return @(-1.0);
}

// ── FPS ─────────────────────────────────────────────────────────────────────

RCT_EXPORT_BLOCKING_SYNCHRONOUS_METHOD(startFPSTracking) {
    [_fpsTracker start];
    return @(YES);
}

RCT_EXPORT_BLOCKING_SYNCHRONOUS_METHOD(stopFPSTracking) {
    [_fpsTracker stop];
    return @(YES);
}

RCT_EXPORT_BLOCKING_SYNCHRONOUS_METHOD(getCurrentFPS) {
    return @(_fpsTracker->lastFPS.load());
}

// ── JSI Performance ─────────────────────────────────────────────────────────

RCT_EXPORT_BLOCKING_SYNCHRONOUS_METHOD(measureJSIRTT:(int)iterations) {
    return @([self _measureJSIRTT:iterations]);
}

RCT_EXPORT_BLOCKING_SYNCHRONOUS_METHOD(measureOpsPerSecond:(int)durationMs) {
    return @([self _measureOpsPerSecond:durationMs]);
}

RCT_EXPORT_BLOCKING_SYNCHRONOUS_METHOD(evalInSandbox:(NSString *)code engine:(NSString *)engine) {
    return @([self _evalInSandbox:code engine:engine]);
}

RCT_EXPORT_BLOCKING_SYNCHRONOUS_METHOD(evalBytecodeAsset:(NSString *)path engine:(NSString *)engine) {
    return @([self _evalBytecodeAsset:path engine:engine]);
}

// ── Asset reading ───────────────────────────────────────────────────────────

RCT_EXPORT_BLOCKING_SYNCHRONOUS_METHOD(readAsset:(NSString *)path) {
    if (path == nil || path.length == 0) return @"";

    // Split path into directory and filename components
    NSString *directory = [path stringByDeletingLastPathComponent];
    NSString *filename = [[path lastPathComponent] stringByDeletingPathExtension];
    NSString *ext = [path pathExtension];

    NSString *bundlePath = [[NSBundle mainBundle] pathForResource:filename
                                                          ofType:ext
                                                     inDirectory:directory];
    if (!bundlePath) return @"";

    NSError *error = nil;
    NSString *content = [NSString stringWithContentsOfFile:bundlePath
                                                 encoding:NSUTF8StringEncoding
                                                    error:&error];
    return content ?: @"";
}

// ── Test logging ────────────────────────────────────────────────────────────

RCT_EXPORT_BLOCKING_SYNCHRONOUS_METHOD(log:(NSString *)message) {
    NSLog(@"%@", message);
    fprintf(stderr, "%s\n", [message UTF8String]);
    fflush(stderr);
    return @(YES);
}

#pragma mark - Internal JSI methods

/// Get the host JSI runtime on-demand (mirrors Android's javaScriptContextHolder.get()).
static jsi::Runtime *_getRuntime() {
    return RillSandboxNativeGetHostRuntime();
}

/// Resolve the sandbox JSI global name for a given engine hint, with fallback.
- (nullable NSString *)_resolveSandboxGlobal:(NSString *)engineHint runtime:(jsi::Runtime *)rt {
    if (rt == nullptr) return nil;

    try {
        jsi::Object global = rt->global();

        // Try hint first (matching Android's detectSandboxGlobal)
        if (engineHint.length > 0) {
            NSDictionary *map = @{
                @"hermes": @"__HermesSandboxJSI",
                @"quickjs": @"__QuickJSSandboxJSI",
                @"jsc":     @"__JSCSandboxJSI",
            };
            NSString *name = map[[engineHint lowercaseString]];
            if (name && global.hasProperty(*rt, [name UTF8String])) {
                return name;
            }
        }

        // Fallback: check all (same order as Android)
        for (NSString *candidate in @[@"__QuickJSSandboxJSI", @"__HermesSandboxJSI", @"__JSCSandboxJSI"]) {
            if (global.hasProperty(*rt, [candidate UTF8String])) {
                return candidate;
            }
        }
    } catch (...) {}

    return nil;
}

- (double)_measureJSIRTT:(int)iterations {
    jsi::Runtime *rt = _getRuntime();
    if (rt == nullptr || iterations <= 0) return -1;

    NSString *globalName = [self _resolveSandboxGlobal:@"" runtime:rt];
    if (!globalName) return -1;

    try {
        jsi::Object sandboxObj = rt->global()
            .getProperty(*rt, [globalName UTF8String])
            .asObject(*rt);

        if (!sandboxObj.hasProperty(*rt, "isAvailable")) return -1;

        jsi::Function isAvailableFn = sandboxObj.getProperty(*rt, "isAvailable")
            .asObject(*rt).asFunction(*rt);

        CFTimeInterval start = CACurrentMediaTime();
        for (int i = 0; i < iterations; i++) {
            isAvailableFn.call(*rt);
        }
        CFTimeInterval end = CACurrentMediaTime();

        return (end - start) * 1000.0 / iterations;
    } catch (const std::exception &e) {
        NSLog(@"[RillPerformanceBridge] measureJSIRTT: %s", e.what());
        return -1;
    } catch (...) {
        return -1;
    }
}

- (double)_measureOpsPerSecond:(int)durationMs {
    jsi::Runtime *rt = _getRuntime();
    if (rt == nullptr || durationMs <= 0) return -1;

    NSString *globalName = [self _resolveSandboxGlobal:@"" runtime:rt];
    if (!globalName) return -1;

    try {
        jsi::Object sandboxObj = rt->global()
            .getProperty(*rt, [globalName UTF8String])
            .asObject(*rt);

        if (!sandboxObj.hasProperty(*rt, "isAvailable")) return -1;

        jsi::Function isAvailableFn = sandboxObj.getProperty(*rt, "isAvailable")
            .asObject(*rt).asFunction(*rt);

        int opCount = 0;
        CFTimeInterval start = CACurrentMediaTime();
        CFTimeInterval deadline = start + (durationMs / 1000.0);

        while (CACurrentMediaTime() < deadline) {
            isAvailableFn.call(*rt);
            opCount++;
        }

        CFTimeInterval actualSec = CACurrentMediaTime() - start;
        return (double)opCount / actualSec;
    } catch (const std::exception &e) {
        NSLog(@"[RillPerformanceBridge] measureOpsPerSecond: %s", e.what());
        return -1;
    } catch (...) {
        return -1;
    }
}

- (double)_evalInSandbox:(NSString *)code engine:(NSString *)engine {
    jsi::Runtime *rt = _getRuntime();
    if (rt == nullptr || code.length == 0) return -1;

    NSString *globalName = [self _resolveSandboxGlobal:engine runtime:rt];
    if (!globalName) return -1;

    std::string globalNameStr = [globalName UTF8String];
    std::string codeStr = [code UTF8String];

    try {
        jsi::Object sandboxModule = rt->global()
            .getProperty(*rt, globalNameStr.c_str())
            .asObject(*rt);

        // createRuntime() → createContext() → eval(code)
        jsi::Object sandboxRuntime = sandboxModule
            .getProperty(*rt, "createRuntime").asObject(*rt).asFunction(*rt)
            .call(*rt).asObject(*rt);

        jsi::Object context = sandboxRuntime
            .getProperty(*rt, "createContext").asObject(*rt).asFunction(*rt)
            .call(*rt).asObject(*rt);

        jsi::Function evalFn = context
            .getProperty(*rt, "eval").asObject(*rt).asFunction(*rt);

        CFTimeInterval start = CACurrentMediaTime();
        evalFn.call(*rt, jsi::String::createFromUtf8(*rt, codeStr));
        CFTimeInterval end = CACurrentMediaTime();
        double execMs = (end - start) * 1000.0;

        // Dispose
        context.getProperty(*rt, "dispose").asObject(*rt).asFunction(*rt)
            .call(*rt);
        sandboxRuntime.getProperty(*rt, "dispose").asObject(*rt).asFunction(*rt)
            .call(*rt);

        return execMs;
    } catch (const jsi::JSError &e) {
        NSLog(@"[RillPerformanceBridge] evalInSandbox JSI error: %s", e.what());
        return -1;
    } catch (const std::exception &e) {
        NSLog(@"[RillPerformanceBridge] evalInSandbox: %s", e.what());
        return -1;
    } catch (...) {
        return -1;
    }
}

- (double)_evalBytecodeAsset:(NSString *)path engine:(NSString *)engine {
    jsi::Runtime *rt = _getRuntime();
    if (rt == nullptr || path == nil || path.length == 0) return -1;

    // Only Hermes sandbox exposes evalBytecode.
    NSString *globalName = [self _resolveSandboxGlobal:engine runtime:rt];
    if (!globalName || ![globalName isEqualToString:@"__HermesSandboxJSI"]) return -1;

    // Resolve asset path within app bundle
    NSString *directory = [path stringByDeletingLastPathComponent];
    NSString *filename = [[path lastPathComponent] stringByDeletingPathExtension];
    NSString *ext = [path pathExtension];

    NSString *bundlePath = [[NSBundle mainBundle] pathForResource:filename
                                                          ofType:ext
                                                     inDirectory:directory];
    if (!bundlePath) return -1;

    NSData *data = [NSData dataWithContentsOfFile:bundlePath];
    if (!data || data.length == 0) return -1;

    std::string globalNameStr = [globalName UTF8String];

    try {
        jsi::Object sandboxModule = rt->global()
            .getProperty(*rt, globalNameStr.c_str())
            .asObject(*rt);

        // createRuntime() → createContext()
        jsi::Object sandboxRuntime = sandboxModule
            .getProperty(*rt, "createRuntime").asObject(*rt).asFunction(*rt)
            .call(*rt).asObject(*rt);

        jsi::Object context = sandboxRuntime
            .getProperty(*rt, "createContext").asObject(*rt).asFunction(*rt)
            .call(*rt).asObject(*rt);

        jsi::Function evalBytecodeFn = context
            .getProperty(*rt, "evalBytecode").asObject(*rt).asFunction(*rt);

        // Create ArrayBuffer + copy bytes
        size_t bytecodeSize = (size_t)data.length;
        jsi::ArrayBuffer arrayBuffer = rt->global()
            .getPropertyAsFunction(*rt, "ArrayBuffer")
            .callAsConstructor(*rt, static_cast<int>(bytecodeSize))
            .asObject(*rt)
            .getArrayBuffer(*rt);
        memcpy(arrayBuffer.data(*rt), data.bytes, bytecodeSize);

        CFTimeInterval start = CACurrentMediaTime();
        evalBytecodeFn.call(*rt, arrayBuffer);
        CFTimeInterval end = CACurrentMediaTime();
        double execMs = (end - start) * 1000.0;

        // Dispose
        context.getProperty(*rt, "dispose").asObject(*rt).asFunction(*rt)
            .call(*rt);
        sandboxRuntime.getProperty(*rt, "dispose").asObject(*rt).asFunction(*rt)
            .call(*rt);

        return execMs;
    } catch (const jsi::JSError &e) {
        NSLog(@"[RillPerformanceBridge] evalBytecodeAsset JSI error: %s", e.what());
        return -1;
    } catch (const std::exception &e) {
        NSLog(@"[RillPerformanceBridge] evalBytecodeAsset: %s", e.what());
        return -1;
    } catch (...) {
        return -1;
    }
}

#pragma mark - RCTTurboModule

- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:
    (const facebook::react::ObjCTurboModule::InitParams &)params {
    // Use ObjCInteropTurboModule (not the base ObjCTurboModule) so that
    // RCT_EXPORT methods are auto-discovered via the ObjC runtime.
    return std::make_shared<facebook::react::ObjCInteropTurboModule>(params);
}

@end
