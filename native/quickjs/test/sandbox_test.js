/**
 * QuickJS Sandbox Test Suite
 *
 * This test runs in the Host JS runtime and tests the sandbox functionality.
 * Both Host and Guest are JavaScript - this is the real usage scenario.
 */

(() => {
  // Skip test if JSI module is not available (e.g., running in Bun instead of React Native)
  if (typeof globalThis.__QuickJSSandboxJSI === 'undefined') {
    console.log('⊘ Skipping QuickJS native tests');
    console.log('  Reason: JSI module not available');
    console.log('  Environment: Non-React Native (Bun/Node.js)');
    console.log('  To run: Use standalone RN test project at tests/rn-integration/');
    return;
  }

  var testsRun = 0;
  var testsPassed = 0;
  var testsFailed = 0;

  function assert(condition, testName, message) {
    testsRun++;
    if (condition) {
      testsPassed++;
      console.log(`  ✓ ${testName}`);
    } else {
      testsFailed++;
      console.log(`  ✗ ${testName}${message ? ` - ${message}` : ''}`);
    }
  }

  function assertThrows(fn, testName) {
    testsRun++;
    try {
      fn();
      testsFailed++;
      console.log(`  ✗ ${testName} - expected exception`);
    } catch (_e) {
      testsPassed++;
      console.log(`  ✓ ${testName}`);
    }
  }

  console.log('\n=== QuickJS Sandbox Tests (JavaScript) ===\n');

  // 1. Module Installation
  console.log('1. Module Installation');
  var sandbox = globalThis.__QuickJSSandboxJSI;
  assert(typeof sandbox === 'object', 'Module installed on global');
  assert(typeof sandbox.isAvailable === 'function', 'isAvailable is a function');
  assert(sandbox.isAvailable() === true, 'isAvailable() returns true');

  // 2. Runtime & Context Creation
  console.log('\n2. Runtime & Context Creation');
  var runtime = sandbox.createRuntime();
  assert(typeof runtime === 'object', 'createRuntime() returns object');

  var ctx = runtime.createContext();
  assert(typeof ctx === 'object', 'createContext() returns object');
  assert(typeof ctx.eval === 'function', 'context has eval method');
  assert(typeof ctx.inject === 'function', 'context has inject method');
  assert(typeof ctx.extract === 'function', 'context has extract method');

  // 3. Code Evaluation
  console.log('\n3. Code Evaluation');
  assert(ctx.eval('1 + 2') === 3, "eval('1 + 2') returns 3");
  assert(ctx.eval("'hello' + ' world'") === 'hello world', 'eval string concatenation');

  ctx.eval('function add(a, b) { return a + b; }');
  assert(ctx.eval('add(10, 20)') === 30, 'Define and call function');

  var arr = ctx.eval('[1, 2, 3].map(function(x) { return x * 2; })');
  assert(Array.isArray(arr), 'Array map returns array');
  assert(
    arr.length === 3 && arr[0] === 2 && arr[1] === 4 && arr[2] === 6,
    'Array map values correct'
  );

  // 4. inject / extract
  console.log('\n4. inject / extract');
  ctx.inject('myNumber', 42);
  assert(ctx.extract('myNumber') === 42, 'inject/extract number');
  assert(ctx.eval('myNumber') === 42, 'eval can access inject value');

  ctx.inject('myString', 'test string');
  assert(ctx.extract('myString') === 'test string', 'inject/extract string');

  ctx.inject('myObj', { x: 10, y: 20 });
  assert(ctx.eval('myObj.x + myObj.y') === 30, 'inject/extract object');

  ctx.inject('myArray', [1, 2, 3]);
  assert(
    ctx.eval('myArray.reduce(function(a, b) { return a + b; }, 0)') === 6,
    'inject/extract array'
  );

  // 5. Host Function Callbacks (the key feature!)
  console.log('\n5. Host Function Callbacks');

  var callbackInvoked = false;
  var receivedValue = 0;
  ctx.inject('hostCallback', (val) => {
    callbackInvoked = true;
    receivedValue = val;
    return val * 2;
  });

  var result = ctx.eval('hostCallback(21)');
  assert(
    callbackInvoked && receivedValue === 21 && result === 42,
    'Host function called from sandbox'
  );

  ctx.inject('multiArg', (a, b, c, d, e) => a + b + c + d + e);
  assert(ctx.eval('multiArg(1, 2, 3, 4, 5)') === 15, 'Host function with multiple args');

  var _receivedObj = null;
  ctx.inject('objCallback', (obj) => {
    _receivedObj = obj;
    return obj.name === 'Alice' && obj.age === 30;
  });
  assert(
    ctx.eval("objCallback({ name: 'Alice', age: 30 })") === true,
    'Host function receiving object'
  );

  // 6. Bidirectional: Guest function called by Host
  console.log('\n6. Guest Functions Callable from Host');
  ctx.eval('function guestAdd(a, b) { return a + b; }');
  var guestAdd = ctx.extract('guestAdd');
  assert(typeof guestAdd === 'function', 'Can get guest function');
  assert(guestAdd(5, 7) === 12, 'Can call guest function from host');

  // 7. Sandbox Isolation
  console.log('\n7. Sandbox Isolation');

  globalThis.hostGlobal = 100;
  ctx.eval('hostGlobal = 999'); // Guest tries to modify
  assert(globalThis.hostGlobal === 100, "Sandbox doesn't modify host globals");

  var ctx2 = runtime.createContext();
  ctx.eval("var sandboxVar = 'context1'");
  ctx2.eval("var sandboxVar = 'context2'");
  assert(ctx.eval('sandboxVar') === 'context1', 'Context 1 isolated');
  assert(ctx2.eval('sandboxVar') === 'context2', 'Context 2 isolated');
  ctx2.dispose();

  // 8. Error Handling
  console.log('\n8. Error Handling');
  assertThrows(() => {
    ctx.eval('function { invalid');
  }, 'Syntax error is caught');
  assertThrows(() => {
    ctx.eval("throw new Error('test error')");
  }, 'Runtime error is caught');

  // 9. Disposal
  console.log('\n9. Disposal');
  var tempCtx = runtime.createContext();
  tempCtx.eval('var x = 1');
  tempCtx.dispose();
  assertThrows(() => {
    tempCtx.eval('x + 1');
  }, 'Disposed context throws error');

  // 10. Primitive Types - null, undefined, boolean
  console.log('\n10. Primitive Types');
  ctx.inject('myNull', null);
  assert(ctx.extract('myNull') === null, 'inject/extract null');
  assert(ctx.eval('myNull === null') === true, 'eval null comparison');

  ctx.inject('myUndef', undefined);
  assert(ctx.extract('myUndef') === undefined, 'inject/extract undefined');
  assert(ctx.eval('myUndef === undefined') === true, 'eval undefined comparison');

  ctx.inject('myTrue', true);
  ctx.inject('myFalse', false);
  assert(ctx.extract('myTrue') === true, 'inject/extract true');
  assert(ctx.extract('myFalse') === false, 'inject/extract false');
  assert(ctx.eval('myTrue && !myFalse') === true, 'eval boolean logic');

  // 11. Special Numbers - NaN, Infinity
  console.log('\n11. Special Numbers');
  ctx.inject('myNaN', NaN);
  assert(Number.isNaN(ctx.extract('myNaN')), 'inject/extract NaN');
  assert(ctx.eval('Number.isNaN(myNaN)') === true, 'eval NaN check');

  ctx.inject('myInf', Infinity);
  assert(ctx.extract('myInf') === Infinity, 'inject/extract Infinity');
  assert(ctx.eval('myInf === Infinity') === true, 'eval Infinity comparison');

  ctx.inject('myNegInf', -Infinity);
  assert(ctx.extract('myNegInf') === -Infinity, 'inject/extract -Infinity');

  // 12. BigInt (if supported)
  console.log('\n12. BigInt');
  try {
    // Test BigInt operations within sandbox (not crossing boundary)
    assert(ctx.eval('typeof BigInt') === 'function', 'BigInt function exists in sandbox');
    assert(ctx.eval('typeof BigInt(123)') === 'bigint', 'BigInt type in sandbox');
    assert(
      ctx.eval('BigInt(10) + BigInt(20) === BigInt(30)') === true,
      'BigInt arithmetic in sandbox'
    );
    // Test that BigInt preserves precision beyond Number.MAX_SAFE_INTEGER
    assert(
      ctx.eval("BigInt('9007199254740993') > BigInt('9007199254740992')") === true,
      'BigInt large number comparison'
    );
  } catch (e) {
    console.log(`  ⚠ BigInt tests skipped: ${e.message}`);
  }

  // 13. Nested Objects
  console.log('\n13. Nested Objects');
  var nested = {
    level1: {
      level2: {
        level3: {
          value: 'deep',
        },
      },
    },
  };
  ctx.inject('nested', nested);
  assert(ctx.eval('nested.level1.level2.level3.value') === 'deep', 'Deep nested object access');

  var deepResult = ctx.extract('nested');
  assert(deepResult.level1.level2.level3.value === 'deep', 'extract deep nested object');

  // 14. Arrays with Mixed Types
  console.log('\n14. Arrays with Mixed Types');
  var mixedArray = [1, 'two', true, null, undefined, { x: 10 }, [1, 2, 3]];
  ctx.inject('mixedArray', mixedArray);
  assert(ctx.eval('mixedArray[0]') === 1, 'Mixed array - number');
  assert(ctx.eval('mixedArray[1]') === 'two', 'Mixed array - string');
  assert(ctx.eval('mixedArray[2]') === true, 'Mixed array - boolean');
  assert(ctx.eval('mixedArray[3] === null') === true, 'Mixed array - null');
  assert(ctx.eval('mixedArray[4] === undefined') === true, 'Mixed array - undefined');
  assert(ctx.eval('mixedArray[5].x') === 10, 'Mixed array - object');
  assert(ctx.eval('mixedArray[6][1]') === 2, 'Mixed array - nested array');

  // 15. Functions as Values
  console.log('\n15. Functions as Values');
  ctx.eval("var objWithFunc = { greet: function(name) { return 'Hello, ' + name; } }");
  var objWithFunc = ctx.extract('objWithFunc');
  assert(typeof objWithFunc.greet === 'function', 'Object with function property');
  assert(objWithFunc.greet('World') === 'Hello, World', 'Call function from object');

  ctx.eval('var higherOrder = function(f, x) { return f(x * 2); }');
  var higherOrder = ctx.extract('higherOrder');
  assert(higherOrder((n) => n + 1, 5) === 11, 'Higher-order function');

  // 16. Host Callback with Various Return Types
  console.log('\n16. Host Callback Return Types');
  ctx.inject('returnNull', () => null);
  assert(ctx.eval('returnNull() === null') === true, 'Host callback returning null');

  ctx.inject('returnUndefined', () => undefined);
  assert(ctx.eval('returnUndefined() === undefined') === true, 'Host callback returning undefined');

  ctx.inject('returnBool', (b) => !b);
  assert(ctx.eval('returnBool(false)') === true, 'Host callback returning boolean');

  ctx.inject('returnArray', () => [1, 2, 3]);
  var retArr = ctx.eval('returnArray()');
  assert(Array.isArray(retArr) && retArr.length === 3, 'Host callback returning array');

  ctx.inject('returnObject', () => ({ a: 1, b: 2 }));
  assert(ctx.eval('returnObject().a + returnObject().b') === 3, 'Host callback returning object');

  // 17. Guest Callback Receiving Various Types
  console.log('\n17. Guest Callback Arguments');
  ctx.eval('function identity(x) { return x; }');
  var identity = ctx.extract('identity');
  assert(identity(null) === null, 'Guest function receives null');
  assert(identity(undefined) === undefined, 'Guest function receives undefined');
  assert(identity(true) === true, 'Guest function receives boolean');
  assert(identity(3.14) === 3.14, 'Guest function receives float');
  var identObj = identity({ test: 123 });
  assert(identObj && identObj.test === 123, 'Guest function receives object');

  // 18. Error Objects
  console.log('\n18. Error Objects');
  try {
    ctx.eval("throw new TypeError('custom type error')");
    assert(false, 'Should have thrown');
  } catch (e) {
    assert(
      e.message && e.message.indexOf('custom type error') !== -1,
      'TypeError caught with message'
    );
  }

  try {
    ctx.eval("throw new RangeError('out of range')");
    assert(false, 'Should have thrown');
  } catch (e) {
    assert(e.message && e.message.indexOf('out of range') !== -1, 'RangeError caught with message');
  }

  // 19. Date Objects
  console.log('\n19. Date Objects');
  ctx.eval('var myDate = new Date(2024, 0, 15)');
  var dateObj = ctx.extract('myDate');
  assert(dateObj instanceof Date || typeof dateObj === 'object', 'Date object retrieved');
  assert(ctx.eval('myDate.getFullYear()') === 2024, 'Date getFullYear');
  assert(ctx.eval('myDate.getMonth()') === 0, 'Date getMonth');
  assert(ctx.eval('myDate.getDate()') === 15, 'Date getDate');

  // 20. RegExp Objects
  console.log('\n20. RegExp Objects');
  ctx.eval('var myRegex = /hello\\s+world/i');
  assert(ctx.eval("myRegex.test('Hello World')") === true, 'RegExp test match');
  assert(ctx.eval("myRegex.test('goodbye')") === false, 'RegExp test no match');
  assert(ctx.eval("'Hello   World'.match(myRegex) !== null") === true, 'RegExp match');

  // 21. Map and Set (if supported)
  console.log('\n21. Map and Set');
  try {
    ctx.eval("var myMap = new Map(); myMap.set('key1', 'value1'); myMap.set('key2', 42);");
    assert(ctx.eval("myMap.get('key1')") === 'value1', 'Map get string value');
    assert(ctx.eval("myMap.get('key2')") === 42, 'Map get number value');
    assert(ctx.eval('myMap.size') === 2, 'Map size');

    ctx.eval('var mySet = new Set([1, 2, 3, 2, 1]);');
    assert(ctx.eval('mySet.size') === 3, 'Set size (duplicates removed)');
    assert(ctx.eval('mySet.has(2)') === true, 'Set has');
    assert(ctx.eval('mySet.has(5)') === false, 'Set has (not present)');
  } catch (e) {
    console.log(`  ⚠ Map/Set tests skipped: ${e.message}`);
  }

  // 22. TypedArrays (if supported)
  console.log('\n22. TypedArrays');
  try {
    ctx.eval('var uint8 = new Uint8Array([1, 2, 3, 255])');
    assert(ctx.eval('uint8.length') === 4, 'Uint8Array length');
    assert(ctx.eval('uint8[0]') === 1, 'Uint8Array element access');
    assert(ctx.eval('uint8[3]') === 255, 'Uint8Array max value');

    ctx.eval('var int32 = new Int32Array([100, -100, 2147483647])');
    assert(ctx.eval('int32.length') === 3, 'Int32Array length');
    assert(ctx.eval('int32[1]') === -100, 'Int32Array negative value');

    ctx.eval('var float64 = new Float64Array([1.5, 2.5, 3.14159])');
    assert(
      ctx.eval('float64[2]') > 3.14 && ctx.eval('float64[2]') < 3.15,
      'Float64Array precision'
    );
  } catch (e) {
    console.log(`  ⚠ TypedArray tests skipped: ${e.message}`);
  }

  // 23. Symbol (if supported)
  console.log('\n23. Symbol');
  try {
    ctx.eval("var sym1 = Symbol('test'); var sym2 = Symbol('test');");
    assert(ctx.eval('sym1 !== sym2') === true, 'Symbols are unique');
    assert(ctx.eval('typeof sym1') === 'symbol', 'typeof Symbol');

    ctx.eval("var symObj = {}; symObj[sym1] = 'symbol value';");
    assert(ctx.eval('symObj[sym1]') === 'symbol value', 'Symbol as object key');
  } catch (e) {
    console.log(`  ⚠ Symbol tests skipped: ${e.message}`);
  }

  // 24. Promise (basic, if supported)
  console.log('\n24. Promise (basic)');
  try {
    ctx.eval('var promiseResolved = false; var promiseValue = 0;');
    ctx.eval(
      'Promise.resolve(42).then(function(v) { promiseResolved = true; promiseValue = v; });'
    );
    assert(ctx.eval('typeof Promise') === 'function', 'Promise exists');
    assert(ctx.eval('typeof Promise.resolve') === 'function', 'Promise.resolve exists');
    assert(ctx.eval('typeof Promise.reject') === 'function', 'Promise.reject exists');
    assert(ctx.extract('promiseResolved') === true, 'Promise microtasks drain after eval');
    assert(ctx.extract('promiseValue') === 42, 'Promise microtask value is visible after eval');
  } catch (e) {
    console.log(`  ⚠ Promise tests skipped: ${e.message}`);
  }

  // 25. JSON serialization
  console.log('\n25. JSON Serialization');
  var jsonObj = { name: 'test', count: 42, active: true, items: [1, 2, 3] };
  ctx.inject('jsonObj', jsonObj);
  var jsonStr = ctx.eval('JSON.stringify(jsonObj)');
  assert(typeof jsonStr === 'string', 'JSON.stringify returns string');
  var parsed = JSON.parse(jsonStr);
  assert(parsed.name === 'test' && parsed.count === 42, 'JSON roundtrip preserves data');

  ctx.eval('var parsedInGuest = JSON.parse(\'{"x": 100, "y": 200}\')');
  assert(ctx.eval('parsedInGuest.x + parsedInGuest.y') === 300, 'JSON.parse in guest');

  // 26. Object with prototype methods
  console.log('\n26. Object Methods');
  ctx.eval('var arr = [3, 1, 4, 1, 5, 9, 2, 6]');
  assert(ctx.eval("arr.sort().join(',')") === '1,1,2,3,4,5,6,9', 'Array sort and join');
  assert(ctx.eval('arr.filter(function(x) { return x > 3; }).length') === 4, 'Array filter');
  assert(ctx.eval('arr.find(function(x) { return x > 5; })') === 6, 'Array find');
  assert(ctx.eval('arr.every(function(x) { return x > 0; })') === true, 'Array every');
  assert(ctx.eval('arr.some(function(x) { return x > 8; })') === true, 'Array some');

  // 27. String methods
  console.log('\n27. String Methods');
  ctx.inject('testStr', '  Hello, World!  ');
  assert(ctx.eval('testStr.trim()') === 'Hello, World!', 'String trim');
  assert(ctx.eval('testStr.toUpperCase().trim()') === 'HELLO, WORLD!', 'String toUpperCase');
  assert(ctx.eval('testStr.toLowerCase().trim()') === 'hello, world!', 'String toLowerCase');
  assert(ctx.eval("testStr.includes('World')") === true, 'String includes');
  assert(ctx.eval("testStr.indexOf('World')") === 9, 'String indexOf');
  assert(ctx.eval("testStr.split(',').length") === 2, 'String split');

  // 28. Math operations
  console.log('\n28. Math Operations');
  assert(ctx.eval('Math.floor(3.7)') === 3, 'Math.floor');
  assert(ctx.eval('Math.ceil(3.2)') === 4, 'Math.ceil');
  assert(ctx.eval('Math.round(3.5)') === 4, 'Math.round');
  assert(ctx.eval('Math.abs(-5)') === 5, 'Math.abs');
  assert(ctx.eval('Math.max(1, 5, 3)') === 5, 'Math.max');
  assert(ctx.eval('Math.min(1, 5, 3)') === 1, 'Math.min');
  assert(Math.abs(ctx.eval('Math.sqrt(2)') - Math.SQRT2) < 0.01, 'Math.sqrt');

  // 29. Empty and edge cases
  console.log('\n29. Edge Cases');
  ctx.inject('emptyStr', '');
  assert(ctx.extract('emptyStr') === '', 'Empty string');
  ctx.inject('emptyArr', []);
  var emptyArr = ctx.extract('emptyArr');
  assert(Array.isArray(emptyArr) && emptyArr.length === 0, 'Empty array');
  ctx.inject('emptyObj', {});
  var emptyObj = ctx.extract('emptyObj');
  assert(typeof emptyObj === 'object' && Object.keys(emptyObj).length === 0, 'Empty object');

  assert(ctx.eval('0') === 0, 'Zero');
  assert(ctx.eval('-0') === 0, 'Negative zero'); // Note: -0 === 0 in JS
  assert(ctx.eval("''") === '', 'Empty string literal');

  // 30. Execution timeout (wall-clock interrupt)
  console.log('\n30. Execution Timeout');
  var timeoutRt = sandbox.createRuntime({ timeout: 250 });
  var timeoutCtx = timeoutRt.createContext();
  var start = Date.now();
  var threw = false;
  var errMsg = '';
  try {
    timeoutCtx.eval('while (true) {}');
  } catch (e) {
    threw = true;
    errMsg = String(e?.message || e);
  }
  var elapsed = Date.now() - start;
  assert(threw, 'Infinite loop eval throws instead of hanging');
  assert(errMsg.indexOf('timed out') !== -1, 'Timeout error message is explicit', `got: ${errMsg}`);
  assert(elapsed >= 200, 'Interrupt fires no earlier than the deadline', `elapsed: ${elapsed}`);
  assert(elapsed < 5000, 'Interrupt fires promptly after the deadline', `elapsed: ${elapsed}`);
  assert(timeoutCtx.eval('1 + 1') === 2, 'Context stays usable after a timeout');
  timeoutRt.dispose();

  var unlimitedRt = sandbox.createRuntime({ timeout: 0 });
  var unlimitedCtx = unlimitedRt.createContext();
  assert(
    unlimitedCtx.eval('var s = 0; for (var i = 0; i < 100000; i++) s += i; s') === 4999950000,
    'timeout: 0 means unlimited (long loop completes)'
  );
  unlimitedRt.dispose();

  // timeout: Infinity must mean "no limit" — not a bogus int64 deadline in
  // the past (double->int64 overflow) that kills every non-trivial eval.
  var infinityRt = sandbox.createRuntime({ timeout: Infinity });
  var infinityCtx = infinityRt.createContext();
  assert(
    infinityCtx.eval('var s = 0; for (var i = 0; i < 100000; i++) s += i; s') === 4999950000,
    'timeout: Infinity means unlimited (long loop completes)'
  );
  infinityRt.dispose();

  // dispose() must return even when a timed-out tenant left a self-requeueing
  // promise job in the queue (the drain loop is bounded, leftovers are freed
  // with the runtime).
  var drainRt = sandbox.createRuntime({ timeout: 200 });
  var drainCtx = drainRt.createContext();
  try {
    drainCtx.eval(
      'Promise.resolve().then(function f() { Promise.resolve().then(f); }); while (true) {}'
    );
  } catch (_e) {
    // expected: eval times out; the self-requeueing job stays queued
  }
  var disposeStart = Date.now();
  drainRt.dispose();
  assert(
    Date.now() - disposeStart < 5000,
    'dispose() returns despite a self-requeueing pending job'
  );

  // 31. Heap quota (maxHeapBytes -> JS_SetMemoryLimit)
  console.log('\n31. Heap Quota');
  var quotaRt = sandbox.createRuntime({ maxHeapBytes: 8 * 1024 * 1024 });
  var quotaCtx = quotaRt.createContext();
  var oomThrew = false;
  var oomMsg = '';
  try {
    quotaCtx.eval('var big = new Uint8Array(64 * 1024 * 1024); big.length');
  } catch (e) {
    oomThrew = true;
    oomMsg = String(e?.message || e);
  }
  assert(oomThrew, 'Allocation beyond maxHeapBytes throws', `got: ${oomMsg}`);
  assert(quotaCtx.eval('1 + 1') === 2, 'Context stays usable after quota OOM');
  assert(
    quotaCtx.eval('new Uint8Array(1024 * 1024).length') === 1048576,
    'Small allocations still work under the quota'
  );
  quotaRt.dispose();

  var defaultHeapRt = sandbox.createRuntime({});
  var defaultHeapCtx = defaultHeapRt.createContext();
  assert(
    defaultHeapCtx.eval('new Uint8Array(64 * 1024 * 1024).length') === 67108864,
    'Default heap limit still allows a 64MB allocation'
  );
  defaultHeapRt.dispose();

  console.log('\n32. Binary values crossing the sandbox boundary');
  // An ArrayBuffer/TypedArray from the sandbox must arrive host-side as REAL
  // binary (bytes copied), never as the generic property-copy's empty object —
  // that silent destruction was the binary op-batch failure mode.
  var binRt = sandbox.createRuntime({});
  var binCtx = binRt.createContext();

  var gotBatch = null;
  binCtx.inject('sendBinary', (buf) => {
    gotBatch = buf;
  });
  binCtx.eval(
    'var ab = new ArrayBuffer(4); var w = new Uint8Array(ab); ' +
      'w[0] = 0x52; w[1] = 0x49; w[2] = 0x4c; w[3] = 0x4c; sendBinary(ab);'
  );
  assert(gotBatch instanceof ArrayBuffer, 'sandbox ArrayBuffer arrives as host ArrayBuffer');
  var gotBytes = gotBatch instanceof ArrayBuffer ? new Uint8Array(gotBatch) : null;
  assert(
    gotBytes &&
      gotBytes.length === 4 &&
      gotBytes[0] === 0x52 &&
      gotBytes[1] === 0x49 &&
      gotBytes[2] === 0x4c &&
      gotBytes[3] === 0x4c,
    'ArrayBuffer bytes survive the boundary intact'
  );

  var gotView = null;
  binCtx.inject('sendView', (v) => {
    gotView = v;
  });
  binCtx.eval('var backing = new Uint8Array([1, 2, 3, 4, 5]); sendView(backing.subarray(1, 4));');
  assert(gotView instanceof Uint8Array, 'sandbox Uint8Array arrives as host Uint8Array');
  assert(
    gotView && gotView.length === 3 && gotView[0] === 2 && gotView[1] === 3 && gotView[2] === 4,
    "only the view's byte window crosses, bytes intact"
  );

  var evalAb = binCtx.eval('new Uint8Array([9, 8, 7]).buffer');
  assert(
    evalAb instanceof ArrayBuffer && new Uint8Array(evalAb)[0] === 9,
    'eval-returned ArrayBuffer crosses intact'
  );

  var evalEmpty = binCtx.eval('new ArrayBuffer(0)');
  assert(
    evalEmpty instanceof ArrayBuffer && evalEmpty.byteLength === 0,
    'zero-length ArrayBuffer crosses as an empty ArrayBuffer'
  );

  console.log('\n33. Binary values crossing host -> sandbox');
  // The symmetric direction: a host capability that RETURNS an ArrayBuffer /
  // typed-array must reach the guest as real bytes, not the generic empty
  // object copy. The assertions run INSIDE the sandbox (eval returns a bool).
  binCtx.inject('getBytesAb', () => {
    var ab = new ArrayBuffer(3);
    var w = new Uint8Array(ab);
    w[0] = 1;
    w[1] = 2;
    w[2] = 3;
    return ab;
  });
  assert(
    binCtx.eval(
      'var v = getBytesAb();' +
        '(v instanceof ArrayBuffer) && v.byteLength === 3 && ' +
        'new Uint8Array(v)[0] === 1 && new Uint8Array(v)[2] === 3'
    ) === true,
    'host ArrayBuffer return arrives in sandbox as ArrayBuffer, bytes intact'
  );

  binCtx.inject('getView', () => new Uint8Array([5, 6, 7, 8]).subarray(1, 3));
  assert(
    binCtx.eval(
      'var v = getView();' +
        '(v instanceof Uint8Array) && v.length === 2 && v[0] === 6 && v[1] === 7'
    ) === true,
    'host Uint8Array view return arrives in sandbox as Uint8Array window, bytes intact'
  );

  binCtx.inject('getEmptyAb', () => new ArrayBuffer(0));
  assert(
    binCtx.eval('var v = getEmptyAb(); (v instanceof ArrayBuffer) && v.byteLength === 0') === true,
    'host zero-length ArrayBuffer return arrives as an empty ArrayBuffer'
  );

  // A merely view-SHAPED plain object with an out-of-range byteOffset must be
  // rejected by extractHostViewBytes (bounded in the double domain against the
  // real backing size) and fall through to the generic object copy — never a
  // UB size_t cast. 2**64 specifically defeats a naive static_cast<double>
  // (SIZE_MAX) upper bound, which rounds up to 2**64.
  binCtx.inject('getFakeView', () => ({
    constructor: { name: 'Uint8Array' },
    buffer: new ArrayBuffer(4),
    byteOffset: Math.pow(2, 64),
    byteLength: 2,
  }));
  assert(
    binCtx.eval(
      'var v = getFakeView();' +
        // Not real bytes: a plain object copy, NOT a Uint8Array / ArrayBuffer.
        '!(v instanceof Uint8Array) && !(v instanceof ArrayBuffer) && ' +
        'typeof v === "object" && v.byteLength === 2 && v.byteOffset === Math.pow(2,64)'
    ) === true,
    'fake view with byteOffset 2**64 is rejected, copied as a plain object (no UB cast)'
  );

  binRt.dispose();

  // Summary
  console.log('\n=== Test Summary ===');
  console.log(`Total: ${testsRun}`);
  console.log(`Passed: ${testsPassed}`);
  console.log(`Failed: ${testsFailed}`);

  if (testsFailed === 0) {
    console.log('\n✓ ALL TESTS PASSED\n');
  } else {
    console.log('\n✗ SOME TESTS FAILED\n');
  }

  // Return result for the C++ runner
  return testsFailed === 0;
})();
