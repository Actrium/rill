#pragma once
#include <cstddef>
#include <cstdint>
#include <mutex>
#include <optional>
#include <string>
#include <vector>

namespace rill::security {

/// File system policy for a tenant sandbox.
struct FilePolicy {
  /// Root directory for all file operations.
  /// All guest paths are resolved relative to this.
  std::string sandboxRoot;

  /// Per-subdirectory quota and permissions.
  struct DirectoryQuota {
    std::string path;      // Relative to sandboxRoot (e.g. "cache", "data")
    size_t maxBytes = 0;   // 0 = unlimited
    bool readable = true;
    bool writable = true;
  };
  std::vector<DirectoryQuota> directories = {
      {"cache", 10 * 1024 * 1024, true, true},   // 10MB
      {"data", 50 * 1024 * 1024, true, true},     // 50MB
      {"tmp", 5 * 1024 * 1024, true, true},       //  5MB
      {"logs", 5 * 1024 * 1024, false, true},     //  5MB write-only
  };
};

/// Per-tenant file sandbox that enforces path confinement, directory
/// whitelisting, read/write permissions, and storage quotas.
class FileSandbox {
public:
  FileSandbox(uint32_t tenantId, const FilePolicy& policy);

  /// Resolve a guest-relative path to an absolute host path.
  /// Returns std::nullopt if the path is illegal (traversal, outside sandbox,
  /// not in a whitelisted directory).
  std::optional<std::string> resolvePath(const std::string& guestPath) const;

  /// Permission checks.
  bool canRead(const std::string& guestPath) const;
  bool canWrite(const std::string& guestPath) const;

  /// Quota check: can we write `bytes` to the directory containing guestPath?
  bool hasQuotaForWrite(const std::string& guestPath, size_t bytes) const;

  /// Sandboxed file operations.
  std::optional<std::string> readFile(const std::string& guestPath) const;
  bool writeFile(const std::string& guestPath, const std::string& content);
  bool deleteFile(const std::string& guestPath);
  std::vector<std::string> listDirectory(const std::string& guestPath) const;

  /// Cleanup tenant files.
  /// If deleteTempOnly=true, only remove "tmp" directory contents.
  void cleanup(bool deleteTempOnly = false);

  /// Get total bytes used under a directory (empty = all directories).
  size_t usedBytes(const std::string& directory = "") const;

  /// Get the canonical sandbox root path.
  std::string rootPath() const;

  /// Get policy (for inspection/testing).
  FilePolicy getPolicy() const;

private:
  /// Canonicalize a guest path and verify it stays within the sandbox.
  /// Uses std::filesystem::weakly_canonical for symlink-safe resolution.
  std::optional<std::string> canonicalizePath(
      const std::string& guestPath) const;

  /// Check that a canonical path is within the sandbox root.
  bool isWithinSandbox(const std::string& canonicalPath) const;

  /// Find the top-level whitelisted directory for a resolved path.
  /// Returns nullptr if not in any whitelisted directory.
  const FilePolicy::DirectoryQuota* findDirectory(
      const std::string& canonicalPath) const;

  [[maybe_unused]] uint32_t tenantId_;
  FilePolicy policy_;
  std::string rootPath_;  // Canonical absolute sandbox root
  mutable std::mutex mutex_;
};

} // namespace rill::security
