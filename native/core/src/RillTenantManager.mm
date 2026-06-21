#include "RillTenantManager.h"
#include <stdexcept>
#import <Foundation/Foundation.h>

namespace rill::tenant_manager {

// Singleton instance
std::shared_ptr<RillTenantManager> RillTenantManager::instance_ = nullptr;

RillTenantManager::RillTenantManager(
    facebook::jsi::Runtime& hostRuntime,
    std::shared_ptr<facebook::react::CallInvoker> callInvoker)
    : hostRuntime_(&hostRuntime),
      callInvoker_(std::move(callInvoker)) {}

void RillTenantManager::install(
    facebook::jsi::Runtime& hostRuntime,
    std::shared_ptr<facebook::react::CallInvoker> callInvoker) {
  auto tenant_manager =
      std::shared_ptr<RillTenantManager>(
          new RillTenantManager(hostRuntime, std::move(callInvoker)));
  instance_ = tenant_manager;

  auto obj = facebook::jsi::Object::createFromHostObject(
      hostRuntime, tenant_manager);
  hostRuntime.global().setProperty(
      hostRuntime, "__RillTenantManager", std::move(obj));
}

RillTenantManager* RillTenantManager::instance() {
  return instance_.get();
}

// --- jsi::HostObject interface ---

facebook::jsi::Value RillTenantManager::get(
    facebook::jsi::Runtime& rt,
    const facebook::jsi::PropNameID& name) {
  auto propName = name.utf8(rt);

  if (propName == "createTenant") {
    return facebook::jsi::Function::createFromHostFunction(
        rt, name, 1,
        [this](facebook::jsi::Runtime& rt, const facebook::jsi::Value&,
               const facebook::jsi::Value* args, size_t count)
            -> facebook::jsi::Value {
          if (count < 1 || !args[0].isObject()) {
            throw facebook::jsi::JSError(rt, "createTenant requires a config object");
          }
          auto id = createTenant(rt, args[0].asObject(rt));
          return facebook::jsi::Value(static_cast<double>(id));
        });
  }

  if (propName == "destroyTenant") {
    return facebook::jsi::Function::createFromHostFunction(
        rt, name, 1,
        [this](facebook::jsi::Runtime& rt, const facebook::jsi::Value&,
               const facebook::jsi::Value* args, size_t count)
            -> facebook::jsi::Value {
          if (count < 1 || !args[0].isNumber()) {
            throw facebook::jsi::JSError(rt, "destroyTenant requires a tenant ID");
          }
          destroyTenant(static_cast<TenantId>(args[0].asNumber()));
          return facebook::jsi::Value::undefined();
        });
  }

  if (propName == "pauseTenant") {
    return facebook::jsi::Function::createFromHostFunction(
        rt, name, 1,
        [this](facebook::jsi::Runtime& rt, const facebook::jsi::Value&,
               const facebook::jsi::Value* args, size_t count)
            -> facebook::jsi::Value {
          if (count < 1 || !args[0].isNumber()) {
            throw facebook::jsi::JSError(rt, "pauseTenant requires a tenant ID");
          }
          pauseTenant(static_cast<TenantId>(args[0].asNumber()));
          return facebook::jsi::Value::undefined();
        });
  }

  if (propName == "resumeTenant") {
    return facebook::jsi::Function::createFromHostFunction(
        rt, name, 1,
        [this](facebook::jsi::Runtime& rt, const facebook::jsi::Value&,
               const facebook::jsi::Value* args, size_t count)
            -> facebook::jsi::Value {
          if (count < 1 || !args[0].isNumber()) {
            throw facebook::jsi::JSError(rt, "resumeTenant requires a tenant ID");
          }
          resumeTenant(static_cast<TenantId>(args[0].asNumber()));
          return facebook::jsi::Value::undefined();
        });
  }

  if (propName == "loadBundle") {
    return facebook::jsi::Function::createFromHostFunction(
        rt, name, 2,
        [this](facebook::jsi::Runtime& rt, const facebook::jsi::Value&,
               const facebook::jsi::Value* args, size_t count)
            -> facebook::jsi::Value {
          if (count < 2 || !args[0].isNumber() || !args[1].isString()) {
            throw facebook::jsi::JSError(
                rt, "loadBundle requires (tenantId: number, code: string)");
          }
          auto id = static_cast<TenantId>(args[0].asNumber());
          auto code = args[1].asString(rt).utf8(rt);
          loadBundle(id, code);
          return facebook::jsi::Value::undefined();
        });
  }

  if (propName == "sendEvent") {
    return facebook::jsi::Function::createFromHostFunction(
        rt, name, 3,
        [this](facebook::jsi::Runtime& rt, const facebook::jsi::Value&,
               const facebook::jsi::Value* args, size_t count)
            -> facebook::jsi::Value {
          if (count < 2 || !args[0].isNumber() || !args[1].isString()) {
            throw facebook::jsi::JSError(
                rt,
                "sendEvent requires (tenantId: number, name: string, payload?)");
          }
          auto id = static_cast<TenantId>(args[0].asNumber());
          auto eventName = args[1].asString(rt).utf8(rt);
          // jsi::Value is non-copyable; avoid ternary that would try to copy args[2].
          if (count > 2) {
            sendEvent(id, eventName, rt, args[2]);
          } else {
            sendEvent(id, eventName, rt, facebook::jsi::Value::undefined());
          }
          return facebook::jsi::Value::undefined();
        });
  }

  if (propName == "broadcast") {
    return facebook::jsi::Function::createFromHostFunction(
        rt, name, 2,
        [this](facebook::jsi::Runtime& rt, const facebook::jsi::Value&,
               const facebook::jsi::Value* args, size_t count)
            -> facebook::jsi::Value {
          if (count < 1 || !args[0].isString()) {
            throw facebook::jsi::JSError(
                rt, "broadcast requires (name: string, payload?)");
          }
          auto eventName = args[0].asString(rt).utf8(rt);
          // jsi::Value is non-copyable; avoid ternary that would try to copy args[1].
          if (count > 1) {
            broadcast(eventName, rt, args[1]);
          } else {
            broadcast(eventName, rt, facebook::jsi::Value::undefined());
          }
          return facebook::jsi::Value::undefined();
        });
  }

  if (propName == "setHostCallbacks") {
    return facebook::jsi::Function::createFromHostFunction(
        rt, name, 1,
        [this](facebook::jsi::Runtime& rt, const facebook::jsi::Value&,
               const facebook::jsi::Value* args, size_t count)
            -> facebook::jsi::Value {
          if (count < 1 || !args[0].isObject()) {
            throw facebook::jsi::JSError(
                rt, "setHostCallbacks requires a callbacks object");
          }
          setHostCallbacks(rt, args[0].asObject(rt));
          return facebook::jsi::Value::undefined();
        });
  }

  if (propName == "getTenantInfo") {
    return facebook::jsi::Function::createFromHostFunction(
        rt, name, 1,
        [this](facebook::jsi::Runtime& rt, const facebook::jsi::Value&,
               const facebook::jsi::Value* args, size_t count)
            -> facebook::jsi::Value {
          if (count < 1 || !args[0].isNumber()) {
            throw facebook::jsi::JSError(rt, "getTenantInfo requires a tenant ID");
          }
          return getTenantInfo(rt, static_cast<TenantId>(args[0].asNumber()));
        });
  }

  if (propName == "getMetrics") {
    return facebook::jsi::Function::createFromHostFunction(
        rt, name, 0,
        [this](facebook::jsi::Runtime& rt, const facebook::jsi::Value&,
               const facebook::jsi::Value*, size_t)
            -> facebook::jsi::Value {
          return getMetrics(rt);
        });
  }

  // --- Per-tenant context operations (for TS Engine delegation) ---

  if (propName == "evalInTenant") {
    return facebook::jsi::Function::createFromHostFunction(
        rt, name, 2,
        [this](facebook::jsi::Runtime& rt, const facebook::jsi::Value&,
               const facebook::jsi::Value* args, size_t count)
            -> facebook::jsi::Value {
          if (count < 2 || !args[0].isNumber() || !args[1].isString()) {
            throw facebook::jsi::JSError(
                rt, "evalInTenant requires (tenantId: number, code: string)");
          }
          auto id = static_cast<TenantId>(args[0].asNumber());
          auto code = args[1].asString(rt).utf8(rt);
          return evalInTenant(rt, id, code);
        });
  }

  if (propName == "setTenantGlobal") {
    return facebook::jsi::Function::createFromHostFunction(
        rt, name, 3,
        [this](facebook::jsi::Runtime& rt, const facebook::jsi::Value&,
               const facebook::jsi::Value* args, size_t count)
            -> facebook::jsi::Value {
          if (count < 3 || !args[0].isNumber() || !args[1].isString()) {
            throw facebook::jsi::JSError(
                rt, "setTenantGlobal requires (tenantId: number, name: string, value: any)");
          }
          auto id = static_cast<TenantId>(args[0].asNumber());
          auto globalName = args[1].asString(rt).utf8(rt);
          setTenantGlobal(rt, id, globalName, args[2]);
          return facebook::jsi::Value::undefined();
        });
  }

  if (propName == "getTenantGlobal") {
    return facebook::jsi::Function::createFromHostFunction(
        rt, name, 2,
        [this](facebook::jsi::Runtime& rt, const facebook::jsi::Value&,
               const facebook::jsi::Value* args, size_t count)
            -> facebook::jsi::Value {
          if (count < 2 || !args[0].isNumber() || !args[1].isString()) {
            throw facebook::jsi::JSError(
                rt, "getTenantGlobal requires (tenantId: number, name: string)");
          }
          auto id = static_cast<TenantId>(args[0].asNumber());
          auto globalName = args[1].asString(rt).utf8(rt);
          return getTenantGlobal(rt, id, globalName);
        });
  }

  // --- Per-tenant timer operations (P0.2) ---

  if (propName == "scheduleTenantTimeout") {
    return facebook::jsi::Function::createFromHostFunction(
        rt, name, 3,
        [this](facebook::jsi::Runtime& rt, const facebook::jsi::Value&,
               const facebook::jsi::Value* args, size_t count)
            -> facebook::jsi::Value {
          if (count < 3 || !args[0].isNumber() || !args[1].isString() ||
              !args[2].isNumber()) {
            throw facebook::jsi::JSError(
                rt, "scheduleTenantTimeout requires (tenantId, callbackId, delayMs)");
          }
          auto id = static_cast<TenantId>(args[0].asNumber());
          auto callbackId = args[1].asString(rt).utf8(rt);
          auto delayMs = args[2].asNumber();
          return facebook::jsi::Value(scheduleTenantTimeout(id, callbackId, delayMs));
        });
  }

  if (propName == "scheduleTenantInterval") {
    return facebook::jsi::Function::createFromHostFunction(
        rt, name, 3,
        [this](facebook::jsi::Runtime& rt, const facebook::jsi::Value&,
               const facebook::jsi::Value* args, size_t count)
            -> facebook::jsi::Value {
          if (count < 3 || !args[0].isNumber() || !args[1].isString() ||
              !args[2].isNumber()) {
            throw facebook::jsi::JSError(
                rt, "scheduleTenantInterval requires (tenantId, callbackId, intervalMs)");
          }
          auto id = static_cast<TenantId>(args[0].asNumber());
          auto callbackId = args[1].asString(rt).utf8(rt);
          auto intervalMs = args[2].asNumber();
          return facebook::jsi::Value(scheduleTenantInterval(id, callbackId, intervalMs));
        });
  }

  if (propName == "cancelTenantTimer") {
    return facebook::jsi::Function::createFromHostFunction(
        rt, name, 2,
        [this](facebook::jsi::Runtime& rt, const facebook::jsi::Value&,
               const facebook::jsi::Value* args, size_t count)
            -> facebook::jsi::Value {
          if (count < 2 || !args[0].isNumber() || !args[1].isNumber()) {
            throw facebook::jsi::JSError(
                rt, "cancelTenantTimer requires (tenantId, timerId)");
          }
          auto id = static_cast<TenantId>(args[0].asNumber());
          auto timerId = args[1].asNumber();
          cancelTenantTimer(id, timerId);
          return facebook::jsi::Value::undefined();
        });
  }

  if (propName == "pauseTenantTimers") {
    return facebook::jsi::Function::createFromHostFunction(
        rt, name, 1,
        [this](facebook::jsi::Runtime& rt, const facebook::jsi::Value&,
               const facebook::jsi::Value* args, size_t count)
            -> facebook::jsi::Value {
          if (count < 1 || !args[0].isNumber()) {
            throw facebook::jsi::JSError(rt, "pauseTenantTimers requires a tenant ID");
          }
          pauseTenantTimers(static_cast<TenantId>(args[0].asNumber()));
          return facebook::jsi::Value::undefined();
        });
  }

  if (propName == "resumeTenantTimers") {
    return facebook::jsi::Function::createFromHostFunction(
        rt, name, 1,
        [this](facebook::jsi::Runtime& rt, const facebook::jsi::Value&,
               const facebook::jsi::Value* args, size_t count)
            -> facebook::jsi::Value {
          if (count < 1 || !args[0].isNumber()) {
            throw facebook::jsi::JSError(rt, "resumeTenantTimers requires a tenant ID");
          }
          resumeTenantTimers(static_cast<TenantId>(args[0].asNumber()));
          return facebook::jsi::Value::undefined();
        });
  }

  // --- Permission / quota queries (P1) ---

  if (propName == "canUseComponent") {
    return facebook::jsi::Function::createFromHostFunction(
        rt, name, 2,
        [this](facebook::jsi::Runtime& rt, const facebook::jsi::Value&,
               const facebook::jsi::Value* args, size_t count)
            -> facebook::jsi::Value {
          if (count < 2 || !args[0].isNumber() || !args[1].isString()) {
            throw facebook::jsi::JSError(
                rt, "canUseComponent requires (tenantId, componentName)");
          }
          auto id = static_cast<TenantId>(args[0].asNumber());
          auto name = args[1].asString(rt).utf8(rt);
          return facebook::jsi::Value(canUseComponent(id, name));
        });
  }

  if (propName == "canUseAPI") {
    return facebook::jsi::Function::createFromHostFunction(
        rt, name, 2,
        [this](facebook::jsi::Runtime& rt, const facebook::jsi::Value&,
               const facebook::jsi::Value* args, size_t count)
            -> facebook::jsi::Value {
          if (count < 2 || !args[0].isNumber() || !args[1].isString()) {
            throw facebook::jsi::JSError(
                rt, "canUseAPI requires (tenantId, apiName)");
          }
          auto id = static_cast<TenantId>(args[0].asNumber());
          auto apiName = args[1].asString(rt).utf8(rt);
          return facebook::jsi::Value(canUseAPI(id, apiName));
        });
  }

  if (propName == "isOverQuota") {
    return facebook::jsi::Function::createFromHostFunction(
        rt, name, 1,
        [this](facebook::jsi::Runtime& rt, const facebook::jsi::Value&,
               const facebook::jsi::Value* args, size_t count)
            -> facebook::jsi::Value {
          if (count < 1 || !args[0].isNumber()) {
            throw facebook::jsi::JSError(rt, "isOverQuota requires a tenant ID");
          }
          return facebook::jsi::Value(
              isOverQuota(static_cast<TenantId>(args[0].asNumber())));
        });
  }

  if (propName == "isNearQuota") {
    return facebook::jsi::Function::createFromHostFunction(
        rt, name, 1,
        [this](facebook::jsi::Runtime& rt, const facebook::jsi::Value&,
               const facebook::jsi::Value* args, size_t count)
            -> facebook::jsi::Value {
          if (count < 1 || !args[0].isNumber()) {
            throw facebook::jsi::JSError(rt, "isNearQuota requires a tenant ID");
          }
          return facebook::jsi::Value(
              isNearQuota(static_cast<TenantId>(args[0].asNumber())));
        });
  }

  // --- EventBus JSI bindings (P2) ---

  if (propName == "busPublish") {
    return facebook::jsi::Function::createFromHostFunction(
        rt, name, 1,
        [this](facebook::jsi::Runtime& rt, const facebook::jsi::Value&,
               const facebook::jsi::Value* args, size_t count)
            -> facebook::jsi::Value {
          if (count < 1 || !args[0].isObject()) {
            throw facebook::jsi::JSError(rt, "busPublish requires an event object");
          }
          return facebook::jsi::Value(busPublish(rt, args[0].asObject(rt)));
        });
  }

  if (propName == "busBroadcast") {
    return facebook::jsi::Function::createFromHostFunction(
        rt, name, 3,
        [this](facebook::jsi::Runtime& rt, const facebook::jsi::Value&,
               const facebook::jsi::Value* args, size_t count)
            -> facebook::jsi::Value {
          if (count < 3 || !args[0].isString() || !args[1].isString() ||
              !args[2].isString()) {
            throw facebook::jsi::JSError(
                rt, "busBroadcast requires (channel, name, payload)");
          }
          auto channel = args[0].asString(rt).utf8(rt);
          auto eventName = args[1].asString(rt).utf8(rt);
          auto payload = args[2].asString(rt).utf8(rt);
          return facebook::jsi::Value(busBroadcast(rt, channel, eventName, payload));
        });
  }

  if (propName == "busUnicast") {
    return facebook::jsi::Function::createFromHostFunction(
        rt, name, 4,
        [this](facebook::jsi::Runtime& rt, const facebook::jsi::Value&,
               const facebook::jsi::Value* args, size_t count)
            -> facebook::jsi::Value {
          if (count < 4 || !args[0].isNumber() || !args[1].isString() ||
              !args[2].isString() || !args[3].isString()) {
            throw facebook::jsi::JSError(
                rt, "busUnicast requires (targetTenantId, channel, name, payload)");
          }
          auto targetId = static_cast<TenantId>(args[0].asNumber());
          auto channel = args[1].asString(rt).utf8(rt);
          auto eventName = args[2].asString(rt).utf8(rt);
          auto payload = args[3].asString(rt).utf8(rt);
          return facebook::jsi::Value(busUnicast(targetId, channel, eventName, payload));
        });
  }

  if (propName == "busMulticast") {
    return facebook::jsi::Function::createFromHostFunction(
        rt, name, 4,
        [this](facebook::jsi::Runtime& rt, const facebook::jsi::Value&,
               const facebook::jsi::Value* args, size_t count)
            -> facebook::jsi::Value {
          if (count < 4 || !args[0].isObject() || !args[1].isString() ||
              !args[2].isString() || !args[3].isString()) {
            throw facebook::jsi::JSError(
                rt, "busMulticast requires (targetIds[], channel, name, payload)");
          }
          auto targetIds = args[0].asObject(rt).asArray(rt);
          auto channel = args[1].asString(rt).utf8(rt);
          auto eventName = args[2].asString(rt).utf8(rt);
          auto payload = args[3].asString(rt).utf8(rt);
          return facebook::jsi::Value(
              busMulticast(rt, targetIds, channel, eventName, payload));
        });
  }

  if (propName == "busSubscribe") {
    return facebook::jsi::Function::createFromHostFunction(
        rt, name, 3,
        [this](facebook::jsi::Runtime& rt, const facebook::jsi::Value&,
               const facebook::jsi::Value* args, size_t count)
            -> facebook::jsi::Value {
          if (count < 3 || !args[0].isNumber() || !args[1].isString() ||
              !args[2].isString()) {
            throw facebook::jsi::JSError(
                rt, "busSubscribe requires (tenantId, channel, filter)");
          }
          auto tenantId = static_cast<TenantId>(args[0].asNumber());
          auto channel = args[1].asString(rt).utf8(rt);
          auto filter = args[2].asString(rt).utf8(rt);
          return facebook::jsi::Value(busSubscribe(tenantId, channel, filter));
        });
  }

  if (propName == "busUnsubscribe") {
    return facebook::jsi::Function::createFromHostFunction(
        rt, name, 1,
        [this](facebook::jsi::Runtime& rt, const facebook::jsi::Value&,
               const facebook::jsi::Value* args, size_t count)
            -> facebook::jsi::Value {
          if (count < 1 || !args[0].isNumber()) {
            throw facebook::jsi::JSError(rt, "busUnsubscribe requires a subscription ID");
          }
          busUnsubscribe(args[0].asNumber());
          return facebook::jsi::Value::undefined();
        });
  }

  if (propName == "busUnsubscribeAll") {
    return facebook::jsi::Function::createFromHostFunction(
        rt, name, 1,
        [this](facebook::jsi::Runtime& rt, const facebook::jsi::Value&,
               const facebook::jsi::Value* args, size_t count)
            -> facebook::jsi::Value {
          if (count < 1 || !args[0].isNumber()) {
            throw facebook::jsi::JSError(rt, "busUnsubscribeAll requires a tenant ID");
          }
          busUnsubscribeAll(static_cast<TenantId>(args[0].asNumber()));
          return facebook::jsi::Value::undefined();
        });
  }

  if (propName == "busGetStats") {
    return facebook::jsi::Function::createFromHostFunction(
        rt, name, 0,
        [this](facebook::jsi::Runtime& rt, const facebook::jsi::Value&,
               const facebook::jsi::Value*, size_t)
            -> facebook::jsi::Value {
          return busGetStats(rt);
        });
  }

  if (propName == "busCreateChannel") {
    return facebook::jsi::Function::createFromHostFunction(
        rt, name, 1,
        [this](facebook::jsi::Runtime& rt, const facebook::jsi::Value&,
               const facebook::jsi::Value* args, size_t count)
            -> facebook::jsi::Value {
          if (count < 1 || !args[0].isObject()) {
            throw facebook::jsi::JSError(rt, "busCreateChannel requires a policy object");
          }
          busCreateChannel(rt, args[0].asObject(rt));
          return facebook::jsi::Value::undefined();
        });
  }

  return facebook::jsi::Value::undefined();
}

void RillTenantManager::set(facebook::jsi::Runtime&,
                           const facebook::jsi::PropNameID&,
                           const facebook::jsi::Value&) {
  // Read-only host object
}

std::vector<facebook::jsi::PropNameID> RillTenantManager::getPropertyNames(
    facebook::jsi::Runtime& rt) {
  std::vector<facebook::jsi::PropNameID> props;
  props.push_back(facebook::jsi::PropNameID::forUtf8(rt, "createTenant"));
  props.push_back(facebook::jsi::PropNameID::forUtf8(rt, "destroyTenant"));
  props.push_back(facebook::jsi::PropNameID::forUtf8(rt, "pauseTenant"));
  props.push_back(facebook::jsi::PropNameID::forUtf8(rt, "resumeTenant"));
  props.push_back(facebook::jsi::PropNameID::forUtf8(rt, "loadBundle"));
  props.push_back(facebook::jsi::PropNameID::forUtf8(rt, "sendEvent"));
  props.push_back(facebook::jsi::PropNameID::forUtf8(rt, "broadcast"));
  props.push_back(facebook::jsi::PropNameID::forUtf8(rt, "setHostCallbacks"));
  props.push_back(facebook::jsi::PropNameID::forUtf8(rt, "getTenantInfo"));
  props.push_back(facebook::jsi::PropNameID::forUtf8(rt, "getMetrics"));
  props.push_back(facebook::jsi::PropNameID::forUtf8(rt, "evalInTenant"));
  props.push_back(facebook::jsi::PropNameID::forUtf8(rt, "setTenantGlobal"));
  props.push_back(facebook::jsi::PropNameID::forUtf8(rt, "getTenantGlobal"));
  // Timer operations
  props.push_back(facebook::jsi::PropNameID::forUtf8(rt, "scheduleTenantTimeout"));
  props.push_back(facebook::jsi::PropNameID::forUtf8(rt, "scheduleTenantInterval"));
  props.push_back(facebook::jsi::PropNameID::forUtf8(rt, "cancelTenantTimer"));
  props.push_back(facebook::jsi::PropNameID::forUtf8(rt, "pauseTenantTimers"));
  props.push_back(facebook::jsi::PropNameID::forUtf8(rt, "resumeTenantTimers"));
  // Permission / quota queries
  props.push_back(facebook::jsi::PropNameID::forUtf8(rt, "canUseComponent"));
  props.push_back(facebook::jsi::PropNameID::forUtf8(rt, "canUseAPI"));
  props.push_back(facebook::jsi::PropNameID::forUtf8(rt, "isOverQuota"));
  props.push_back(facebook::jsi::PropNameID::forUtf8(rt, "isNearQuota"));
  // EventBus operations
  props.push_back(facebook::jsi::PropNameID::forUtf8(rt, "busPublish"));
  props.push_back(facebook::jsi::PropNameID::forUtf8(rt, "busBroadcast"));
  props.push_back(facebook::jsi::PropNameID::forUtf8(rt, "busUnicast"));
  props.push_back(facebook::jsi::PropNameID::forUtf8(rt, "busMulticast"));
  props.push_back(facebook::jsi::PropNameID::forUtf8(rt, "busSubscribe"));
  props.push_back(facebook::jsi::PropNameID::forUtf8(rt, "busUnsubscribe"));
  props.push_back(facebook::jsi::PropNameID::forUtf8(rt, "busUnsubscribeAll"));
  props.push_back(facebook::jsi::PropNameID::forUtf8(rt, "busGetStats"));
  props.push_back(facebook::jsi::PropNameID::forUtf8(rt, "busCreateChannel"));
  return props;
}

// --- Tenant lifecycle ---

TenantConfig RillTenantManager::parseTenantConfig(
    facebook::jsi::Runtime& rt,
    const facebook::jsi::Object& config) {
  TenantConfig tc;

  if (config.hasProperty(rt, "appId")) {
    tc.appId = config.getProperty(rt, "appId").asString(rt).utf8(rt);
  }

  if (config.hasProperty(rt, "debug")) {
    tc.debug = config.getProperty(rt, "debug").asBool();
  }

  if (config.hasProperty(rt, "timeout")) {
    tc.timeout = config.getProperty(rt, "timeout").asNumber();
  }

  // Parse quota overrides
  if (config.hasProperty(rt, "quota")) {
    auto quotaObj = config.getProperty(rt, "quota").asObject(rt);
    // Accept both "maxHeapBytes" (preferred) and legacy alias "maxMemoryBytes".
    // Internally we store heap quota in ResourceQuota::maxHeapBytes.
    if (quotaObj.hasProperty(rt, "maxHeapBytes")) {
      tc.quota.maxHeapBytes =
          static_cast<size_t>(quotaObj.getProperty(rt, "maxHeapBytes").asNumber());
    } else if (quotaObj.hasProperty(rt, "maxMemoryBytes")) {
      tc.quota.maxHeapBytes =
          static_cast<size_t>(quotaObj.getProperty(rt, "maxMemoryBytes").asNumber());
    }
    if (quotaObj.hasProperty(rt, "maxTimers")) {
      tc.quota.maxTimers =
          static_cast<uint32_t>(quotaObj.getProperty(rt, "maxTimers").asNumber());
    }
    if (quotaObj.hasProperty(rt, "maxCallbacks")) {
      tc.quota.maxCallbacks =
          static_cast<uint32_t>(quotaObj.getProperty(rt, "maxCallbacks").asNumber());
    }
  }

  // Parse API whitelist
  if (config.hasProperty(rt, "apis")) {
    auto apisArr = config.getProperty(rt, "apis").asObject(rt).asArray(rt);
    auto len = apisArr.size(rt);
    tc.apis.reserve(len);
    for (size_t i = 0; i < len; i++) {
      tc.apis.push_back(apisArr.getValueAtIndex(rt, i).asString(rt).utf8(rt));
    }
  }

  return tc;
}

TenantId RillTenantManager::createTenant(facebook::jsi::Runtime& rt,
                                        const facebook::jsi::Object& config) {
  std::unique_lock<std::recursive_mutex> lock(mutex_);

  auto tc = parseTenantConfig(rt, config);
  TenantId id = nextTenantId_++;

  // Build TenantContext for the registry
  TenantIdentity identity;
  identity.appId = tc.appId;

  ComponentPermission components;
  // Default: all components allowed (no whitelist restriction)
  components.allowAll = true;

  APIPermission apis;
  if (!tc.apis.empty()) {
    apis.allowAll = false;
    apis.allowedAPIs.insert(tc.apis.begin(), tc.apis.end());
  } else {
    apis.allowAll = true;
  }

  // Create TenantHandle with heap-allocated TenantContext
  auto ctx = std::make_unique<TenantContext>();
  ctx->identity = std::move(identity);
  ctx->components = std::move(components);
  ctx->apis = std::move(apis);
  ctx->quota = tc.quota;

  auto handle = std::make_unique<TenantHandle>(id, std::move(ctx));

  // P0.1: Create sandbox on the host thread (same thread)
  try {
    handle->createSandbox(rt, tc.timeout);
  } catch (const std::exception& e) {
    // Copy callback under a dedicated mutex; do NOT call Host JS while holding
    // the TenantManager state mutex (risk of re-entrant deadlocks).
    std::shared_ptr<facebook::jsi::Function> onError;
    {
      std::lock_guard<std::mutex> cbLock(callbacksMutex_);
      onError = hostCallbacks_.onError;
    }
    lock.unlock();
    if (onError) {
      auto errMsg = facebook::jsi::String::createFromUtf8(rt, e.what());
      onError->call(rt,
                    facebook::jsi::Value(static_cast<double>(id)),
                    std::move(errMsg));
    }
    throw;
  }

  tenants_.emplace(id, std::move(handle));

  // P2: Create security context for the tenant
  {
    rill::security::SecurityPolicy secPolicy;
    secPolicy.enforced = true;  // Default: enforce security
    // Parse security policy from config if provided
    if (config.hasProperty(rt, "security")) {
      auto secObj = config.getProperty(rt, "security").asObject(rt);
      if (secObj.hasProperty(rt, "enforced")) {
        secPolicy.enforced = secObj.getProperty(rt, "enforced").asBool();
      }
    }

    // Set sandbox root to a proper system-managed directory.
    // An empty sandboxRoot would resolve to cwd via weakly_canonical(""),
    // causing cleanup() to delete the working directory.
    NSArray *cachePaths = NSSearchPathForDirectoriesInDomains(
        NSCachesDirectory, NSUserDomainMask, YES);
    NSString *cachePath = cachePaths.firstObject ?: NSTemporaryDirectory();
    NSString *sandboxDir = [NSString stringWithFormat:@"%@/rill/tenant-%u",
                            cachePath, id];
    secPolicy.filePolicy.sandboxRoot = sandboxDir.UTF8String;

    securityManager_.createSecurityContext(id, secPolicy);
  }

  // P0.2: Create a dedicated TenantThread for timer management
  bool registryRegistered = false;
  try {
    threadPool_.createThread(id);

    // Register in TenantRegistry using TenantManager's tenant id.
    // This avoids id mismatches during unregister and keeps metrics consistent.
    auto* inserted = tenants_.at(id).get();
    registry_.registerTenantWithId(
        id,
        TenantIdentity(inserted->context().identity),
        ComponentPermission(inserted->context().components),
        APIPermission(inserted->context().apis),
        inserted->context().quota);
    registryRegistered = true;
  } catch (...) {
    // Roll back partial tenant creation.
    threadPool_.destroyThread(id);
    auto it = tenants_.find(id);
    if (it != tenants_.end()) {
      it->second->dispose();
      tenants_.erase(it);
    }
    if (registryRegistered) {
      registry_.unregisterTenant(id);
    }
    throw;
  }

  return id;
}

void RillTenantManager::destroyTenant(TenantId id) {
  std::lock_guard<std::recursive_mutex> lock(mutex_);

  auto it = tenants_.find(id);
  if (it == tenants_.end()) return;

  // P0.2: Destroy TenantThread first (joins the thread)
  threadPool_.destroyThread(id);

  // P2: Clean up EventBus subscriptions for this tenant
  eventBus_.unsubscribeAll(id);

  // P2: Destroy security context
  securityManager_.destroySecurityContext(id);

  it->second->dispose();
  tenants_.erase(it);
  registry_.unregisterTenant(id);
}

void RillTenantManager::pauseTenant(TenantId id) {
  std::lock_guard<std::recursive_mutex> lock(mutex_);

  auto* handle = getTenantOrThrow(id);
  if (handle->state() == TenantState::Running) {
    handle->setState(TenantState::Paused);
    // P0.2: Pause TenantThread timers (freezes remaining time)
    auto* thread = threadPool_.getThread(id);
    if (thread) thread->pauseTimers();
  }
}

void RillTenantManager::resumeTenant(TenantId id) {
  std::lock_guard<std::recursive_mutex> lock(mutex_);

  auto* handle = getTenantOrThrow(id);
  if (handle->state() == TenantState::Paused) {
    handle->setState(TenantState::Running);
    // P0.2: Resume TenantThread timers (continues from frozen point)
    auto* thread = threadPool_.getThread(id);
    if (thread) thread->resumeTimers();
  }
}

// --- Code loading ---

void RillTenantManager::loadBundle(TenantId id, const std::string& code) {
  std::unique_lock<std::recursive_mutex> lock(mutex_);

  auto* handle = getTenantOrThrow(id);
  handle->setState(TenantState::Loading);

  try {
    handle->eval(*hostRuntime_, code);
    handle->setState(TenantState::Running);
  } catch (const std::exception& e) {
    handle->setState(TenantState::Error);
    std::shared_ptr<facebook::jsi::Function> onError;
    {
      std::lock_guard<std::mutex> cbLock(callbacksMutex_);
      onError = hostCallbacks_.onError;
    }
    lock.unlock();
    if (onError) {
      auto errMsg =
          facebook::jsi::String::createFromUtf8(*hostRuntime_, e.what());
      onError->call(
          *hostRuntime_,
          facebook::jsi::Value(static_cast<double>(id)),
          std::move(errMsg));
    }
  }
}

// --- Communication ---

void RillTenantManager::sendEvent(TenantId id, const std::string& name,
                                 facebook::jsi::Runtime& rt,
                                 const facebook::jsi::Value& payload) {
  std::lock_guard<std::recursive_mutex> lock(mutex_);

  auto* handle = getTenantOrThrow(id);
  if (handle->state() != TenantState::Running) return;

  // Set __RILL_EVENT on the sandbox global, then invoke the handler
  auto eventObj = facebook::jsi::Object(rt);
  eventObj.setProperty(rt, "name",
                       facebook::jsi::String::createFromUtf8(rt, name));
  if (!payload.isUndefined()) {
    eventObj.setProperty(rt, "payload", facebook::jsi::Value(rt, payload));
  }

  // TenantHandle::inject expects a jsi::Value.
  handle->inject(rt, "__RILL_INCOMING_EVENT",
                    facebook::jsi::Value(std::move(eventObj)));
  handle->eval(rt,
      "if (typeof __RILL_EVENT_HANDLER === 'function') "
      "__RILL_EVENT_HANDLER(__RILL_INCOMING_EVENT);");
}

void RillTenantManager::broadcast(const std::string& name,
                                 facebook::jsi::Runtime& rt,
                                 const facebook::jsi::Value& payload) {
  // IMPORTANT: Do not call sendEvent() while holding mutex_.
  // sendEvent() itself locks mutex_ and would deadlock.
  std::vector<TenantId> runningTenants;
  {
    std::lock_guard<std::recursive_mutex> lock(mutex_);
    runningTenants.reserve(tenants_.size());
    for (const auto& [id, handle] : tenants_) {
      if (handle->state() == TenantState::Running) {
        runningTenants.push_back(id);
      }
    }
  }
  for (auto id : runningTenants) {
    sendEvent(id, name, rt, payload);
  }
}

// --- Host callbacks ---

void RillTenantManager::setHostCallbacks(facebook::jsi::Runtime& rt,
                                        const facebook::jsi::Object& callbacks) {
  std::lock_guard<std::mutex> cbLock(callbacksMutex_);
  if (callbacks.hasProperty(rt, "onBatch")) {
    auto fn = callbacks.getProperty(rt, "onBatch").asObject(rt).asFunction(rt);
    hostCallbacks_.onBatch =
        std::make_shared<facebook::jsi::Function>(std::move(fn));
  }
  if (callbacks.hasProperty(rt, "onEvent")) {
    auto fn = callbacks.getProperty(rt, "onEvent").asObject(rt).asFunction(rt);
    hostCallbacks_.onEvent =
        std::make_shared<facebook::jsi::Function>(std::move(fn));
  }
  if (callbacks.hasProperty(rt, "onError")) {
    auto fn = callbacks.getProperty(rt, "onError").asObject(rt).asFunction(rt);
    hostCallbacks_.onError =
        std::make_shared<facebook::jsi::Function>(std::move(fn));
  }
  if (callbacks.hasProperty(rt, "onLog")) {
    auto fn = callbacks.getProperty(rt, "onLog").asObject(rt).asFunction(rt);
    hostCallbacks_.onLog =
        std::make_shared<facebook::jsi::Function>(std::move(fn));
  }
  if (callbacks.hasProperty(rt, "onTimer")) {
    auto fn = callbacks.getProperty(rt, "onTimer").asObject(rt).asFunction(rt);
    hostCallbacks_.onTimer =
        std::make_shared<facebook::jsi::Function>(std::move(fn));
  }
}

// --- Metrics ---

facebook::jsi::Object RillTenantManager::getTenantInfo(
    facebook::jsi::Runtime& rt, TenantId id) {
  std::lock_guard<std::recursive_mutex> lock(mutex_);

  auto* handle = getTenantOrThrow(id);
  const auto& ctx = handle->context();
  auto info = facebook::jsi::Object(rt);
  info.setProperty(rt, "id", static_cast<double>(id));
  info.setProperty(rt, "appId",
                   facebook::jsi::String::createFromUtf8(rt, ctx.identity.appId));
  info.setProperty(rt, "state",
                   static_cast<double>(static_cast<uint8_t>(handle->state())));
  info.setProperty(rt, "disposed", handle->isDisposed());

  // P1: Quota usage
  auto quota = facebook::jsi::Object(rt);
  quota.setProperty(rt, "activeTimers",
                    static_cast<double>(ctx.usage.activeTimers.load(std::memory_order_relaxed)));
  quota.setProperty(rt, "maxTimers", static_cast<double>(ctx.quota.maxTimers));
  quota.setProperty(rt, "activeCallbacks",
                    static_cast<double>(ctx.usage.activeCallbacks.load(std::memory_order_relaxed)));
  quota.setProperty(rt, "maxCallbacks", static_cast<double>(ctx.quota.maxCallbacks));
  quota.setProperty(rt, "currentHeapBytes",
                    static_cast<double>(ctx.usage.currentHeapBytes.load(std::memory_order_relaxed)));
  quota.setProperty(rt, "maxHeapBytes", static_cast<double>(ctx.quota.maxHeapBytes));
  info.setProperty(rt, "quota", std::move(quota));

  // P1: Violations
  auto violations = facebook::jsi::Object(rt);
  violations.setProperty(rt, "componentDenied",
                         static_cast<double>(ctx.usage.componentViolations.load(std::memory_order_relaxed)));
  violations.setProperty(rt, "apiDenied",
                         static_cast<double>(ctx.usage.apiViolations.load(std::memory_order_relaxed)));
  violations.setProperty(rt, "quotaExceeded",
                         static_cast<double>(ctx.usage.quotaExceeded.load(std::memory_order_relaxed)));
  info.setProperty(rt, "violations", std::move(violations));

  info.setProperty(rt, "overQuota", ctx.isOverQuota());
  info.setProperty(rt, "nearQuota", ctx.isNearQuota());

  return info;
}

facebook::jsi::Object RillTenantManager::getMetrics(facebook::jsi::Runtime& rt) {
  std::lock_guard<std::recursive_mutex> lock(mutex_);

  auto metrics = facebook::jsi::Object(rt);
  metrics.setProperty(rt, "totalTenants",
                      static_cast<double>(tenants_.size()));
  metrics.setProperty(rt, "registryTotal",
                      static_cast<double>(registry_.totalTenants()));
  metrics.setProperty(rt, "registryActive",
                      static_cast<double>(registry_.activeTenants()));

  // Per-tenant state summary
  uint32_t running = 0, paused = 0, error = 0;
  for (const auto& [id, handle] : tenants_) {
    switch (handle->state()) {
      case TenantState::Running: ++running; break;
      case TenantState::Paused: ++paused; break;
      case TenantState::Error: ++error; break;
      default: break;
    }
  }
  metrics.setProperty(rt, "running", static_cast<double>(running));
  metrics.setProperty(rt, "paused", static_cast<double>(paused));
  metrics.setProperty(rt, "error", static_cast<double>(error));

  // P0.2: Thread pool stats
  metrics.setProperty(rt, "activeThreads",
                      static_cast<double>(threadPool_.activeThreadCount()));

  return metrics;
}

// --- Per-tenant context operations ---

facebook::jsi::Value RillTenantManager::evalInTenant(
    facebook::jsi::Runtime& rt, TenantId id, const std::string& code) {
  std::lock_guard<std::recursive_mutex> lock(mutex_);
  auto* handle = getTenantOrThrow(id);
  return handle->eval(rt, code);
}

void RillTenantManager::setTenantGlobal(
    facebook::jsi::Runtime& rt, TenantId id,
    const std::string& name, const facebook::jsi::Value& value) {
  std::lock_guard<std::recursive_mutex> lock(mutex_);
  auto* handle = getTenantOrThrow(id);
  handle->inject(rt, name, value);
}

facebook::jsi::Value RillTenantManager::getTenantGlobal(
    facebook::jsi::Runtime& rt, TenantId id, const std::string& name) {
  std::lock_guard<std::recursive_mutex> lock(mutex_);
  auto* handle = getTenantOrThrow(id);
  return handle->extract(rt, name);
}

// --- Per-tenant timer operations ---

double RillTenantManager::scheduleTenantTimeout(
    TenantId id, const std::string& callbackId, double delayMs) {
  std::unique_lock<std::recursive_mutex> lock(mutex_);
  auto* thread = threadPool_.getThread(id);
  if (!thread) {
    throw std::runtime_error(
        "[RillTenantManager] No thread for tenant: " + std::to_string(id));
  }

  // P1: Quota enforcement — check before scheduling
  auto* handle = getTenantOrThrow(id);
  auto& ctx = handle->context();
  if (!ctx.canCreateTimer()) {
    ctx.usage.quotaExceeded.fetch_add(1, std::memory_order_relaxed);
    return -1.0;  // Signal quota exceeded to caller
  }

  // Track usage
  ctx.usage.activeTimers.fetch_add(1, std::memory_order_relaxed);
  auto* activeTimers = &ctx.usage.activeTimers;

  auto capturedCallbackId = callbackId;
  auto capturedTenantId = id;
  auto timerId = thread->scheduleTimeout(
      [this, capturedTenantId, capturedCallbackId, activeTimers]() {
        // Decrement active timer count (timeout fires once).
        // IMPORTANT: Do not touch tenants_ from the tenant thread.
        activeTimers->fetch_sub(1, std::memory_order_relaxed);
        onTimerFired(capturedTenantId, capturedCallbackId);
      },
      delayMs);
  lock.unlock();
  return static_cast<double>(timerId);
}

double RillTenantManager::scheduleTenantInterval(
    TenantId id, const std::string& callbackId, double intervalMs) {
  std::unique_lock<std::recursive_mutex> lock(mutex_);
  auto* thread = threadPool_.getThread(id);
  if (!thread) {
    throw std::runtime_error(
        "[RillTenantManager] No thread for tenant: " + std::to_string(id));
  }

  // P1: Quota enforcement
  auto* handle = getTenantOrThrow(id);
  auto& ctx = handle->context();
  if (!ctx.canCreateTimer()) {
    ctx.usage.quotaExceeded.fetch_add(1, std::memory_order_relaxed);
    return -1.0;
  }

  ctx.usage.activeTimers.fetch_add(1, std::memory_order_relaxed);

  auto capturedCallbackId = callbackId;
  auto capturedTenantId = id;
  auto timerId = thread->scheduleInterval(
      [this, capturedTenantId, capturedCallbackId]() {
        // Interval keeps firing — don't decrement
        onTimerFired(capturedTenantId, capturedCallbackId);
      },
      intervalMs);
  lock.unlock();
  return static_cast<double>(timerId);
}

void RillTenantManager::cancelTenantTimer(TenantId id, double timerId) {
  std::lock_guard<std::recursive_mutex> lock(mutex_);
  auto* thread = threadPool_.getThread(id);
  if (!thread) return;  // Tenant already destroyed — silently ignore
  const bool cancelled = thread->cancelTimer(static_cast<TimerId>(timerId));
  if (!cancelled) {
    // If the timer already fired (timeout) or is otherwise not present,
    // the fire path is responsible for accounting.
    return;
  }

  // Decrement active timer usage only when we actually cancelled a pending timer.
  auto it = tenants_.find(id);
  if (it == tenants_.end()) return;
  auto& usage = it->second->context().usage;
  auto current = usage.activeTimers.load(std::memory_order_relaxed);
  if (current > 0) {
    usage.activeTimers.fetch_sub(1, std::memory_order_relaxed);
  }
}

void RillTenantManager::pauseTenantTimers(TenantId id) {
  auto* thread = threadPool_.getThread(id);
  if (!thread) return;
  thread->pauseTimers();
}

void RillTenantManager::resumeTenantTimers(TenantId id) {
  auto* thread = threadPool_.getThread(id);
  if (!thread) return;
  thread->resumeTimers();
}

void RillTenantManager::onTimerFired(TenantId tenantId,
                                     const std::string& callbackId) {
  // This is called from a TenantThread. Route to Host VM thread via CallInvoker.
  if (!callInvoker_) return;

  std::shared_ptr<facebook::jsi::Function> onTimer;
  {
    std::lock_guard<std::mutex> cbLock(callbacksMutex_);
    onTimer = hostCallbacks_.onTimer;
  }
  if (!onTimer) return;

  auto hostRt = hostRuntime_;
  auto capturedTenantId = tenantId;
  auto capturedCallbackId = callbackId;

  callInvoker_->invokeAsync(
      [hostRt, onTimer, capturedTenantId, capturedCallbackId]() {
        if (!hostRt || !onTimer) return;
        onTimer->call(
            *hostRt,
            facebook::jsi::Value(static_cast<double>(capturedTenantId)),
            facebook::jsi::String::createFromUtf8(*hostRt, capturedCallbackId));
      });
}

// --- Permission / quota queries ---

bool RillTenantManager::canUseComponent(TenantId id, const std::string& name) {
  std::lock_guard<std::recursive_mutex> lock(mutex_);
  auto* handle = getTenantOrThrow(id);
  auto& ctx = handle->context();
  bool allowed = ctx.canUseComponent(name);
  if (!allowed) {
    ctx.usage.componentViolations.fetch_add(1, std::memory_order_relaxed);
  }
  return allowed;
}

bool RillTenantManager::canUseAPI(TenantId id, const std::string& name) {
  std::lock_guard<std::recursive_mutex> lock(mutex_);
  auto* handle = getTenantOrThrow(id);
  auto& ctx = handle->context();
  bool allowed = ctx.canUseAPI(name);
  if (!allowed) {
    ctx.usage.apiViolations.fetch_add(1, std::memory_order_relaxed);
  }
  return allowed;
}

bool RillTenantManager::isOverQuota(TenantId id) {
  std::lock_guard<std::recursive_mutex> lock(mutex_);
  auto* handle = getTenantOrThrow(id);
  return handle->context().isOverQuota();
}

bool RillTenantManager::isNearQuota(TenantId id) {
  std::lock_guard<std::recursive_mutex> lock(mutex_);
  auto* handle = getTenantOrThrow(id);
  return handle->context().isNearQuota();
}

// --- EventBus JSI method implementations (P2) ---

bool RillTenantManager::busPublish(facebook::jsi::Runtime& rt,
                                   const facebook::jsi::Object& opts) {
  BusEvent event;
  event.channel = opts.getProperty(rt, "channel").asString(rt).utf8(rt);
  event.name = opts.getProperty(rt, "name").asString(rt).utf8(rt);
  event.payload = opts.getProperty(rt, "payload").asString(rt).utf8(rt);

  if (opts.hasProperty(rt, "priority")) {
    event.priority = static_cast<EventPriority>(
        static_cast<uint8_t>(opts.getProperty(rt, "priority").asNumber()));
  }
  if (opts.hasProperty(rt, "sourceTenantId")) {
    event.sourceTenantId =
        static_cast<TenantId>(opts.getProperty(rt, "sourceTenantId").asNumber());
  }

  return eventBus_.publish(std::move(event));
}

bool RillTenantManager::busBroadcast(facebook::jsi::Runtime&,
                                     const std::string& channel,
                                     const std::string& name,
                                     const std::string& payload) {
  return eventBus_.broadcast(channel, name, payload);
}

bool RillTenantManager::busUnicast(TenantId targetId,
                                   const std::string& channel,
                                   const std::string& name,
                                   const std::string& payload) {
  return eventBus_.unicast(targetId, channel, name, payload);
}

bool RillTenantManager::busMulticast(facebook::jsi::Runtime& rt,
                                     const facebook::jsi::Array& targetIds,
                                     const std::string& channel,
                                     const std::string& name,
                                     const std::string& payload) {
  std::vector<TenantId> ids;
  auto len = targetIds.size(rt);
  ids.reserve(len);
  for (size_t i = 0; i < len; ++i) {
    ids.push_back(static_cast<TenantId>(targetIds.getValueAtIndex(rt, i).asNumber()));
  }
  return eventBus_.multicast(ids, channel, name, payload);
}

double RillTenantManager::busSubscribe(TenantId tenantId,
                                       const std::string& channel,
                                       const std::string& filter) {
  // Subscribe with a handler that routes events to the host JS thread.
  auto capturedTenantId = tenantId;
  auto subId = eventBus_.subscribe(tenantId, channel, filter,
      [this, capturedTenantId](const BusEvent& event) {
        // Route to Host VM thread via CallInvoker
        if (!callInvoker_ || !hostRuntime_) return;

        std::shared_ptr<facebook::jsi::Function> onEvent;
        {
          std::lock_guard<std::mutex> cbLock(callbacksMutex_);
          onEvent = hostCallbacks_.onEvent;
        }
        if (!onEvent) return;

        auto hostRt = hostRuntime_;
        auto capturedEvent = event;  // Copy for async
        callInvoker_->invokeAsync(
            [hostRt, onEvent, capturedTenantId, capturedEvent]() {
              if (!hostRt || !onEvent) return;
              auto eventObj = facebook::jsi::Object(*hostRt);
              eventObj.setProperty(*hostRt, "channel",
                  facebook::jsi::String::createFromUtf8(*hostRt, capturedEvent.channel));
              eventObj.setProperty(*hostRt, "name",
                  facebook::jsi::String::createFromUtf8(*hostRt, capturedEvent.name));
              eventObj.setProperty(*hostRt, "payload",
                  facebook::jsi::String::createFromUtf8(*hostRt, capturedEvent.payload));
              eventObj.setProperty(*hostRt, "sourceTenantId",
                  facebook::jsi::Value(static_cast<double>(capturedEvent.sourceTenantId)));
              onEvent->call(*hostRt,
                  facebook::jsi::Value(static_cast<double>(capturedTenantId)),
                  std::move(eventObj));
            });
      });
  return static_cast<double>(subId);
}

void RillTenantManager::busUnsubscribe(double subscriptionId) {
  eventBus_.unsubscribe(static_cast<uint64_t>(subscriptionId));
}

void RillTenantManager::busUnsubscribeAll(TenantId tenantId) {
  eventBus_.unsubscribeAll(tenantId);
}

facebook::jsi::Object RillTenantManager::busGetStats(facebook::jsi::Runtime& rt) {
  auto stats = eventBus_.getStats();
  auto obj = facebook::jsi::Object(rt);
  obj.setProperty(rt, "totalPublished", static_cast<double>(stats.totalPublished));
  obj.setProperty(rt, "totalDelivered", static_cast<double>(stats.totalDelivered));
  obj.setProperty(rt, "totalDropped", static_cast<double>(stats.totalDropped));
  obj.setProperty(rt, "activeSubscriptions", static_cast<double>(stats.activeSubscriptions));
  obj.setProperty(rt, "activeChannels", static_cast<double>(stats.activeChannels));
  return obj;
}

void RillTenantManager::busCreateChannel(facebook::jsi::Runtime& rt,
                                         const facebook::jsi::Object& policy) {
  ChannelPolicy cp;
  cp.name = policy.getProperty(rt, "name").asString(rt).utf8(rt);

  if (policy.hasProperty(rt, "systemOnly")) {
    cp.systemOnly = policy.getProperty(rt, "systemOnly").asBool();
  }
  if (policy.hasProperty(rt, "requirePermission")) {
    cp.requirePermission = policy.getProperty(rt, "requirePermission").asBool();
  }
  if (policy.hasProperty(rt, "maxSubscribers")) {
    cp.maxSubscribers =
        static_cast<uint32_t>(policy.getProperty(rt, "maxSubscribers").asNumber());
  }
  if (policy.hasProperty(rt, "maxEventsPerSecond")) {
    cp.maxEventsPerSecond =
        static_cast<uint32_t>(policy.getProperty(rt, "maxEventsPerSecond").asNumber());
  }
  if (policy.hasProperty(rt, "maxPayloadBytes")) {
    cp.maxPayloadBytes =
        static_cast<size_t>(policy.getProperty(rt, "maxPayloadBytes").asNumber());
  }
  if (policy.hasProperty(rt, "persistent")) {
    cp.persistent = policy.getProperty(rt, "persistent").asBool();
  }

  eventBus_.createChannel(cp);
}

// --- Helpers ---

TenantHandle* RillTenantManager::getTenantOrThrow(TenantId id) {
  auto it = tenants_.find(id);
  if (it == tenants_.end()) {
    throw std::runtime_error(
        "[RillTenantManager] Tenant not found: " + std::to_string(id));
  }
  return it->second.get();
}

} // namespace rill::tenant_manager
