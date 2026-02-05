# Security Sandbox

The security subsystem enforces network and filesystem restrictions on a per-tenant basis. Each tenant can be assigned a `SecurityPolicy` that controls what network requests it can make and what files it can access.

## SecurityManager Architecture

**File:** `native/core/src/security/SecurityManager.h`

`SecurityManager` is owned by `RillOrchestrator` and manages the lifecycle of per-tenant security contexts.

### Responsibilities

- Create `NetworkSandbox` + `FileSandbox` for each tenant
- Destroy security contexts on tenant teardown
- Provide safe concurrent access via `shared_ptr` returns
- Generate global audit reports across all tenants

### API

| Method | Description |
|---|---|
| `createSecurityContext(tenantId, policy)` | Create sandboxes for a tenant |
| `destroySecurityContext(tenantId)` | Cleanup and release |
| `getNetworkSandbox(tenantId)` | Returns `shared_ptr<NetworkSandbox>` (nullptr if not enforced) |
| `getFileSandbox(tenantId)` | Returns `shared_ptr<FileSandbox>` (nullptr if not enforced) |
| `hasSecurityContext(tenantId)` | Check existence |
| `activeContextCount()` | Number of active contexts |
| `getAuditReport()` | Aggregated network audit + file usage across all tenants |

### Security Policy

```cpp
struct SecurityPolicy {
  NetworkPolicy networkPolicy;
  FilePolicy filePolicy;
  bool enforced = true;  // false = bypass all checks (dev mode)
};
```

Setting `enforced: false` disables all security checks for a tenant. This is intended for development and debugging only.

## NetworkSandbox

**File:** `native/core/src/security/NetworkSandbox.h`

Per-tenant network security enforcement. Validates every outbound request against a configurable policy.

### Network Policy

```cpp
struct NetworkPolicy {
  std::vector<std::string> allowedDomains;    // Wildcard: "*.example.com"
  std::vector<std::string> blockedDomains;    // Checked before allowed
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

### Validation Pipeline

Each outbound request passes through these checks in order:

1. **Scheme check** -- URL scheme must be in `allowedSchemes` (default: HTTPS only)
2. **Blocked domain check** -- If the host matches any `blockedDomains` pattern, the request is rejected
3. **Allowed domain check** -- If `allowedDomains` is non-empty, the host must match at least one pattern
4. **Forbidden header check** -- Request headers are scanned for forbidden names (case-insensitive)
5. **Request body size check** -- Body must not exceed `maxRequestBodyBytes`
6. **Rate limit check** -- Sliding window counter over the last 60 seconds
7. **Concurrency limit check** -- Active request count must be below `maxConcurrentRequests`

### Domain Wildcards

The `matchesDomain` function supports wildcard patterns:
- `"example.com"` -- Exact match
- `"*.example.com"` -- Matches any subdomain (e.g., `api.example.com`, `cdn.example.com`)
- `"*.*.example.com"` -- Multi-level wildcard

### Rate Limiting

Uses a sliding window approach. A `std::deque<double>` stores timestamps of recent requests. On each new request, expired timestamps (older than 60 seconds) are removed, and the remaining count is checked against `maxRequestsPerMinute`.

### Injected Headers

Headers specified in `injectedHeaders` are automatically added to every outbound request. This can be used to inject authentication tokens or tracking headers without exposing them to guest code.

### Audit Logging

A ring buffer (`kMaxAuditEntries = 1000`) records every request attempt:

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

### Statistics

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

**File:** `native/core/src/security/FileSandbox.h`

Per-tenant filesystem confinement. All guest file paths are resolved relative to a sandbox root directory.

### File Policy

```cpp
struct FilePolicy {
  std::string sandboxRoot;   // Root directory for all file operations

  struct DirectoryQuota {
    std::string path;        // Relative to sandboxRoot
    size_t maxBytes;         // 0 = unlimited
    bool readable;
    bool writable;
  };

  std::vector<DirectoryQuota> directories = {
    {"cache", 10 * 1024 * 1024, true, true},   // 10MB read/write
    {"data",  50 * 1024 * 1024, true, true},    // 50MB read/write
    {"tmp",    5 * 1024 * 1024, true, true},    //  5MB read/write
    {"logs",   5 * 1024 * 1024, false, true},   //  5MB write-only
  };
};
```

### Path Resolution

Guest code provides relative paths (e.g., `"data/user.json"`). The sandbox resolves these to absolute paths under the sandbox root:

```
Guest path: "data/user.json"
Resolved:   /app/sandbox/tenant-42/data/user.json
```

### Attack Vector Defense

The `canonicalizePath` method uses C++17 `std::filesystem::weakly_canonical()` to resolve symlinks and normalize paths. Three layers of defense prevent escape from the sandbox:

1. **Canonical path resolution** -- Resolves `..`, `.`, symlinks, and URL-encoded sequences
2. **Whitelist directory check** -- The resolved path must fall under one of the configured `DirectoryQuota` entries
3. **String prefix check** -- The canonical path must start with the canonical sandbox root path

Specific attack vectors defended:

| Attack | Defense |
|---|---|
| Path traversal (`../../../etc/passwd`) | Canonical resolution + prefix check |
| URL encoding (`%2e%2e%2f`) | Canonical resolution normalizes before check |
| Null byte injection (`data\x00/../secret`) | `weakly_canonical` handles null bytes |
| Unicode normalization attacks | Filesystem-level canonical resolution |
| Symlink escape | `weakly_canonical` resolves symlinks |
| Absolute path injection (`/etc/passwd`) | Only relative paths accepted; absolute paths rejected |

### Directory Quotas

Each whitelisted directory has:
- `maxBytes` -- Maximum total bytes. `hasQuotaForWrite(path, bytes)` checks current usage + proposed write against the limit.
- `readable` / `writable` -- Permission flags checked by `canRead` and `canWrite`.

### Sandboxed File Operations

| Method | Description |
|---|---|
| `resolvePath(guestPath)` | Resolve to absolute path (returns nullopt if illegal) |
| `canRead(guestPath)` | Check read permission |
| `canWrite(guestPath)` | Check write permission |
| `hasQuotaForWrite(guestPath, bytes)` | Check storage quota |
| `readFile(guestPath)` | Read file contents |
| `writeFile(guestPath, content)` | Write file |
| `deleteFile(guestPath)` | Delete file |
| `listDirectory(guestPath)` | List directory contents |
| `cleanup(deleteTempOnly)` | Clean up tenant files |
| `usedBytes(directory)` | Get storage usage |
