//
//  RillSandboxBridge.h
//  ios-demo
//
//  Native module for sandbox performance measurement.
//  Registered as "RillPerformanceBridge" to match the Android module name.
//  JS code uses NativeModules.RillPerformanceBridge on both platforms.
//

#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

@interface RillSandboxBridge : NSObject

+ (instancetype)sharedInstance;

@end

NS_ASSUME_NONNULL_END
