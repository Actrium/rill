package com.rill.sandbox;

import androidx.annotation.NonNull;

import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;

public class RillSandboxNativeModule extends ReactContextBaseJavaModule {
  static {
    System.loadLibrary("rillsandbox");
  }

  public static final String NAME = "RillSandboxNative";
  private volatile boolean installed = false;

  private static native void nativeInstall(long runtimePtr);

  public RillSandboxNativeModule(ReactApplicationContext reactContext) {
    super(reactContext);
  }

  @NonNull
  @Override
  public String getName() {
    return NAME;
  }

  @Override
  public void initialize() {
    super.initialize();
    getReactApplicationContext().runOnJSQueueThread(() -> tryInstallOnJSQueue(5));
  }

  private void tryInstallOnJSQueue(int retriesLeft) {
    if (installed) {
      return;
    }

    long runtimePtr = getReactApplicationContext().getJavaScriptContextHolder().get();
    if (runtimePtr != 0) {
      nativeInstall(runtimePtr);
      installed = true;
      return;
    }

    if (retriesLeft > 0) {
      getReactApplicationContext().runOnJSQueueThread(() -> tryInstallOnJSQueue(retriesLeft - 1));
    }
  }
}
