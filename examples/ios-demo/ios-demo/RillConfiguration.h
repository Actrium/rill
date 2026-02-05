//
//  RillConfiguration.h
//  ios-demo
//
//  Provides runtime configuration detection for rill mode and sandbox engine
//

#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

@interface RillConfiguration : NSObject

/// Returns the current mode name (always "Bridgeless")
+ (NSString *)modeName;

/// Returns the current sandbox engine name (e.g., "JSC", "Hermes", or "QuickJS")
+ (NSString *)sandboxEngineName;

/// Returns YES (always bridgeless in this demo)
+ (BOOL)isBridgeless;

/// Returns YES if using JSC sandbox
+ (BOOL)isJSCSandbox;

/// Returns YES if using Hermes sandbox
+ (BOOL)isHermesSandbox;

/// Returns YES if using QuickJS sandbox
+ (BOOL)isQuickJSSandbox;

@end

NS_ASSUME_NONNULL_END
