#include "test_framework.h"
#include "../src/security/FileSandbox.h"
#include <filesystem>
#include <fstream>

namespace fs = std::filesystem;
using namespace rill::security;
using namespace rill::test;

namespace {

std::string createTempSandboxRoot(const std::string& suffix) {
  auto path = fs::temp_directory_path() / ("rill_test_sandbox_" + suffix);
  fs::create_directories(path);
  return path.string();
}

void cleanupTempSandbox(const std::string& root) {
  std::error_code ec;
  fs::remove_all(root, ec);
}

TestSuite createFileSandboxTests() {
  TestSuite suite{"FileSandbox", {}};

  // --- Path resolution: valid ---

  suite.cases.push_back({"resolvePath: valid data path", []() {
    auto root = createTempSandboxRoot("resolve_valid");
    FilePolicy policy;
    policy.sandboxRoot = root;
    FileSandbox sandbox(1, policy);
    auto resolved = sandbox.resolvePath("data/user.json");
    assertTrue(resolved.has_value());
    cleanupTempSandbox(root);
  }});

  suite.cases.push_back({"resolvePath: valid cache path", []() {
    auto root = createTempSandboxRoot("resolve_cache");
    FilePolicy policy;
    policy.sandboxRoot = root;
    FileSandbox sandbox(1, policy);
    assertTrue(sandbox.resolvePath("cache/images/icon.png").has_value());
    cleanupTempSandbox(root);
  }});

  // --- Path resolution: attack vectors ---

  suite.cases.push_back({"resolvePath: reject empty path", []() {
    auto root = createTempSandboxRoot("reject_empty");
    FilePolicy policy;
    policy.sandboxRoot = root;
    FileSandbox sandbox(1, policy);
    assertFalse(sandbox.resolvePath("").has_value());
    cleanupTempSandbox(root);
  }});

  suite.cases.push_back({"resolvePath: reject absolute path", []() {
    auto root = createTempSandboxRoot("reject_abs");
    FilePolicy policy;
    policy.sandboxRoot = root;
    FileSandbox sandbox(1, policy);
    assertFalse(sandbox.resolvePath("/etc/passwd").has_value());
    cleanupTempSandbox(root);
  }});

  suite.cases.push_back({"resolvePath: reject ../ traversal", []() {
    auto root = createTempSandboxRoot("reject_dotdot");
    FilePolicy policy;
    policy.sandboxRoot = root;
    FileSandbox sandbox(1, policy);
    assertFalse(sandbox.resolvePath("../etc/passwd").has_value());
    cleanupTempSandbox(root);
  }});

  suite.cases.push_back({"resolvePath: reject multi-level traversal", []() {
    auto root = createTempSandboxRoot("reject_multi");
    FilePolicy policy;
    policy.sandboxRoot = root;
    FileSandbox sandbox(1, policy);
    assertFalse(sandbox.resolvePath("data/../../etc/passwd").has_value());
    cleanupTempSandbox(root);
  }});

  suite.cases.push_back({"resolvePath: reject null byte", []() {
    auto root = createTempSandboxRoot("reject_null");
    FilePolicy policy;
    policy.sandboxRoot = root;
    FileSandbox sandbox(1, policy);
    std::string malicious = std::string("data/ok.txt") + '\0' + "../../etc";
    assertFalse(sandbox.resolvePath(malicious).has_value());
    cleanupTempSandbox(root);
  }});

  suite.cases.push_back({"resolvePath: reject non-whitelisted dir", []() {
    auto root = createTempSandboxRoot("reject_nodir");
    FilePolicy policy;
    policy.sandboxRoot = root;
    FileSandbox sandbox(1, policy);
    assertFalse(sandbox.resolvePath("secret/data.json").has_value());
    cleanupTempSandbox(root);
  }});

  // --- Permissions ---

  suite.cases.push_back({"canRead: data directory readable", []() {
    auto root = createTempSandboxRoot("perm_read");
    FilePolicy policy;
    policy.sandboxRoot = root;
    FileSandbox sandbox(1, policy);
    assertTrue(sandbox.canRead("data/file.txt"));
    cleanupTempSandbox(root);
  }});

  suite.cases.push_back({"canRead: logs not readable (write-only)", []() {
    auto root = createTempSandboxRoot("perm_logs");
    FilePolicy policy;
    policy.sandboxRoot = root;
    FileSandbox sandbox(1, policy);
    assertFalse(sandbox.canRead("logs/app.log"));
    cleanupTempSandbox(root);
  }});

  suite.cases.push_back({"canWrite: data directory writable", []() {
    auto root = createTempSandboxRoot("perm_write");
    FilePolicy policy;
    policy.sandboxRoot = root;
    FileSandbox sandbox(1, policy);
    assertTrue(sandbox.canWrite("data/file.txt"));
    cleanupTempSandbox(root);
  }});

  suite.cases.push_back({"canWrite: traversal returns false", []() {
    auto root = createTempSandboxRoot("perm_traverse");
    FilePolicy policy;
    policy.sandboxRoot = root;
    FileSandbox sandbox(1, policy);
    assertFalse(sandbox.canWrite("../outside/file.txt"));
    cleanupTempSandbox(root);
  }});

  // --- File operations ---

  suite.cases.push_back({"writeFile + readFile round-trip", []() {
    auto root = createTempSandboxRoot("rw_roundtrip");
    FilePolicy policy;
    policy.sandboxRoot = root;
    FileSandbox sandbox(1, policy);
    assertTrue(sandbox.writeFile("data/test.txt", "hello world"));
    auto content = sandbox.readFile("data/test.txt");
    assertTrue(content.has_value());
    assertEqual(*content, std::string("hello world"));
    cleanupTempSandbox(root);
  }});

  suite.cases.push_back({"readFile: non-existent returns nullopt", []() {
    auto root = createTempSandboxRoot("read_nofile");
    FilePolicy policy;
    policy.sandboxRoot = root;
    FileSandbox sandbox(1, policy);
    assertFalse(sandbox.readFile("data/nonexistent.txt").has_value());
    cleanupTempSandbox(root);
  }});

  suite.cases.push_back({"readFile: logs blocked (write-only)", []() {
    auto root = createTempSandboxRoot("read_logs");
    FilePolicy policy;
    policy.sandboxRoot = root;
    FileSandbox sandbox(1, policy);
    sandbox.writeFile("logs/app.log", "log entry");
    assertFalse(sandbox.readFile("logs/app.log").has_value());
    cleanupTempSandbox(root);
  }});

  suite.cases.push_back({"deleteFile: removes file", []() {
    auto root = createTempSandboxRoot("delete");
    FilePolicy policy;
    policy.sandboxRoot = root;
    FileSandbox sandbox(1, policy);
    sandbox.writeFile("data/del.txt", "content");
    assertTrue(sandbox.deleteFile("data/del.txt"));
    assertFalse(sandbox.readFile("data/del.txt").has_value());
    cleanupTempSandbox(root);
  }});

  suite.cases.push_back({"listDirectory: returns sorted entries", []() {
    auto root = createTempSandboxRoot("listdir");
    FilePolicy policy;
    policy.sandboxRoot = root;
    FileSandbox sandbox(1, policy);
    sandbox.writeFile("data/b.txt", "b");
    sandbox.writeFile("data/a.txt", "a");
    sandbox.writeFile("data/c.txt", "c");
    auto entries = sandbox.listDirectory("data");
    assertEqual(entries.size(), static_cast<size_t>(3));
    assertEqual(entries[0], std::string("a.txt"));
    assertEqual(entries[1], std::string("b.txt"));
    assertEqual(entries[2], std::string("c.txt"));
    cleanupTempSandbox(root);
  }});

  // --- Quota ---

  suite.cases.push_back({"hasQuotaForWrite: within quota", []() {
    auto root = createTempSandboxRoot("quota_ok");
    FilePolicy policy;
    policy.sandboxRoot = root;
    policy.directories = {{"data", 1024, true, true}};
    FileSandbox sandbox(1, policy);
    assertTrue(sandbox.hasQuotaForWrite("data/file.txt", 100));
    cleanupTempSandbox(root);
  }});

  suite.cases.push_back({"hasQuotaForWrite: exceeds quota", []() {
    auto root = createTempSandboxRoot("quota_exceed");
    FilePolicy policy;
    policy.sandboxRoot = root;
    policy.directories = {{"data", 200, true, true}};
    FileSandbox sandbox(1, policy);
    sandbox.writeFile("data/big.txt", std::string(150, 'x'));
    assertFalse(sandbox.hasQuotaForWrite("data/more.txt", 100));
    cleanupTempSandbox(root);
  }});

  suite.cases.push_back({"writeFile: blocked by quota", []() {
    auto root = createTempSandboxRoot("quota_block");
    FilePolicy policy;
    policy.sandboxRoot = root;
    policy.directories = {{"data", 100, true, true}};
    FileSandbox sandbox(1, policy);
    assertTrue(sandbox.writeFile("data/a.txt", std::string(50, 'a')));
    assertFalse(sandbox.writeFile("data/b.txt", std::string(60, 'b')));
    cleanupTempSandbox(root);
  }});

  suite.cases.push_back({"writeFile: unlimited quota (maxBytes=0)", []() {
    auto root = createTempSandboxRoot("quota_unlimited");
    FilePolicy policy;
    policy.sandboxRoot = root;
    policy.directories = {{"data", 0, true, true}};
    FileSandbox sandbox(1, policy);
    assertTrue(sandbox.writeFile("data/big.txt", std::string(10000, 'x')));
    cleanupTempSandbox(root);
  }});

  // --- Cleanup ---

  suite.cases.push_back({"cleanup: removes all files", []() {
    auto root = createTempSandboxRoot("cleanup_all");
    FilePolicy policy;
    policy.sandboxRoot = root;
    FileSandbox sandbox(1, policy);
    sandbox.writeFile("data/a.txt", "a");
    sandbox.writeFile("cache/b.txt", "b");
    sandbox.cleanup(false);
    assertFalse(fs::exists(root));
  }});

  suite.cases.push_back({"cleanup: deleteTempOnly clears only tmp", []() {
    auto root = createTempSandboxRoot("cleanup_tmp");
    FilePolicy policy;
    policy.sandboxRoot = root;
    FileSandbox sandbox(1, policy);
    sandbox.writeFile("data/keep.txt", "keep");
    sandbox.writeFile("tmp/discard.txt", "discard");
    sandbox.cleanup(true);
    assertTrue(sandbox.readFile("data/keep.txt").has_value());
    auto tmpEntries = sandbox.listDirectory("tmp");
    assertEqual(tmpEntries.size(), static_cast<size_t>(0));
    cleanupTempSandbox(root);
  }});

  // --- usedBytes ---

  suite.cases.push_back({"usedBytes: reports correct total", []() {
    auto root = createTempSandboxRoot("usedbytes");
    FilePolicy policy;
    policy.sandboxRoot = root;
    FileSandbox sandbox(1, policy);
    sandbox.writeFile("data/file.txt", "12345");
    assertEqual(sandbox.usedBytes("data"), static_cast<size_t>(5));
    cleanupTempSandbox(root);
  }});

  // --- Symlink escape ---

  suite.cases.push_back({"resolvePath: reject symlink escape", []() {
    auto root = createTempSandboxRoot("symlink_escape");
    FilePolicy policy;
    policy.sandboxRoot = root;
    FileSandbox sandbox(1, policy);
    std::error_code ec;
    fs::path linkPath = fs::path(root) / "data" / "escape_link";
    fs::create_symlink("/tmp", linkPath, ec);
    if (!ec) {
      assertFalse(sandbox.resolvePath("data/escape_link/file.txt").has_value());
    }
    cleanupTempSandbox(root);
  }});

  return suite;
}

} // anonymous namespace

void registerFileSandboxTests() {
  TestRunner::instance().addSuite(createFileSandboxTests());
}
