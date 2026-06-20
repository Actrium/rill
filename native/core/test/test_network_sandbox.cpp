#include "test_framework.h"
#include "../src/security/NetworkSandbox.h"

using namespace rill::security;
using namespace rill::test;

namespace {

TestSuite createNetworkSandboxTests() {
  TestSuite suite{"NetworkSandbox", {}};

  // --- URL parsing ---

  suite.cases.push_back({"extractScheme: https", []() {
    assertEqual(NetworkSandbox::extractScheme("https://example.com"),
                std::string("https"));
  }});

  suite.cases.push_back({"extractScheme: http", []() {
    assertEqual(NetworkSandbox::extractScheme("http://example.com/path"),
                std::string("http"));
  }});

  suite.cases.push_back({"extractScheme: missing returns empty", []() {
    assertEqual(NetworkSandbox::extractScheme("example.com"),
                std::string(""));
  }});

  suite.cases.push_back({"extractHost: simple domain", []() {
    assertEqual(NetworkSandbox::extractHost("https://api.example.com/v1"),
                std::string("api.example.com"));
  }});

  suite.cases.push_back({"extractHost: with port", []() {
    assertEqual(NetworkSandbox::extractHost("https://localhost:3000/path"),
                std::string("localhost"));
  }});

  suite.cases.push_back({"extractHost: with userinfo", []() {
    assertEqual(NetworkSandbox::extractHost("https://user:pass@host.com/path"),
                std::string("host.com"));
  }});

  suite.cases.push_back({"extractHost: missing returns empty", []() {
    assertEqual(NetworkSandbox::extractHost("not-a-url"),
                std::string(""));
  }});

  // --- Domain matching ---

  suite.cases.push_back({"matchesDomain: exact match", []() {
    assertTrue(NetworkSandbox::matchesDomain("example.com", "example.com"));
  }});

  suite.cases.push_back({"matchesDomain: case insensitive", []() {
    assertTrue(NetworkSandbox::matchesDomain("Example.COM", "example.com"));
  }});

  suite.cases.push_back({"matchesDomain: wildcard matches subdomain", []() {
    assertTrue(NetworkSandbox::matchesDomain("api.example.com", "*.example.com"));
  }});

  suite.cases.push_back({"matchesDomain: wildcard matches deep subdomain", []() {
    assertTrue(NetworkSandbox::matchesDomain("a.b.example.com", "*.example.com"));
  }});

  suite.cases.push_back({"matchesDomain: wildcard not match root", []() {
    assertFalse(NetworkSandbox::matchesDomain("example.com", "*.example.com"));
  }});

  suite.cases.push_back({"matchesDomain: different domain no match", []() {
    assertFalse(NetworkSandbox::matchesDomain("evil.com", "*.example.com"));
  }});

  suite.cases.push_back({"matchesDomain: empty pattern no match", []() {
    assertFalse(NetworkSandbox::matchesDomain("example.com", ""));
  }});

  // --- Scheme validation ---

  suite.cases.push_back({"validateRequest: HTTPS allowed", []() {
    NetworkPolicy policy;
    NetworkSandbox sandbox(policy);
    NetworkRequest req;
    req.url = "https://example.com/api";
    req.method = "GET";
    auto result = sandbox.validateRequest(req);
    assertFalse(result.has_value());
  }});

  suite.cases.push_back({"validateRequest: HTTP blocked by default", []() {
    NetworkPolicy policy;
    NetworkSandbox sandbox(policy);
    NetworkRequest req;
    req.url = "http://example.com/api";
    auto result = sandbox.validateRequest(req);
    assertTrue(result.has_value());
  }});

  suite.cases.push_back({"validateRequest: HTTP allowed when enabled", []() {
    NetworkPolicy policy;
    policy.allowInsecureHTTP = true;
    policy.allowedSchemes.insert("http");
    NetworkSandbox sandbox(policy);
    NetworkRequest req;
    req.url = "http://example.com/api";
    assertFalse(sandbox.validateRequest(req).has_value());
  }});

  suite.cases.push_back({"validateRequest: unknown scheme rejected", []() {
    NetworkPolicy policy;
    NetworkSandbox sandbox(policy);
    NetworkRequest req;
    req.url = "ftp://files.example.com/data";
    assertTrue(sandbox.validateRequest(req).has_value());
  }});

  suite.cases.push_back({"validateRequest: missing scheme rejected", []() {
    NetworkPolicy policy;
    NetworkSandbox sandbox(policy);
    NetworkRequest req;
    req.url = "example.com";
    assertTrue(sandbox.validateRequest(req).has_value());
  }});

  // --- IP address rejection ---

  suite.cases.push_back({"validateRequest: raw IPv4 rejected", []() {
    NetworkPolicy policy;
    NetworkSandbox sandbox(policy);
    NetworkRequest req;
    req.url = "https://192.168.1.1/api";
    auto result = sandbox.validateRequest(req);
    assertTrue(result.has_value());
  }});

  // --- Domain allow/block ---

  suite.cases.push_back({"validateRequest: blocked domain rejected", []() {
    NetworkPolicy policy;
    policy.blockedDomains = {"localhost", "*.internal.com"};
    NetworkSandbox sandbox(policy);
    NetworkRequest req;
    req.url = "https://localhost/api";
    assertTrue(sandbox.validateRequest(req).has_value());
  }});

  suite.cases.push_back({"validateRequest: blocked wildcard domain", []() {
    NetworkPolicy policy;
    policy.blockedDomains = {"*.internal.com"};
    NetworkSandbox sandbox(policy);
    NetworkRequest req;
    req.url = "https://secret.internal.com/data";
    assertTrue(sandbox.validateRequest(req).has_value());
  }});

  suite.cases.push_back({"validateRequest: allowed domain passes", []() {
    NetworkPolicy policy;
    policy.allowedDomains = {"*.example.com", "api.starbucks.com"};
    NetworkSandbox sandbox(policy);
    NetworkRequest req;
    req.url = "https://api.example.com/v1";
    assertFalse(sandbox.validateRequest(req).has_value());
  }});

  suite.cases.push_back({"validateRequest: domain not in allowlist", []() {
    NetworkPolicy policy;
    policy.allowedDomains = {"*.example.com"};
    NetworkSandbox sandbox(policy);
    NetworkRequest req;
    req.url = "https://evil.com/steal";
    assertTrue(sandbox.validateRequest(req).has_value());
  }});

  suite.cases.push_back({"validateRequest: empty allowlist allows all", []() {
    NetworkPolicy policy;
    NetworkSandbox sandbox(policy);
    NetworkRequest req;
    req.url = "https://any-domain.com/path";
    assertFalse(sandbox.validateRequest(req).has_value());
  }});

  // --- Forbidden headers ---

  suite.cases.push_back({"validateRequest: forbidden header blocked", []() {
    NetworkPolicy policy;
    NetworkSandbox sandbox(policy);
    NetworkRequest req;
    req.url = "https://example.com/api";
    req.headers["Cookie"] = "session=abc";
    assertTrue(sandbox.validateRequest(req).has_value());
  }});

  suite.cases.push_back({"validateRequest: normal header allowed", []() {
    NetworkPolicy policy;
    NetworkSandbox sandbox(policy);
    NetworkRequest req;
    req.url = "https://example.com/api";
    req.headers["Content-Type"] = "application/json";
    assertFalse(sandbox.validateRequest(req).has_value());
  }});

  // --- Body size ---

  suite.cases.push_back({"validateRequest: body too large", []() {
    NetworkPolicy policy;
    policy.maxRequestBodyBytes = 100;
    NetworkSandbox sandbox(policy);
    NetworkRequest req;
    req.url = "https://example.com/upload";
    req.bodyBytes = 200;
    assertTrue(sandbox.validateRequest(req).has_value());
  }});

  // --- Rate limiting ---

  suite.cases.push_back({"validateRequest: rate limiting kicks in", []() {
    NetworkPolicy policy;
    policy.maxRequestsPerMinute = 3;
    NetworkSandbox sandbox(policy);
    NetworkRequest req;
    req.url = "https://example.com/api";

    for (int i = 0; i < 3; ++i) {
      assertFalse(sandbox.validateRequest(req).has_value());
      sandbox.requestCompleted();
    }
    assertTrue(sandbox.validateRequest(req).has_value());
  }});

  // --- Concurrency limiting ---

  suite.cases.push_back({"validateRequest: concurrency limit", []() {
    NetworkPolicy policy;
    policy.maxConcurrentRequests = 2;
    NetworkSandbox sandbox(policy);
    NetworkRequest req;
    req.url = "https://example.com/api";

    assertFalse(sandbox.validateRequest(req).has_value());
    assertFalse(sandbox.validateRequest(req).has_value());
    assertTrue(sandbox.validateRequest(req).has_value());

    sandbox.requestCompleted();
    assertFalse(sandbox.validateRequest(req).has_value());
  }});

  // --- Response validation ---

  suite.cases.push_back({"validateResponse: body too large", []() {
    NetworkPolicy policy;
    policy.maxResponseBodyBytes = 500;
    NetworkSandbox sandbox(policy);
    NetworkRequest req;
    assertTrue(sandbox.validateResponse(req, 200, 1000).has_value());
  }});

  suite.cases.push_back({"validateResponse: normal OK", []() {
    NetworkPolicy policy;
    NetworkSandbox sandbox(policy);
    NetworkRequest req;
    assertFalse(sandbox.validateResponse(req, 200, 100).has_value());
  }});

  suite.cases.push_back({"validateResponse: 4xx counted as failed", []() {
    NetworkPolicy policy;
    NetworkSandbox sandbox(policy);
    NetworkRequest req;
    sandbox.validateResponse(req, 404, 50);
    assertEqual(sandbox.getStats().failedRequests, static_cast<uint64_t>(1));
  }});

  // --- Audit logging ---

  suite.cases.push_back({"recordAudit + getRecentAudit", []() {
    NetworkPolicy policy;
    NetworkSandbox sandbox(policy);

    NetworkAuditEntry e1;
    e1.requestId = 1;
    e1.url = "https://a.com";
    sandbox.recordAudit(e1);

    NetworkAuditEntry e2;
    e2.requestId = 2;
    e2.url = "https://b.com";
    sandbox.recordAudit(e2);

    auto recent = sandbox.getRecentAudit(10);
    assertEqual(recent.size(), static_cast<size_t>(2));
    assertEqual(recent[0].requestId, static_cast<uint64_t>(2));
    assertEqual(recent[1].requestId, static_cast<uint64_t>(1));
  }});

  suite.cases.push_back({"audit ring buffer wraps", []() {
    NetworkPolicy policy;
    NetworkSandbox sandbox(policy);

    for (uint64_t i = 0; i < 1005; ++i) {
      NetworkAuditEntry e;
      e.requestId = i;
      sandbox.recordAudit(e);
    }
    auto recent = sandbox.getRecentAudit(5);
    assertEqual(recent.size(), static_cast<size_t>(5));
    assertEqual(recent[0].requestId, static_cast<uint64_t>(1004));
  }});

  // --- Stats ---

  suite.cases.push_back({"getStats: tracks totals", []() {
    NetworkPolicy policy;
    NetworkSandbox sandbox(policy);
    NetworkRequest req;
    req.url = "https://example.com";
    req.bodyBytes = 50;
    sandbox.validateRequest(req);
    sandbox.requestCompleted();
    sandbox.validateResponse(req, 200, 200);

    auto stats = sandbox.getStats();
    assertEqual(stats.totalRequests, static_cast<uint64_t>(1));
    assertEqual(stats.totalBytesOut, static_cast<size_t>(50));
    assertEqual(stats.totalBytesIn, static_cast<size_t>(200));
  }});

  suite.cases.push_back({"getStats: blocked counted", []() {
    NetworkPolicy policy;
    policy.allowedDomains = {"*.example.com"};
    NetworkSandbox sandbox(policy);
    NetworkRequest req;
    req.url = "https://evil.com/steal";
    sandbox.validateRequest(req);

    assertEqual(sandbox.getStats().blockedRequests, static_cast<uint64_t>(1));
    assertEqual(sandbox.getStats().totalRequests, static_cast<uint64_t>(0));
  }});

  // --- Policy update ---

  suite.cases.push_back({"updatePolicy: changes take effect", []() {
    NetworkPolicy policy;
    policy.allowedDomains = {"*.example.com"};
    NetworkSandbox sandbox(policy);

    NetworkRequest req;
    req.url = "https://other.com/api";
    assertTrue(sandbox.validateRequest(req).has_value());

    NetworkPolicy newPolicy;
    sandbox.updatePolicy(newPolicy);
    assertFalse(sandbox.validateRequest(req).has_value());
  }});

  return suite;
}

} // anonymous namespace

void registerNetworkSandboxTests() {
  TestRunner::instance().addSuite(createNetworkSandboxTests());
}
