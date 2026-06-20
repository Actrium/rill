package com.rill.demo

import android.os.Debug
import android.util.Log
import android.view.Choreographer
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.module.annotations.ReactModule
import java.io.BufferedReader
import java.io.InputStreamReader

@ReactModule(name = RillPerformanceBridge.NAME)
class RillPerformanceBridge(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    companion object {
        const val NAME = "RillPerformanceBridge"
        private const val TAG = "RillPerformanceBridge"
        private var nativeLoaded = false

        init {
            try {
                System.loadLibrary("appmodules")
                nativeLoaded = true
            } catch (e: UnsatisfiedLinkError) {
                Log.e(TAG, "Failed to load native library appmodules", e)
            }
        }
    }

    override fun getName(): String = NAME

    // ── Memory ──────────────────────────────────────────────────────────────

    @ReactMethod(isBlockingSynchronousMethod = true)
    fun getMemoryUsage(): Double {
        // Read VmRSS from /proc/self/status for consistency with iOS (resident_size).
        // This measures the process-level resident set size, not just heap allocations.
        try {
            val status = java.io.File("/proc/self/status").readText()
            val match = Regex("""VmRSS:\s+(\d+)\s+kB""").find(status)
            if (match != null) {
                return match.groupValues[1].toDouble() / 1024.0  // kB → MB
            }
        } catch (_: Exception) {}
        // Fallback: native heap + java heap
        val nativeHeap = Debug.getNativeHeapAllocatedSize().toDouble()
        val javaHeap = Runtime.getRuntime().totalMemory().toDouble() -
            Runtime.getRuntime().freeMemory().toDouble()
        return (nativeHeap + javaHeap) / (1024.0 * 1024.0)
    }

    // ── FPS ─────────────────────────────────────────────────────────────────

    @Volatile private var lastFrameTimeNanos: Long = 0
    @Volatile private var frameCount: Int = 0
    @Volatile private var fpsAccumulatorNanos: Long = 0
    @Volatile private var lastFPS: Double = 0.0
    @Volatile private var fpsTracking: Boolean = false

    private val frameCallback = object : Choreographer.FrameCallback {
        override fun doFrame(frameTimeNanos: Long) {
            if (!fpsTracking) return

            if (lastFrameTimeNanos > 0) {
                val deltaNanos = frameTimeNanos - lastFrameTimeNanos
                frameCount++
                fpsAccumulatorNanos += deltaNanos

                // Update FPS every ~500ms
                if (fpsAccumulatorNanos >= 500_000_000L) {
                    lastFPS = frameCount.toDouble() / (fpsAccumulatorNanos / 1_000_000_000.0)
                    frameCount = 0
                    fpsAccumulatorNanos = 0
                }
            }
            lastFrameTimeNanos = frameTimeNanos
            Choreographer.getInstance().postFrameCallback(this)
        }
    }

    @ReactMethod(isBlockingSynchronousMethod = true)
    fun startFPSTracking(): Boolean {
        if (fpsTracking) return true
        fpsTracking = true
        lastFrameTimeNanos = 0
        frameCount = 0
        fpsAccumulatorNanos = 0
        lastFPS = 0.0
        reactContext.currentActivity?.runOnUiThread {
            Choreographer.getInstance().postFrameCallback(frameCallback)
        }
        return true
    }

    @ReactMethod(isBlockingSynchronousMethod = true)
    fun stopFPSTracking(): Boolean {
        fpsTracking = false
        return true
    }

    @ReactMethod(isBlockingSynchronousMethod = true)
    fun getCurrentFPS(): Double = lastFPS

    // ── JSI Performance (JNI) ───────────────────────────────────────────────

    private fun getJSIRuntimePtr(): Long {
        return reactContext.javaScriptContextHolder?.get() ?: 0L
    }

    @ReactMethod(isBlockingSynchronousMethod = true)
    fun measureJSIRTT(iterations: Int): Double {
        if (!nativeLoaded) return -1.0
        val ptr = getJSIRuntimePtr()
        if (ptr == 0L) return -1.0
        return nativeMeasureJSIRTT(ptr, iterations)
    }

    @ReactMethod(isBlockingSynchronousMethod = true)
    fun measureOpsPerSecond(durationMs: Int): Double {
        if (!nativeLoaded) return -1.0
        val ptr = getJSIRuntimePtr()
        if (ptr == 0L) return -1.0
        return nativeMeasureOpsPerSecond(ptr, durationMs)
    }

    @ReactMethod(isBlockingSynchronousMethod = true)
    fun evalInSandbox(code: String, engine: String): Double {
        if (!nativeLoaded) return -1.0
        val ptr = getJSIRuntimePtr()
        if (ptr == 0L) return -1.0
        return nativeEvalInSandbox(ptr, code, engine)
    }

    // ── Asset reading ───────────────────────────────────────────────────────

    @ReactMethod(isBlockingSynchronousMethod = true)
    fun readAsset(path: String): String {
        return try {
            val inputStream = reactContext.assets.open(path)
            val reader = BufferedReader(InputStreamReader(inputStream))
            val content = reader.readText()
            reader.close()
            content
        } catch (e: Exception) {
            ""
        }
    }

    @ReactMethod(isBlockingSynchronousMethod = true)
    fun log(message: String): Boolean {
        Log.i("RILL_ANDROID_E2E", message)
        return true
    }

    // ── JNI declarations ────────────────────────────────────────────────────

    private external fun nativeMeasureJSIRTT(runtimePtr: Long, iterations: Int): Double
    private external fun nativeMeasureOpsPerSecond(runtimePtr: Long, durationMs: Int): Double
    private external fun nativeEvalInSandbox(runtimePtr: Long, code: String, engine: String): Double
}
