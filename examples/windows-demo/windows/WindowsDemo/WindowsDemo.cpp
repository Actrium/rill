// WindowsDemo.cpp : Defines the entry point for the application.
//

#include "pch.h"
#include "WindowsDemo.h"

#include "AutolinkedNativeModules.g.h"

#include "NativeModules.h"

#include <stdio.h>
#include <exception>
#include <winrt/base.h>
#include <winrt/Windows.Storage.h>
#include <pathcch.h>

// Trace helper: write to rill_trace.txt in package LocalState folder (or D:\ fallback)
static char g_traceFilePath[MAX_PATH] = {};

static void initTracePath() {
  // Try AppX LocalState folder first
  try {
    auto localFolder = winrt::Windows::Storage::ApplicationData::Current().LocalFolder();
    auto path = localFolder.Path();
    char narrow[MAX_PATH];
    WideCharToMultiByte(CP_UTF8, 0, path.c_str(), -1, narrow, sizeof(narrow), nullptr, nullptr);
    snprintf(g_traceFilePath, sizeof(g_traceFilePath), "%s\\rill_trace.txt", narrow);
    return;
  } catch (...) {}
  // Fallback to D: drive
  strcpy_s(g_traceFilePath, "D:\\rill_abort_trace.txt");
}

static void trace(const char *msg) {
  if (g_traceFilePath[0] == 0) initTracePath();
  FILE *f = nullptr;
  fopen_s(&f, g_traceFilePath, "a");
  if (f) { fprintf(f, "%s\n", msg); fclose(f); }
  OutputDebugStringA(msg);
  OutputDebugStringA("\n");
}

// WinRT-aware terminate handler — catches winrt::hresult_error
static void rill_winrt_terminate_handler() {
  trace("[TERMINATE] std::terminate() called in WindowsDemo");
  try {
    auto ep = std::current_exception();
    if (!ep) {
      trace("[TERMINATE] No current exception (terminate called without active exception)");
      _exit(99);
    }
    std::rethrow_exception(ep);
  } catch (const winrt::hresult_error &e) {
    char buf[1024];
    snprintf(buf, sizeof(buf), "[TERMINATE] winrt::hresult_error: HRESULT=0x%08X",
             static_cast<uint32_t>(e.code()));
    trace(buf);
    // Convert wide message to narrow
    auto msg = e.message();
    char narrow[512];
    WideCharToMultiByte(CP_UTF8, 0, msg.c_str(), -1, narrow, sizeof(narrow), nullptr, nullptr);
    snprintf(buf, sizeof(buf), "[TERMINATE] Message: %s", narrow);
    trace(buf);
  } catch (const std::exception &e) {
    char buf[1024];
    snprintf(buf, sizeof(buf), "[TERMINATE] std::exception: %s", e.what());
    trace(buf);
  } catch (...) {
    trace("[TERMINATE] Unknown exception type (not winrt::hresult_error, not std::exception)");
  }
  _exit(99);
}

// A PackageProvider containing any turbo modules you define within this app project
struct CompReactPackageProvider
    : winrt::implements<CompReactPackageProvider, winrt::Microsoft::ReactNative::IReactPackageProvider> {
 public: // IReactPackageProvider
  void CreatePackage(winrt::Microsoft::ReactNative::IReactPackageBuilder const &packageBuilder) noexcept {
    AddAttributedModules(packageBuilder, true);
  }
};

// The entry point of the Win32 application
_Use_decl_annotations_ int CALLBACK WinMain(HINSTANCE instance, HINSTANCE, PSTR /* commandLine */, int showCmd) {
  // Earliest possible trace — raw file I/O, no WinRT, no CRT dependencies beyond stdio
  { FILE* f = nullptr;
    fopen_s(&f, "D:\\rill_early_trace.txt", "w");
    if (f) { fprintf(f, "WinMain entered\n"); fclose(f); }
  }

  // Install WinRT-aware terminate handler (overrides the one from quickjs compat header)
  std::set_terminate(rill_winrt_terminate_handler);

  try {
  // Initialize WinRT first (needed for trace path and class activation)
  winrt::init_apartment(winrt::apartment_type::single_threaded);
  // Now trace path can resolve AppX LocalState
  trace("[MAIN] WinMain entered, apartment initialized");

  // Log trace file location and exe path for diagnostics
  { char buf[512];
    snprintf(buf, sizeof(buf), "[MAIN] Trace file: %s", g_traceFilePath);
    trace(buf);
    WCHAR exePath[MAX_PATH];
    GetModuleFileNameW(NULL, exePath, MAX_PATH);
    char narrowExe[MAX_PATH];
    WideCharToMultiByte(CP_UTF8, 0, exePath, -1, narrowExe, sizeof(narrowExe), nullptr, nullptr);
    snprintf(buf, sizeof(buf), "[MAIN] Exe path: %s", narrowExe);
    trace(buf);
  }

  // Enable per monitor DPI scaling
  SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);

  // Find the path hosting the app exe file
  WCHAR appDirectory[MAX_PATH];
  GetModuleFileNameW(NULL, appDirectory, MAX_PATH);
  PathCchRemoveFileSpec(appDirectory, MAX_PATH);

  // Create a ReactNativeWin32App with the ReactNativeAppBuilder
  trace("[MAIN] Creating ReactNativeAppBuilder...");
  auto reactNativeWin32App{winrt::Microsoft::ReactNative::ReactNativeAppBuilder().Build()};
  trace("[MAIN] ReactNativeAppBuilder created");

  // Configure the initial InstanceSettings for the app's ReactNativeHost
  auto settings{reactNativeWin32App.ReactNativeHost().InstanceSettings()};
  // Register any autolinked native modules
  RegisterAutolinkedNativeModulePackages(settings.PackageProviders());
  // Register any native modules defined within this app project
  settings.PackageProviders().Append(winrt::make<CompReactPackageProvider>());
  trace("[MAIN] Package providers registered");

#if BUNDLE
  // Load the JS bundle from a file (not Metro):
  // Set the path (on disk) where the .bundle file is located
  settings.BundleRootPath(std::wstring(L"file://").append(appDirectory).append(L"\\Bundle\\").c_str());
  // Set the name of the bundle file (without the .bundle extension)
  settings.JavaScriptBundleFile(L"index.windows");
  // Disable hot reload
  settings.UseFastRefresh(false);
  trace("[MAIN] Bundle mode: static file");
#else
  // Load the JS bundle from Metro
  settings.JavaScriptBundleFile(L"index");
  // Enable hot reload
  settings.UseFastRefresh(true);
  trace("[MAIN] Bundle mode: Metro");
#endif
#if _DEBUG
  // For Debug builds — disable debugger/fast-refresh when using static bundle
#if BUNDLE
  settings.UseDirectDebugger(false);
  settings.UseDeveloperSupport(false);
#else
  settings.UseDirectDebugger(true);
  settings.UseDeveloperSupport(true);
#endif
#else
  // For Release builds:
  // Disable Direct Debugging of JS
  settings.UseDirectDebugger(false);
  // Disable the Developer Menu
  settings.UseDeveloperSupport(false);
#endif

  // Get the AppWindow so we can configure its initial title and size
  auto appWindow{reactNativeWin32App.AppWindow()};
  appWindow.Title(L"RillDemo");
  appWindow.Resize({600, 700});

  // Get the ReactViewOptions so we can set the initial RN component to load
  auto viewOptions{reactNativeWin32App.ReactViewOptions()};
  viewOptions.ComponentName(L"RillDemo");

  trace("[MAIN] About to call Start()...");
  // Start the app
  reactNativeWin32App.Start();
  trace("[MAIN] Start() returned normally");

  } catch (const winrt::hresult_error &e) {
    char buf[512];
    snprintf(buf, sizeof(buf), "[MAIN] winrt::hresult_error: HRESULT=0x%08X",
             static_cast<uint32_t>(e.code()));
    trace(buf);
    auto msg = e.message();
    char narrow[512];
    WideCharToMultiByte(CP_UTF8, 0, msg.c_str(), -1, narrow, sizeof(narrow), nullptr, nullptr);
    snprintf(buf, sizeof(buf), "[MAIN] Message: %s", narrow);
    trace(buf);
    return 1;
  } catch (const std::exception &e) {
    char buf[512];
    snprintf(buf, sizeof(buf), "[MAIN] std::exception: %s", e.what());
    trace(buf);
    return 1;
  } catch (...) {
    trace("[MAIN] Unknown exception caught");
    return 1;
  }

  return 0;
}
