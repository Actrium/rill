# 安全沙箱

安全子系统按租户对网络和文件系统限制进行强制执行。每个租户可以被分配一个 `SecurityPolicy`,控制它可以发出哪些网络请求以及可以访问哪些文件。

## SecurityManager 架构

**文件:** `native/core/src/security/SecurityManager.h`

`SecurityManager` 由 `RillTenantManager` 拥有,并管理每个租户的安全上下文的生命周期。

### 职责

- 为每个租户创建 `NetworkSandbox` + `FileSandbox`
- 在租户拆除时销毁安全上下文
- 通过 `shared_ptr` 返回提供安全的并发访问
- 生成跨所有租户的全局审计报告

### API

| 方法 | 描述 |
|---|---|
| `createSecurityContext(tenantId, policy)` | 为租户创建沙箱 |
| `destroySecurityContext(tenantId)` | 清理和释放 |
| `getNetworkSandbox(tenantId)` | 返回 `shared_ptr<NetworkSandbox>`(如果未强制执行则为 nullptr) |
| `getFileSandbox(tenantId)` | 返回 `shared_ptr<FileSandbox>`(如果未强制执行则为 nullptr) |
| `hasSecurityContext(tenantId)` | 检查是否存在 |
| `activeContextCount()` | 活动上下文数量 |
| `getAuditReport()` | 跨所有租户的聚合网络审计 + 文件使用情况 |

### 安全策略

```cpp
struct SecurityPolicy {
  NetworkPolicy networkPolicy;
  FilePolicy filePolicy;
  bool enforced = true;  // false = 绕过所有检查(开发模式)
};
```

设置 `enforced: false` 会禁用租户的所有安全检查。这仅用于开发和调试。

## NetworkSandbox

**文件:** `native/core/src/security/NetworkSandbox.h`

每个租户的网络安全执行。根据可配置的策略验证每个出站请求。

### 网络策略

```cpp
struct NetworkPolicy {
  std::vector<std::string> allowedDomains;    // 通配符: "*.example.com"
  std::vector<std::string> blockedDomains;    // 在允许之前检查
  std::unordered_set<std::string> allowedSchemes = {"https"};
  bool allowInsecureHTTP = false;

  uint32_t maxRequestsPerMinute = 60;
  uint32_t maxConcurrentRequests = 6;
  size_t maxRequestBodyBytes = 1 * 1024 * 1024;      // 1MB
  size_t maxResponseBodyBytes = 10 * 1024 * 1024;     // 10MB

  std::unordered_set<std::string> forbiddenHeaders = {
      "cookie", "authorization", "x-api-key"
  };
  std::unordered_map<std::string, std::string> injectedHeaders;
};
```

### 验证管道

每个出站请求按顺序通过这些检查:

1. **Scheme 检查** -- URL scheme 必须在 `allowedSchemes` 中(默认: 仅 HTTPS)
2. **阻止域检查** -- 如果主机匹配任何 `blockedDomains` 模式,请求被拒绝
3. **允许域检查** -- 如果 `allowedDomains` 非空,主机必须匹配至少一个模式
4. **禁止头部检查** -- 扫描请求头以查找禁止的名称(不区分大小写)
5. **请求体大小检查** -- 正文不得超过 `maxRequestBodyBytes`
6. **速率限制检查** -- 过去 60 秒的滑动窗口计数器
7. **并发限制检查** -- 活动请求计数必须低于 `maxConcurrentRequests`

### 域通配符

`matchesDomain` 函数支持通配符模式:
- `"example.com"` -- 精确匹配
- `"*.example.com"` -- 匹配任何子域(例如 `api.example.com`、`cdn.example.com`)
- `"*.*.example.com"` -- 多级通配符

### 速率限制

使用滑动窗口方法。`std::deque<double>` 存储最近请求的时间戳。在每个新请求上,删除过期的时间戳(超过 60 秒),并检查剩余计数是否超过 `maxRequestsPerMinute`。

### 注入的头部

在 `injectedHeaders` 中指定的头部会自动添加到每个出站请求中。这可用于注入身份验证令牌或跟踪头部,而不将它们暴露给 guest 代码。

### 审计日志

环形缓冲区(`kMaxAuditEntries = 1000`)记录每次请求尝试:

```cpp
struct NetworkAuditEntry {
  uint64_t requestId;
  uint32_t tenantId;
  std::string url;
  std::string method;
  int statusCode;
  size_t requestBytes;
  size_t responseBytes;
  double latencyMs;
  double timestamp;
  std::string error;
  bool blocked;
  std::string blockReason;
};
```

### 统计信息

```cpp
struct Stats {
  uint64_t totalRequests;
  uint64_t blockedRequests;
  uint64_t failedRequests;
  size_t totalBytesIn;
  size_t totalBytesOut;
};
```

## FileSandbox

**文件:** `native/core/src/security/FileSandbox.h`

每个租户的文件系统限制。所有 guest 文件路径都相对于沙箱根目录解析。

### 文件策略

```cpp
struct FilePolicy {
  std::string sandboxRoot;   // 所有文件操作的根目录

  struct DirectoryQuota {
    std::string path;        // 相对于 sandboxRoot
    size_t maxBytes;         // 0 = 无限制
    bool readable;
    bool writable;
  };

  std::vector<DirectoryQuota> directories = {
    {"cache", 10 * 1024 * 1024, true, true},   // 10MB 读/写
    {"data",  50 * 1024 * 1024, true, true},    // 50MB 读/写
    {"tmp",    5 * 1024 * 1024, true, true},    //  5MB 读/写
    {"logs",   5 * 1024 * 1024, false, true},   //  5MB 仅写
  };
};
```

### 路径解析

Guest 代码提供相对路径(例如 `"data/user.json"`)。沙箱将这些解析为沙箱根目录下的绝对路径:

```
Guest 路径: "data/user.json"
解析后:     /app/sandbox/tenant-42/data/user.json
```

### 攻击向量防御

`canonicalizePath` 方法使用 C++17 `std::filesystem::weakly_canonical()` 来解析符号链接并规范化路径。三层防御防止从沙箱逃逸:

1. **规范路径解析** -- 解析 `..`、`.`、符号链接和 URL 编码序列
2. **白名单目录检查** -- 解析后的路径必须落在配置的 `DirectoryQuota` 条目之一下
3. **字符串前缀检查** -- 规范路径必须以规范沙箱根路径开始

防御的特定攻击向量:

| 攻击 | 防御 |
|---|---|
| 路径遍历(`../../../etc/passwd`) | 规范解析 + 前缀检查 |
| URL 编码(`%2e%2e%2f`) | 规范解析在检查前规范化 |
| 空字节注入(`data\x00/../secret`) | `weakly_canonical` 处理空字节 |
| Unicode 规范化攻击 | 文件系统级规范解析 |
| 符号链接逃逸 | `weakly_canonical` 解析符号链接 |
| 绝对路径注入(`/etc/passwd`) | 仅接受相对路径;拒绝绝对路径 |

### 目录配额

每个白名单目录都有:
- `maxBytes` -- 最大总字节数。`hasQuotaForWrite(path, bytes)` 检查当前使用情况 + 建议写入是否超过限制。
- `readable` / `writable` -- 由 `canRead` 和 `canWrite` 检查的权限标志。

### 沙箱化的文件操作

| 方法 | 描述 |
|---|---|
| `resolvePath(guestPath)` | 解析为绝对路径(如果非法则返回 nullopt) |
| `canRead(guestPath)` | 检查读权限 |
| `canWrite(guestPath)` | 检查写权限 |
| `hasQuotaForWrite(guestPath, bytes)` | 检查存储配额 |
| `readFile(guestPath)` | 读取文件内容 |
| `writeFile(guestPath, content)` | 写入文件 |
| `deleteFile(guestPath)` | 删除文件 |
| `listDirectory(guestPath)` | 列出目录内容 |
| `cleanup(deleteTempOnly)` | 清理租户文件 |
| `usedBytes(directory)` | 获取存储使用情况 |
