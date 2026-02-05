/*
 * Minimal leak test to isolate the source of memory leak
 */

#include "../src/QuickJSRuntime.h"
#include "../src/QuickJSRuntimeFactory.h"
#include "../src/QuickJSSandboxJSI.h"
#include <iostream>

using namespace facebook;

// Test 1: Just create and destroy host runtime (no sandbox)
void testHostRuntimeOnly() {
  std::cout << "\n=== Test 1: Host Runtime Only ===" << std::endl;
  auto runtime = qjs::createQuickJSRuntime("");
  // Do nothing, just destroy
  std::cout << "Destroying host runtime..." << std::endl;
}

// Test 2: Create host runtime with console
void testHostRuntimeWithConsole() {
  std::cout << "\n=== Test 2: Host Runtime + Console ===" << std::endl;
  auto runtime = qjs::createQuickJSRuntime("");

  // Install console
  auto console = jsi::Object(*runtime);
  auto log = jsi::Function::createFromHostFunction(
      *runtime, jsi::PropNameID::forAscii(*runtime, "log"), 1,
      [](jsi::Runtime &rt, const jsi::Value &, const jsi::Value *args,
         size_t count) -> jsi::Value {
        for (size_t i = 0; i < count; i++) {
          if (args[i].isString()) {
            std::cout << args[i].asString(rt).utf8(rt);
          }
        }
        std::cout << std::endl;
        return jsi::Value::undefined();
      });
  console.setProperty(*runtime, "log", std::move(log));
  runtime->global().setProperty(*runtime, "console", std::move(console));

  std::cout << "Destroying host runtime with console..." << std::endl;
}

// Test 3: Create host runtime + sandbox module (no usage)
void testSandboxModuleInstall() {
  std::cout << "\n=== Test 3: Sandbox Module Install Only ===" << std::endl;
  auto runtime = qjs::createQuickJSRuntime("");
  quickjs_sandbox::QuickJSSandboxModule::install(*runtime);
  std::cout << "Destroying after sandbox module install..." << std::endl;
}

// Test 3b: Create just a HostObject (no sandbox)
void testHostObjectOnly() {
  std::cout << "\n=== Test 3b: HostObject Only ===" << std::endl;
  auto runtime = qjs::createQuickJSRuntime("");

  // Create a simple HostObject
  class SimpleHostObject : public jsi::HostObject {
  public:
    jsi::Value get(jsi::Runtime &rt, const jsi::PropNameID &name) override {
      return jsi::Value::undefined();
    }
    void set(jsi::Runtime &, const jsi::PropNameID &,
             const jsi::Value &) override {}
    std::vector<jsi::PropNameID> getPropertyNames(jsi::Runtime &rt) override {
      return {};
    }
  };

  auto hostObj = std::make_shared<SimpleHostObject>();
  jsi::Object obj = jsi::Object::createFromHostObject(*runtime, hostObj);
  runtime->global().setProperty(*runtime, "testHostObj", std::move(obj));

  std::cout << "Destroying after HostObject creation..." << std::endl;
}

// Test 3c: Access HostObject property (triggers get)
void testHostObjectAccess() {
  std::cout << "\n=== Test 3c: HostObject Access ===" << std::endl;
  auto runtime = qjs::createQuickJSRuntime("");

  class SimpleHostObject : public jsi::HostObject {
  public:
    jsi::Value get(jsi::Runtime &rt, const jsi::PropNameID &name) override {
      return jsi::Value(42);
    }
    void set(jsi::Runtime &, const jsi::PropNameID &,
             const jsi::Value &) override {}
    std::vector<jsi::PropNameID> getPropertyNames(jsi::Runtime &rt) override {
      return {};
    }
  };

  auto hostObj = std::make_shared<SimpleHostObject>();
  jsi::Object obj = jsi::Object::createFromHostObject(*runtime, hostObj);
  runtime->global().setProperty(*runtime, "testHostObj", std::move(obj));

  // Access a property
  auto buffer = std::make_shared<jsi::StringBuffer>("testHostObj.foo");
  runtime->evaluateJavaScript(buffer, "test.js");

  std::cout << "Destroying after HostObject access..." << std::endl;
}

// Test 35: Access HostObject property multiple times
void testHostObjectMultipleAccess() {
  std::cout << "\n=== Test 35: HostObject Multiple Access ===" << std::endl;
  auto runtime = qjs::createQuickJSRuntime("");

  class SimpleHostObject : public jsi::HostObject {
  public:
    jsi::Value get(jsi::Runtime &rt, const jsi::PropNameID &name) override {
      return jsi::Value(42);
    }
    void set(jsi::Runtime &, const jsi::PropNameID &,
             const jsi::Value &) override {}
    std::vector<jsi::PropNameID> getPropertyNames(jsi::Runtime &rt) override {
      return {};
    }
  };

  auto hostObj = std::make_shared<SimpleHostObject>();
  jsi::Object obj = jsi::Object::createFromHostObject(*runtime, hostObj);
  runtime->global().setProperty(*runtime, "testHostObj", std::move(obj));

  // Access same property 10 times
  auto buffer = std::make_shared<jsi::StringBuffer>(
      "for (var i = 0; i < 10; i++) { testHostObj.foo; }");
  runtime->evaluateJavaScript(buffer, "test.js");

  std::cout << "Destroying after 10 HostObject accesses..." << std::endl;
}

// Test 36: Access HostObject different properties
void testHostObjectDifferentProps() {
  std::cout << "\n=== Test 36: HostObject Different Properties ==="
            << std::endl;
  auto runtime = qjs::createQuickJSRuntime("");

  class SimpleHostObject : public jsi::HostObject {
  public:
    jsi::Value get(jsi::Runtime &rt, const jsi::PropNameID &name) override {
      return jsi::Value(42);
    }
    void set(jsi::Runtime &, const jsi::PropNameID &,
             const jsi::Value &) override {}
    std::vector<jsi::PropNameID> getPropertyNames(jsi::Runtime &rt) override {
      return {};
    }
  };

  auto hostObj = std::make_shared<SimpleHostObject>();
  jsi::Object obj = jsi::Object::createFromHostObject(*runtime, hostObj);
  runtime->global().setProperty(*runtime, "testHostObj", std::move(obj));

  // Access 5 different properties
  auto buffer = std::make_shared<jsi::StringBuffer>(
      "testHostObj.a; testHostObj.b; testHostObj.c; testHostObj.d; "
      "testHostObj.e;");
  runtime->evaluateJavaScript(buffer, "test.js");

  std::cout << "Destroying after 5 different property accesses..." << std::endl;
}

// Test 37: Two HostObjects, each accessed once
void testTwoHostObjects() {
  std::cout << "\n=== Test 37: Two HostObjects ===" << std::endl;
  auto runtime = qjs::createQuickJSRuntime("");

  class SimpleHostObject : public jsi::HostObject {
  public:
    jsi::Value get(jsi::Runtime &rt, const jsi::PropNameID &name) override {
      return jsi::Value(42);
    }
    void set(jsi::Runtime &, const jsi::PropNameID &,
             const jsi::Value &) override {}
    std::vector<jsi::PropNameID> getPropertyNames(jsi::Runtime &rt) override {
      return {};
    }
  };

  auto hostObj1 = std::make_shared<SimpleHostObject>();
  auto hostObj2 = std::make_shared<SimpleHostObject>();
  jsi::Object obj1 = jsi::Object::createFromHostObject(*runtime, hostObj1);
  jsi::Object obj2 = jsi::Object::createFromHostObject(*runtime, hostObj2);
  runtime->global().setProperty(*runtime, "testHostObj1", std::move(obj1));
  runtime->global().setProperty(*runtime, "testHostObj2", std::move(obj2));

  // Access one property on each
  auto buffer = std::make_shared<jsi::StringBuffer>(
      "testHostObj1.foo; testHostObj2.bar;");
  runtime->evaluateJavaScript(buffer, "test.js");

  std::cout << "Destroying after two HostObject accesses..." << std::endl;
}

// Test 3d: HostObject returning a function
void testHostObjectReturningFunction() {
  std::cout << "\n=== Test 3d: HostObject Returning Function ===" << std::endl;
  auto runtime = qjs::createQuickJSRuntime("");

  class FuncHostObject : public jsi::HostObject {
  public:
    jsi::Value get(jsi::Runtime &rt, const jsi::PropNameID &name) override {
      return jsi::Function::createFromHostFunction(
          rt, name, 0,
          [](jsi::Runtime &, const jsi::Value &, const jsi::Value *,
             size_t) -> jsi::Value { return jsi::Value(42); });
    }
    void set(jsi::Runtime &, const jsi::PropNameID &,
             const jsi::Value &) override {}
    std::vector<jsi::PropNameID> getPropertyNames(jsi::Runtime &rt) override {
      return {};
    }
  };

  auto hostObj = std::make_shared<FuncHostObject>();
  jsi::Object obj = jsi::Object::createFromHostObject(*runtime, hostObj);
  runtime->global().setProperty(*runtime, "testHostObj", std::move(obj));

  // Access a property that returns a function
  auto buffer = std::make_shared<jsi::StringBuffer>("testHostObj.myFunc");
  runtime->evaluateJavaScript(buffer, "test.js");

  std::cout << "Destroying after HostObject returning function..." << std::endl;
}

// Test 3e: Call function returned by HostObject
void testHostObjectCallFunction() {
  std::cout << "\n=== Test 3e: Call Function from HostObject ===" << std::endl;
  auto runtime = qjs::createQuickJSRuntime("");

  class FuncHostObject : public jsi::HostObject {
  public:
    jsi::Value get(jsi::Runtime &rt, const jsi::PropNameID &name) override {
      return jsi::Function::createFromHostFunction(
          rt, name, 0,
          [](jsi::Runtime &, const jsi::Value &, const jsi::Value *,
             size_t) -> jsi::Value { return jsi::Value(42); });
    }
    void set(jsi::Runtime &, const jsi::PropNameID &,
             const jsi::Value &) override {}
    std::vector<jsi::PropNameID> getPropertyNames(jsi::Runtime &rt) override {
      return {};
    }
  };

  auto hostObj = std::make_shared<FuncHostObject>();
  jsi::Object obj = jsi::Object::createFromHostObject(*runtime, hostObj);
  runtime->global().setProperty(*runtime, "testHostObj", std::move(obj));

  // Access and CALL the function
  auto buffer = std::make_shared<jsi::StringBuffer>("testHostObj.myFunc()");
  runtime->evaluateJavaScript(buffer, "test.js");

  std::cout << "Destroying after calling HostObject function..." << std::endl;
}

// Test 4: Create sandbox runtime (no context)
void testSandboxRuntimeOnly() {
  std::cout << "\n=== Test 4: Sandbox Runtime Only ===" << std::endl;
  auto runtime = qjs::createQuickJSRuntime("");
  quickjs_sandbox::QuickJSSandboxModule::install(*runtime);

  auto buffer = std::make_shared<jsi::StringBuffer>(
      "var sandbox = globalThis.__QuickJSSandboxJSI;"
      "var rt = sandbox.createRuntime();"
      "rt.dispose();");
  runtime->evaluateJavaScript(buffer, "test.js");

  std::cout << "Destroying after sandbox runtime creation..." << std::endl;
}

// Test 5: Create sandbox context (no eval)
void testSandboxContextOnly() {
  std::cout << "\n=== Test 5: Sandbox Context Only ===" << std::endl;
  auto runtime = qjs::createQuickJSRuntime("");
  quickjs_sandbox::QuickJSSandboxModule::install(*runtime);

  auto buffer = std::make_shared<jsi::StringBuffer>(
      "var sandbox = globalThis.__QuickJSSandboxJSI;"
      "var rt = sandbox.createRuntime();"
      "var ctx = rt.createContext();"
      "ctx.dispose();"
      "rt.dispose();");
  runtime->evaluateJavaScript(buffer, "test.js");

  std::cout << "Destroying after sandbox context creation..." << std::endl;
}

// Test 6: Sandbox with simple eval
void testSandboxSimpleEval() {
  std::cout << "\n=== Test 6: Sandbox Simple Eval ===" << std::endl;
  auto runtime = qjs::createQuickJSRuntime("");
  quickjs_sandbox::QuickJSSandboxModule::install(*runtime);

  auto buffer = std::make_shared<jsi::StringBuffer>(
      "var sandbox = globalThis.__QuickJSSandboxJSI;"
      "var rt = sandbox.createRuntime();"
      "var ctx = rt.createContext();"
      "ctx.eval('1 + 2');"
      "ctx.dispose();"
      "rt.dispose();");
  runtime->evaluateJavaScript(buffer, "test.js");

  std::cout << "Destroying after simple eval..." << std::endl;
}

// Test 7: Sandbox with host function
void testSandboxHostFunction() {
  std::cout << "\n=== Test 7: Sandbox Host Function ===" << std::endl;
  auto runtime = qjs::createQuickJSRuntime("");
  quickjs_sandbox::QuickJSSandboxModule::install(*runtime);

  auto buffer = std::make_shared<jsi::StringBuffer>(
      "var sandbox = globalThis.__QuickJSSandboxJSI;"
      "var rt = sandbox.createRuntime();"
      "var ctx = rt.createContext();"
      "ctx.inject('callback', function(x) { return x * 2; });"
      "ctx.eval('callback(21)');"
      "ctx.dispose();"
      "rt.dispose();");
  runtime->evaluateJavaScript(buffer, "test.js");

  std::cout << "Destroying after host function..." << std::endl;
}

// Test 8: Sandbox with guest function retrieved by host
void testSandboxGuestFunction() {
  std::cout << "\n=== Test 8: Sandbox Guest Function ===" << std::endl;
  auto runtime = qjs::createQuickJSRuntime("");
  quickjs_sandbox::QuickJSSandboxModule::install(*runtime);

  auto buffer = std::make_shared<jsi::StringBuffer>(
      "var sandbox = globalThis.__QuickJSSandboxJSI;"
      "var rt = sandbox.createRuntime();"
      "var ctx = rt.createContext();"
      "ctx.eval('function add(a, b) { return a + b; }');"
      "var add = ctx.extract('add');"
      "add(1, 2);"
      "ctx.dispose();"
      "rt.dispose();");
  runtime->evaluateJavaScript(buffer, "test.js");

  std::cout << "Destroying after guest function..." << std::endl;
}

// Test 9: Full test WITHOUT dispose
void testFullWithoutDispose() {
  std::cout << "\n=== Test 9: Full Test WITHOUT Dispose ===" << std::endl;
  auto runtime = qjs::createQuickJSRuntime("");
  quickjs_sandbox::QuickJSSandboxModule::install(*runtime);

  auto buffer = std::make_shared<jsi::StringBuffer>(
      "var sandbox = globalThis.__QuickJSSandboxJSI;"
      "var rt = sandbox.createRuntime();"
      "var ctx = rt.createContext();"
      "ctx.inject('callback', function(x) { return x * 2; });"
      "ctx.eval('callback(21)');"
      "ctx.eval('function add(a, b) { return a + b; }');"
      "var add = ctx.extract('add');"
      "add(1, 2);"
      // NO dispose calls!
  );
  runtime->evaluateJavaScript(buffer, "test.js");

  std::cout << "Destroying WITHOUT explicit dispose..." << std::endl;
}

// Test 100: Print sizeof various QuickJS structures
void testPrintSizes() {
  std::cout << "\n=== Test 100: Print Sizes ===" << std::endl;
  // We can't directly access JSObject etc from here, but we can check memory
  // usage
  auto runtimePtr = qjs::createQuickJSRuntime("");
  auto *runtime = dynamic_cast<qjs::QuickJSRuntime *>(runtimePtr.get());
  if (runtime) {
    auto info = runtime->getHeapInfo();
    std::cout << "Heap info:" << std::endl;
    for (const auto &[key, value] : info) {
      std::cout << "  " << key << " = " << value << std::endl;
    }
  }
}

// Test 101: Memory usage before/after HostObject creation and access
void testMemoryTracking() {
  std::cout << "\n=== Test 101: Memory Tracking ===" << std::endl;
  auto runtimePtr = qjs::createQuickJSRuntime("");
  auto *rt = dynamic_cast<qjs::QuickJSRuntime *>(runtimePtr.get());

  auto printMem = [&](const char *label) {
    if (rt) {
      auto info = rt->getHeapInfo();
      std::cout << label << ": malloc_size=" << info["malloc_size"]
                << std::endl;
    }
  };

  printMem("Initial");

  class SimpleHostObject : public jsi::HostObject {
  public:
    jsi::Value get(jsi::Runtime &, const jsi::PropNameID &) override {
      return jsi::Value(42);
    }
    void set(jsi::Runtime &, const jsi::PropNameID &,
             const jsi::Value &) override {}
    std::vector<jsi::PropNameID> getPropertyNames(jsi::Runtime &) override {
      return {};
    }
  };

  auto hostObj = std::make_shared<SimpleHostObject>();
  jsi::Object obj = jsi::Object::createFromHostObject(*runtimePtr, hostObj);
  runtimePtr->global().setProperty(*runtimePtr, "testHostObj", std::move(obj));

  printMem("After HostObject creation");

  // Access a property
  auto buffer = std::make_shared<jsi::StringBuffer>("testHostObj.foo");
  runtimePtr->evaluateJavaScript(buffer, "test.js");

  printMem("After first property access");

  // Access same property again
  runtimePtr->evaluateJavaScript(buffer, "test.js");

  printMem("After second property access");

  std::cout << "Destroying..." << std::endl;
}

int main(int argc, const char *argv[]) {
  (void)argc;
  (void)argv;

  std::cout << "==========================================" << std::endl;
  std::cout << "QuickJS Sandbox Leak Isolation Test" << std::endl;
  std::cout << "==========================================" << std::endl;

  int testNum = 0;
  if (argc > 1) {
    testNum = atoi(argv[1]);
  }

  try {
    switch (testNum) {
    case 1:
      testHostRuntimeOnly();
      break;
    case 2:
      testHostRuntimeWithConsole();
      break;
    case 3:
      testSandboxModuleInstall();
      break;
    case 31:
      testHostObjectOnly();
      break;
    case 32:
      testHostObjectAccess();
      break;
    case 33:
      testHostObjectReturningFunction();
      break;
    case 34:
      testHostObjectCallFunction();
      break;
    case 35:
      testHostObjectMultipleAccess();
      break;
    case 36:
      testHostObjectDifferentProps();
      break;
    case 37:
      testTwoHostObjects();
      break;
    case 4:
      testSandboxRuntimeOnly();
      break;
    case 5:
      testSandboxContextOnly();
      break;
    case 6:
      testSandboxSimpleEval();
      break;
    case 7:
      testSandboxHostFunction();
      break;
    case 8:
      testSandboxGuestFunction();
      break;
    case 9:
      testFullWithoutDispose();
      break;
    case 100:
      testPrintSizes();
      break;
    case 101:
      testMemoryTracking();
      break;
    case 104: {
      // Test 104: Check object without property access at all
      std::cout << "\n=== Test 104: HostObject without any eval ==="
                << std::endl;
      auto runtime = qjs::createQuickJSRuntime("");
      class H : public jsi::HostObject {
      public:
        jsi::Value get(jsi::Runtime &, const jsi::PropNameID &) override {
          return jsi::Value(42);
        }
        void set(jsi::Runtime &, const jsi::PropNameID &,
                 const jsi::Value &) override {}
        std::vector<jsi::PropNameID> getPropertyNames(jsi::Runtime &) override {
          return {};
        }
      };
      auto h = std::make_shared<H>();
      jsi::Object o = jsi::Object::createFromHostObject(*runtime, h);
      runtime->global().setProperty(*runtime, "h", std::move(o));
      // NO eval - just create the object
      std::cout << "Created HostObject, no eval" << std::endl;
      break;
    }
    case 105: {
      // Test 105: Just eval without any HostObject
      std::cout << "\n=== Test 105: Simple eval (no HostObject) ==="
                << std::endl;
      auto runtime = qjs::createQuickJSRuntime("");
      auto b = std::make_shared<jsi::StringBuffer>("1 + 2");
      runtime->evaluateJavaScript(b, "test.js");
      std::cout << "Simple eval done" << std::endl;
      break;
    }
    case 106: {
      // Test 106: Eval accessing a regular object property
      std::cout << "\n=== Test 106: Regular object property access ==="
                << std::endl;
      auto runtime = qjs::createQuickJSRuntime("");
      // Create regular object and set property
      auto b =
          std::make_shared<jsi::StringBuffer>("var obj = { foo: 42 }; obj.foo");
      runtime->evaluateJavaScript(b, "test.js");
      std::cout << "Regular object property access done" << std::endl;
      break;
    }
    case 107: {
      // Test 107: Eval accessing global property (non-HostObject)
      std::cout << "\n=== Test 107: Global property (non-HostObject) ==="
                << std::endl;
      auto runtime = qjs::createQuickJSRuntime("");
      runtime->global().setProperty(*runtime, "myVal", jsi::Value(42));
      auto b = std::make_shared<jsi::StringBuffer>("myVal");
      runtime->evaluateJavaScript(b, "test.js");
      std::cout << "Global property access done" << std::endl;
      break;
    }
    case 108: {
      // Test 108: Eval accessing a C++ Object (not HostObject)
      std::cout << "\n=== Test 108: C++ Object property access ==="
                << std::endl;
      auto runtime = qjs::createQuickJSRuntime("");
      jsi::Object obj(*runtime);
      obj.setProperty(*runtime, "foo", jsi::Value(42));
      runtime->global().setProperty(*runtime, "myObj", std::move(obj));
      auto b = std::make_shared<jsi::StringBuffer>("myObj.foo");
      runtime->evaluateJavaScript(b, "test.js");
      std::cout << "C++ Object property access done" << std::endl;
      break;
    }
    case 109: {
      // Test 109: HostObject property access via C++ API (not eval)
      std::cout << "\n=== Test 109: HostObject via C++ API ===" << std::endl;
      auto runtime = qjs::createQuickJSRuntime("");
      class H : public jsi::HostObject {
      public:
        jsi::Value get(jsi::Runtime &, const jsi::PropNameID &) override {
          return jsi::Value(42);
        }
        void set(jsi::Runtime &, const jsi::PropNameID &,
                 const jsi::Value &) override {}
        std::vector<jsi::PropNameID> getPropertyNames(jsi::Runtime &) override {
          return {};
        }
      };
      auto h = std::make_shared<H>();
      jsi::Object o = jsi::Object::createFromHostObject(*runtime, h);
      runtime->global().setProperty(*runtime, "h", std::move(o));
      // Access via C++ API instead of eval
      jsi::Object ho = runtime->global().getPropertyAsObject(*runtime, "h");
      jsi::Value v = ho.getProperty(*runtime, "foo");
      std::cout << "Got value: " << (v.isNumber() ? v.asNumber() : -1)
                << std::endl;
      break;
    }
    case 110: {
      // Test 110: Multiple evals to check if leak accumulates
      std::cout << "\n=== Test 110: Multiple simple evals ===" << std::endl;
      auto runtime = qjs::createQuickJSRuntime("");
      for (int i = 0; i < 10; i++) {
        auto b = std::make_shared<jsi::StringBuffer>("1 + 2");
        runtime->evaluateJavaScript(b, "test.js");
      }
      std::cout << "10 simple evals done" << std::endl;
      break;
    }
    case 111: {
      // Test 111: Single eval with longer code
      std::cout << "\n=== Test 111: Single eval with longer code ==="
                << std::endl;
      auto runtime = qjs::createQuickJSRuntime("");
      auto b = std::make_shared<jsi::StringBuffer>(
          "var x = 1; var y = 2; var z = x + y; z");
      runtime->evaluateJavaScript(b, "test.js");
      std::cout << "Longer code eval done" << std::endl;
      break;
    }
    case 112: {
      // Test 112: Eval with function definition
      std::cout << "\n=== Test 112: Eval with function ===" << std::endl;
      auto runtime = qjs::createQuickJSRuntime("");
      auto b = std::make_shared<jsi::StringBuffer>(
          "function add(a, b) { return a + b; }");
      runtime->evaluateJavaScript(b, "test.js");
      std::cout << "Function definition eval done" << std::endl;
      break;
    }
    case 103: {
      // Test 103: Access with numeric property (no atom interning)
      std::cout << "\n=== Test 103: Numeric Property Access ===" << std::endl;
      auto runtime = qjs::createQuickJSRuntime("");
      class H : public jsi::HostObject {
      public:
        jsi::Value get(jsi::Runtime &, const jsi::PropNameID &) override {
          return jsi::Value(42);
        }
        void set(jsi::Runtime &, const jsi::PropNameID &,
                 const jsi::Value &) override {}
        std::vector<jsi::PropNameID> getPropertyNames(jsi::Runtime &) override {
          return {};
        }
      };
      auto h = std::make_shared<H>();
      jsi::Object o = jsi::Object::createFromHostObject(*runtime, h);
      runtime->global().setProperty(*runtime, "h", std::move(o));
      // Access with numeric index
      auto b = std::make_shared<jsi::StringBuffer>("h[0]");
      runtime->evaluateJavaScript(b, "test.js");
      std::cout << "Accessed numeric property" << std::endl;
      break;
    }
    case 102: {
      // Test 102: Multiple runtimes to check static class issue
      std::cout << "\n=== Test 102: Multiple Runtimes ===" << std::endl;
      {
        std::cout << "Runtime 1:" << std::endl;
        auto runtime1 = qjs::createQuickJSRuntime("");
        class H1 : public jsi::HostObject {
        public:
          jsi::Value get(jsi::Runtime &, const jsi::PropNameID &) override {
            return jsi::Value(1);
          }
          void set(jsi::Runtime &, const jsi::PropNameID &,
                   const jsi::Value &) override {}
          std::vector<jsi::PropNameID>
          getPropertyNames(jsi::Runtime &) override {
            return {};
          }
        };
        auto h1 = std::make_shared<H1>();
        jsi::Object o1 = jsi::Object::createFromHostObject(*runtime1, h1);
        runtime1->global().setProperty(*runtime1, "h", std::move(o1));
        auto b1 = std::make_shared<jsi::StringBuffer>("h.x");
        runtime1->evaluateJavaScript(b1, "test.js");
        std::cout << "  Accessed property" << std::endl;
      }
      std::cout << "Runtime 1 destroyed" << std::endl;
      {
        std::cout << "Runtime 2:" << std::endl;
        auto runtime2 = qjs::createQuickJSRuntime("");
        class H2 : public jsi::HostObject {
        public:
          jsi::Value get(jsi::Runtime &, const jsi::PropNameID &) override {
            return jsi::Value(2);
          }
          void set(jsi::Runtime &, const jsi::PropNameID &,
                   const jsi::Value &) override {}
          std::vector<jsi::PropNameID>
          getPropertyNames(jsi::Runtime &) override {
            return {};
          }
        };
        auto h2 = std::make_shared<H2>();
        jsi::Object o2 = jsi::Object::createFromHostObject(*runtime2, h2);
        runtime2->global().setProperty(*runtime2, "h", std::move(o2));
        auto b2 = std::make_shared<jsi::StringBuffer>("h.x");
        runtime2->evaluateJavaScript(b2, "test.js");
        std::cout << "  Accessed property" << std::endl;
      }
      std::cout << "Runtime 2 destroyed" << std::endl;
      break;
    }
    default:
      std::cout << "Running all tests sequentially..." << std::endl;
      std::cout << "Use ./leak_test N to run specific test" << std::endl;
      std::cout << "Tests: 1,2,3,31,32,33,34,4,5,6,7,8,9" << std::endl;
      testHostRuntimeOnly();
      break;
    }
  } catch (const jsi::JSError &e) {
    std::cerr << "JS Error: " << e.getMessage() << std::endl;
    return 1;
  } catch (const std::exception &e) {
    std::cerr << "Error: " << e.what() << std::endl;
    return 1;
  }

  std::cout << "\nTest completed." << std::endl;
  return 0;
}
