package com.rill.demo

import android.os.Bundle
import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate

class MainActivity : ReactActivity() {

    override fun getMainComponentName(): String = "RillDemo"

    override fun createReactActivityDelegate(): ReactActivityDelegate =
        object : DefaultReactActivityDelegate(this, mainComponentName, fabricEnabled) {
            override fun getLaunchOptions(): Bundle? {
                val extras = intent?.extras ?: return null
                val launchOptions = Bundle()

                if (extras.getBoolean("rillE2E", false)) {
                    launchOptions.putBoolean("rillE2E", true)
                }

                extras.getString("rillSandbox")?.let { sandbox ->
                    launchOptions.putString("rillSandbox", sandbox)
                }

                return if (launchOptions.isEmpty) null else launchOptions
            }
        }
}
