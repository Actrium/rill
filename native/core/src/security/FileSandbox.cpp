// WIP subsystem — gated behind RILL_WIP_NATIVE_SECURITY (off by default in production builds).
// Rationale, goals, current status, and completion TODO live in security/SecurityManager.h.
#if RILL_WIP_NATIVE_SECURITY
#include "FileSandbox.h"
#include <algorithm>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <stdexcept>

namespace fs = std::filesystem;

namespace rill::security {

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

FileSandbox::FileSandbox(uint32_t tenantId, const FilePolicy& policy)
    : tenantId_(tenantId), policy_(policy) {
  // Guard: empty sandboxRoot would resolve to cwd via weakly_canonical(""),
  // causing cleanup() to recursively delete the working directory.
  if (policy.sandboxRoot.empty()) {
    throw std::invalid_argument(
        "FileSandbox: sandboxRoot must not be empty (would resolve to cwd)");
  }

  // Ensure sandbox root exists.
  std::error_code ec;
  fs::create_directories(policy.sandboxRoot, ec);

  // Canonicalize the root path (resolves symlinks for the existing portion).
  rootPath_ = fs::weakly_canonical(fs::path(policy.sandboxRoot), ec).string();
  if (ec) {
    rootPath_ = policy.sandboxRoot;  // Fallback to raw path.
  }

  // Ensure whitelisted subdirectories exist.
  for (const auto& dir : policy_.directories) {
    fs::create_directories(fs::path(rootPath_) / dir.path, ec);
  }
}

// ---------------------------------------------------------------------------
// Path resolution (core security logic)
// ---------------------------------------------------------------------------

std::optional<std::string> FileSandbox::canonicalizePath(
    const std::string& guestPath) const {
  // 1. Reject empty path and null bytes.
  if (guestPath.empty()) return std::nullopt;
  if (guestPath.find('\0') != std::string::npos) return std::nullopt;

  // 2. Reject absolute paths (guest must use relative paths only).
  //    Use std::filesystem for cross-platform detection (handles Unix /, Windows C:\, UNC \\).
  if (fs::path(guestPath).is_absolute()) return std::nullopt;

  // 3. Join sandbox root + guest path.
  fs::path joined = fs::path(rootPath_) / guestPath;

  // 4. Canonicalize (weakly_canonical handles non-existent tail segments).
  std::error_code ec;
  fs::path resolved = fs::weakly_canonical(joined, ec);
  if (ec) return std::nullopt;

  // 5. Verify the resolved path is within the sandbox.
  std::string resolvedStr = resolved.string();
  if (!isWithinSandbox(resolvedStr)) return std::nullopt;

  return resolvedStr;
}

bool FileSandbox::isWithinSandbox(const std::string& canonicalPath) const {
  // The canonical path must start with the sandbox root.
  if (canonicalPath.size() <= rootPath_.size()) return false;
  if (canonicalPath.compare(0, rootPath_.size(), rootPath_) != 0) return false;
  // The character right after root must be a separator.
  char sep = canonicalPath[rootPath_.size()];
  return sep == '/' || sep == '\\';
}

const FilePolicy::DirectoryQuota* FileSandbox::findDirectory(
    const std::string& canonicalPath) const {
  // Extract the first path component after sandbox root.
  std::string relative = canonicalPath.substr(rootPath_.size() + 1);
  auto slashPos = relative.find('/');
  std::string topDir =
      (slashPos == std::string::npos) ? relative : relative.substr(0, slashPos);

  for (const auto& dir : policy_.directories) {
    if (dir.path == topDir) return &dir;
  }
  return nullptr;
}

// ---------------------------------------------------------------------------
// Public path resolution
// ---------------------------------------------------------------------------

std::optional<std::string> FileSandbox::resolvePath(
    const std::string& guestPath) const {
  std::lock_guard<std::mutex> lock(mutex_);

  // Layer 1: Canonicalize.
  auto canonical = canonicalizePath(guestPath);
  if (!canonical) return std::nullopt;

  // Layer 2: Must be in a whitelisted directory.
  auto* dir = findDirectory(*canonical);
  if (!dir) return std::nullopt;

  // Layer 3: String prefix double-check.
  if (canonical->compare(0, rootPath_.size(), rootPath_) != 0) {
    return std::nullopt;
  }

  return canonical;
}

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

bool FileSandbox::canRead(const std::string& guestPath) const {
  std::lock_guard<std::mutex> lock(mutex_);
  auto canonical = canonicalizePath(guestPath);
  if (!canonical) return false;
  auto* dir = findDirectory(*canonical);
  return dir && dir->readable;
}

bool FileSandbox::canWrite(const std::string& guestPath) const {
  std::lock_guard<std::mutex> lock(mutex_);
  auto canonical = canonicalizePath(guestPath);
  if (!canonical) return false;
  auto* dir = findDirectory(*canonical);
  return dir && dir->writable;
}

bool FileSandbox::hasQuotaForWrite(const std::string& guestPath,
                                    size_t bytes) const {
  std::lock_guard<std::mutex> lock(mutex_);
  auto canonical = canonicalizePath(guestPath);
  if (!canonical) return false;
  auto* dir = findDirectory(*canonical);
  if (!dir || !dir->writable) return false;
  if (dir->maxBytes == 0) return true;  // Unlimited.

  // Calculate current usage of this directory.
  fs::path dirPath = fs::path(rootPath_) / dir->path;
  std::error_code ec;
  size_t currentUsage = 0;
  for (const auto& entry : fs::recursive_directory_iterator(dirPath, ec)) {
    if (entry.is_regular_file(ec)) {
      currentUsage += entry.file_size(ec);
    }
  }
  return (currentUsage + bytes) <= dir->maxBytes;
}

// ---------------------------------------------------------------------------
// File operations
// ---------------------------------------------------------------------------

std::optional<std::string> FileSandbox::readFile(
    const std::string& guestPath) const {
  std::lock_guard<std::mutex> lock(mutex_);
  auto canonical = canonicalizePath(guestPath);
  if (!canonical) return std::nullopt;

  auto* dir = findDirectory(*canonical);
  if (!dir || !dir->readable) return std::nullopt;

  std::ifstream ifs(*canonical);
  if (!ifs.is_open()) return std::nullopt;

  std::ostringstream ss;
  ss << ifs.rdbuf();
  return ss.str();
}

bool FileSandbox::writeFile(const std::string& guestPath,
                             const std::string& content) {
  std::lock_guard<std::mutex> lock(mutex_);
  auto canonical = canonicalizePath(guestPath);
  if (!canonical) return false;

  auto* dir = findDirectory(*canonical);
  if (!dir || !dir->writable) return false;

  // Quota check.
  if (dir->maxBytes > 0) {
    fs::path dirPath = fs::path(rootPath_) / dir->path;
    std::error_code ec;
    size_t currentUsage = 0;
    for (const auto& entry : fs::recursive_directory_iterator(dirPath, ec)) {
      if (entry.is_regular_file(ec)) {
        currentUsage += entry.file_size(ec);
      }
    }
    // Subtract existing file size if overwriting.
    fs::path filePath(*canonical);
    if (fs::exists(filePath, ec) && fs::is_regular_file(filePath, ec)) {
      currentUsage -= fs::file_size(filePath, ec);
    }
    if (currentUsage + content.size() > dir->maxBytes) return false;
  }

  // Ensure parent directory exists.
  fs::path filePath(*canonical);
  std::error_code ec;
  fs::create_directories(filePath.parent_path(), ec);

  std::ofstream ofs(*canonical, std::ios::binary | std::ios::trunc);
  if (!ofs.is_open()) return false;
  ofs.write(content.data(), static_cast<std::streamsize>(content.size()));
  return ofs.good();
}

bool FileSandbox::deleteFile(const std::string& guestPath) {
  std::lock_guard<std::mutex> lock(mutex_);
  auto canonical = canonicalizePath(guestPath);
  if (!canonical) return false;

  auto* dir = findDirectory(*canonical);
  if (!dir || !dir->writable) return false;

  std::error_code ec;
  return fs::remove(*canonical, ec);
}

std::vector<std::string> FileSandbox::listDirectory(
    const std::string& guestPath) const {
  std::lock_guard<std::mutex> lock(mutex_);
  auto canonical = canonicalizePath(guestPath);
  if (!canonical) return {};

  auto* dir = findDirectory(*canonical);
  if (!dir || !dir->readable) return {};

  std::vector<std::string> result;
  std::error_code ec;
  for (const auto& entry : fs::directory_iterator(*canonical, ec)) {
    result.push_back(entry.path().filename().string());
  }
  std::sort(result.begin(), result.end());
  return result;
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

void FileSandbox::cleanup(bool deleteTempOnly) {
  std::lock_guard<std::mutex> lock(mutex_);
  std::error_code ec;
  if (deleteTempOnly) {
    fs::path tmpPath = fs::path(rootPath_) / "tmp";
    fs::remove_all(tmpPath, ec);
    fs::create_directories(tmpPath, ec);
  } else {
    fs::remove_all(rootPath_, ec);
  }
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

size_t FileSandbox::usedBytes(const std::string& directory) const {
  std::lock_guard<std::mutex> lock(mutex_);
  fs::path target = directory.empty() ? fs::path(rootPath_)
                                      : fs::path(rootPath_) / directory;
  std::error_code ec;
  size_t total = 0;
  for (const auto& entry : fs::recursive_directory_iterator(target, ec)) {
    if (entry.is_regular_file(ec)) {
      total += entry.file_size(ec);
    }
  }
  return total;
}

std::string FileSandbox::rootPath() const {
  return rootPath_;
}

FilePolicy FileSandbox::getPolicy() const {
  std::lock_guard<std::mutex> lock(mutex_);
  return policy_;
}

} // namespace rill::security
#endif // RILL_WIP_NATIVE_SECURITY
