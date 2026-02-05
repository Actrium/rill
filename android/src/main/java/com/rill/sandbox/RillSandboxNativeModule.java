package com.rill.sandbox;

import android.util.Log;

import androidx.annotation.NonNull;

import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;

public class RillSandboxNativeModule extends ReactContextBaseJavaModule {

    public static final String NAME = "RillSandboxNative";
    private static final String TAG = "RillSandboxNative";
    private static final String ENGINE_AUTO = "auto";
    private static final String ENGINE_ALL = "all";
    private static final String ENGINE_HERMES = "hermes";
    private static final String ENGINE_QUICKJS = "quickjs";

    static {
        try {
            System.loadLibrary("rillsandbox");
            Log.i(TAG, "Loaded native library rillsandbox");
        } catch (UnsatisfiedLinkError e) {
            Log.e(TAG, "Failed to load native library rillsandbox", e);
        }
    }

    public RillSandboxNativeModule(ReactApplicationContext reactContext) {
        super(reactContext);
    }

    @Override
    @NonNull
    public String getName() {
        return NAME;
    }

    @ReactMethod(isBlockingSynchronousMethod = true)
    public boolean install() {
        return installEngine(ENGINE_AUTO);
    }

    /**
     * Install sandbox JSI bindings into the current RN runtime.
     *
     * @param engine "hermes" | "quickjs" | "all" (default: "all")
     */
    @ReactMethod(isBlockingSynchronousMethod = true)
    public boolean installEngine(String engine) {
        try {
            long jsContextRef = getReactApplicationContext()
                    .getJavaScriptContextHolder()
                    .get();
            if (jsContextRef == 0) {
                Log.e(TAG, "JSI runtime pointer is null");
                return false;
            }
            String normalized = normalizeEngine(engine);
            nativeInstallEngine(jsContextRef, normalized);
            Log.i(TAG, "Installed sandbox JSI bindings (engine=" + normalized + ")");
            return true;
        } catch (Exception e) {
            Log.e(TAG, "Failed to install JSI bindings", e);
            return false;
        }
    }

    @Override
    public void initialize() {
        super.initialize();
        // In bridgeless mode, initialize() may not be called or the runtime
        // may not be ready yet. The JS entry point calls install() explicitly.
    }

    private String normalizeEngine(String engine) {
        String e = engine == null ? "" : engine.trim().toLowerCase();
        if (e.isEmpty() || ENGINE_AUTO.equals(e)) {
            String detected = readHostSandboxEngine();
            if (detected != null && !detected.isEmpty()) {
                e = detected;
            } else {
                // Preserve previous behavior if auto-detect fails.
                return ENGINE_ALL;
            }
        }

        if (ENGINE_HERMES.equals(e)) return ENGINE_HERMES;
        if (ENGINE_QUICKJS.equals(e)) return ENGINE_QUICKJS;
        if ("both".equals(e) || ENGINE_ALL.equals(e)) return ENGINE_ALL;
        // Unknown -> preserve previous behavior (install all)
        return ENGINE_ALL;
    }

    private String readHostSandboxEngine() {
        ReactApplicationContext ctx = getReactApplicationContext();
        String pkg = ctx.getPackageName();

        // Try applicationId first, then fall back to the namespace (which may
        // differ when productFlavors use applicationIdSuffix).
        String[] candidates = new String[] { pkg };
        try {
            android.content.pm.ApplicationInfo ai = ctx.getPackageManager()
                    .getApplicationInfo(pkg, android.content.pm.PackageManager.GET_META_DATA);
            // appComponentFactory is set to the namespace-based class by AGP
            // but the most reliable fallback is stripping the suffix:
            String ns = ai.className != null
                    ? ai.className.substring(0, ai.className.lastIndexOf('.'))
                    : null;
            if (ns != null && !ns.equals(pkg)) {
                candidates = new String[] { pkg, ns };
            }
        } catch (Throwable ignored) {}

        // Also try the MainApplication's package as a namespace hint
        String appClass = ctx.getApplicationInfo().className;
        String appPkg = appClass != null && appClass.contains(".")
                ? appClass.substring(0, appClass.lastIndexOf('.'))
                : null;

        for (String candidate : new String[] { pkg, appPkg }) {
            if (candidate == null || candidate.isEmpty()) continue;
            try {
                Class<?> buildConfig = Class.forName(candidate + ".BuildConfig");
                Object value = buildConfig.getField("SANDBOX_ENGINE").get(null);
                if (value instanceof String) {
                    return ((String) value).trim().toLowerCase();
                }
            } catch (Throwable ignored) {}
        }

        Log.w(TAG, "Could not read host BuildConfig.SANDBOX_ENGINE (auto -> all)");
        return null;
    }

    private static native void nativeInstallEngine(long jsiRuntimeRef, String engine);
}
