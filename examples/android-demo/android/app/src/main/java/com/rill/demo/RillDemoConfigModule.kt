package com.rill.demo

import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.module.annotations.ReactModule

@ReactModule(name = RillDemoConfigModule.NAME)
class RillDemoConfigModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    companion object {
        const val NAME = "RillDemoConfig"
    }

    override fun getName(): String = NAME

    override fun getConstants(): Map<String, Any> = mapOf(
        "sandboxEngine" to BuildConfig.SANDBOX_ENGINE
    )
}
