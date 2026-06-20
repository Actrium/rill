#pragma once
#include <cmath>
#include <functional>
#include <iostream>
#include <sstream>
#include <string>
#include <vector>

namespace rill::test {

struct TestCase {
  std::string name;
  std::function<void()> fn;
};

struct TestSuite {
  std::string name;
  std::vector<TestCase> cases;
};

class TestRunner {
public:
  static TestRunner& instance() {
    static TestRunner runner;
    return runner;
  }

  void addSuite(TestSuite suite) {
    suites_.push_back(std::move(suite));
  }

  int run() {
    int totalPassed = 0;
    int totalFailed = 0;
    std::vector<std::string> failures;

    for (const auto& suite : suites_) {
      std::cout << "\n=== " << suite.name << " ===" << std::endl;
      int suitePassed = 0;
      int suiteFailed = 0;

      for (const auto& tc : suite.cases) {
        try {
          tc.fn();
          std::cout << "  PASS  " << tc.name << std::endl;
          suitePassed++;
        } catch (const std::exception& e) {
          std::cout << "  FAIL  " << tc.name << std::endl;
          std::cout << "        " << e.what() << std::endl;
          suiteFailed++;
          failures.push_back(suite.name + " > " + tc.name + ": " + e.what());
        }
      }

      std::cout << "  " << suitePassed << " passed, "
                << suiteFailed << " failed" << std::endl;
      totalPassed += suitePassed;
      totalFailed += suiteFailed;
    }

    std::cout << "\n===========================================" << std::endl;
    std::cout << "Total: " << totalPassed << " passed, "
              << totalFailed << " failed, "
              << (totalPassed + totalFailed) << " total" << std::endl;

    if (!failures.empty()) {
      std::cout << "\nFailures:" << std::endl;
      for (const auto& f : failures) {
        std::cout << "  - " << f << std::endl;
      }
    }

    std::cout << "===========================================" << std::endl;
    return totalFailed > 0 ? 1 : 0;
  }

private:
  std::vector<TestSuite> suites_;
};

// Assertion helpers
class AssertionError : public std::runtime_error {
public:
  using std::runtime_error::runtime_error;
};

inline void assertTrue(bool condition, const std::string& msg = "expected true") {
  if (!condition) throw AssertionError(msg);
}

inline void assertFalse(bool condition, const std::string& msg = "expected false") {
  if (condition) throw AssertionError(msg);
}

template <typename T>
void assertEqual(const T& actual, const T& expected, const std::string& ctx = "") {
  if (actual != expected) {
    std::ostringstream ss;
    ss << "expected " << expected << " but got " << actual;
    if (!ctx.empty()) ss << " (" << ctx << ")";
    throw AssertionError(ss.str());
  }
}

inline void assertApprox(double actual, double expected, double tolerance,
                         const std::string& ctx = "") {
  if (std::abs(actual - expected) > tolerance) {
    std::ostringstream ss;
    ss << "expected ~" << expected << " (±" << tolerance
       << ") but got " << actual;
    if (!ctx.empty()) ss << " (" << ctx << ")";
    throw AssertionError(ss.str());
  }
}

template <typename ExceptionT = std::exception, typename Fn>
void assertThrows(Fn&& fn, const std::string& msg = "expected exception") {
  try {
    fn();
    throw AssertionError(msg);
  } catch (const ExceptionT&) {
    // expected
  }
}

inline void assertGreater(double actual, double threshold,
                          const std::string& ctx = "") {
  if (actual <= threshold) {
    std::ostringstream ss;
    ss << "expected > " << threshold << " but got " << actual;
    if (!ctx.empty()) ss << " (" << ctx << ")";
    throw AssertionError(ss.str());
  }
}

inline void assertLessOrEqual(double actual, double threshold,
                              const std::string& ctx = "") {
  if (actual > threshold) {
    std::ostringstream ss;
    ss << "expected <= " << threshold << " but got " << actual;
    if (!ctx.empty()) ss << " (" << ctx << ")";
    throw AssertionError(ss.str());
  }
}

} // namespace rill::test
