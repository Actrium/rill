//
//  ReactNativeFactory.h
//  ios-demo
//
//  Factory for creating React Native views with new architecture (bridgeless) support
//

#import <UIKit/UIKit.h>

NS_ASSUME_NONNULL_BEGIN

@interface ReactNativeFactory : NSObject

+ (instancetype)sharedInstance;

/// Creates a React Native root view for the given module
/// @param moduleName The name of the JS module to load
/// @param initialProperties Optional initial properties to pass to the module
- (UIView *)createRootViewWithModuleName:(NSString *)moduleName
                       initialProperties:(nullable NSDictionary *)initialProperties;

@end

NS_ASSUME_NONNULL_END
