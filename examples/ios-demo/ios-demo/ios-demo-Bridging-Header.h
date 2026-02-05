//
//  ios-demo-Bridging-Header.h
//  ios-demo
//
//  Bridging header for React Native new architecture support and rill configuration
//

#import <React/RCTBundleURLProvider.h>
#import <React/RCTRootView.h>
#import <React/RCTBridge.h>
#import <React/RCTBridgeDelegate.h>

// New architecture support
#import "ReactNativeFactory.h"

// Rill configuration detection
#import "RillConfiguration.h"

