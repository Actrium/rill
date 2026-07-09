# Rill Core C++ Test Makefile

CXX = clang++

SRC_DIR = src
TEST_DIR = test
BUILD_DIR = build

# Source files under test (flat)
SRC_FLAT = \
	$(SRC_DIR)/TimerWheel.cpp \
	$(SRC_DIR)/TenantThread.cpp \
	$(SRC_DIR)/ThreadPool.cpp \
	$(SRC_DIR)/TenantContext.cpp \
	$(SRC_DIR)/TenantRegistry.cpp \
	$(SRC_DIR)/EventBus.cpp

# Source files under test (security subdirectory)
SRC_SECURITY = \
	$(SRC_DIR)/security/NetworkSandbox.cpp \
	$(SRC_DIR)/security/FileSandbox.cpp \
	$(SRC_DIR)/security/SecurityManager.cpp

# Source files under test (devtools subdirectory)
SRC_DEVTOOLS = \
	$(SRC_DIR)/devtools/CDPServer.cpp \
	$(SRC_DIR)/devtools/ConsoleAdapter.cpp \
	$(SRC_DIR)/devtools/RuntimeAdapter.cpp \
	$(SRC_DIR)/devtools/DOMAdapter.cpp \
	$(SRC_DIR)/devtools/DebuggerAdapter.cpp \
	$(SRC_DIR)/devtools/NetworkAdapter.cpp \
	$(SRC_DIR)/devtools/AdapterDebugTarget.cpp \
	$(SRC_DIR)/devtools/DevToolsService.cpp

# Source files under test (protocol subdirectory).
# WIP — bodies gated behind RILL_WIP_BINARY_PROTOCOL (see WIP_DEFS below);
# compiles to an empty translation unit unless that flag is defined.
SRC_PROTOCOL = \
	$(SRC_DIR)/protocol/WireDecoder.cpp

# Test files
TEST_SOURCES = \
	$(TEST_DIR)/main.cpp \
	$(TEST_DIR)/test_timer_wheel.cpp \
	$(TEST_DIR)/test_tenant_context.cpp \
	$(TEST_DIR)/test_tenant_registry.cpp \
	$(TEST_DIR)/test_tenant_thread.cpp \
	$(TEST_DIR)/test_thread_pool.cpp \
	$(TEST_DIR)/test_tenant_manager_integration.cpp \
	$(TEST_DIR)/test_network_sandbox.cpp \
	$(TEST_DIR)/test_file_sandbox.cpp \
	$(TEST_DIR)/test_event_bus.cpp \
	$(TEST_DIR)/test_cdp_server.cpp \
	$(TEST_DIR)/test_cdp_adapters.cpp \
	$(TEST_DIR)/test_engine_debug_target.cpp \
	$(TEST_DIR)/test_adapter_debug_target.cpp \
	$(TEST_DIR)/test_devtools_service.cpp \
	$(TEST_DIR)/test_wire_decoder.cpp

# Object files
SRC_FLAT_OBJECTS = $(patsubst $(SRC_DIR)/%.cpp,$(BUILD_DIR)/src_%.o,$(SRC_FLAT))
SRC_SECURITY_OBJECTS = $(patsubst $(SRC_DIR)/security/%.cpp,$(BUILD_DIR)/src_security_%.o,$(SRC_SECURITY))
SRC_DEVTOOLS_OBJECTS = $(patsubst $(SRC_DIR)/devtools/%.cpp,$(BUILD_DIR)/src_devtools_%.o,$(SRC_DEVTOOLS))
SRC_PROTOCOL_OBJECTS = $(patsubst $(SRC_DIR)/protocol/%.cpp,$(BUILD_DIR)/src_protocol_%.o,$(SRC_PROTOCOL))
TEST_OBJECTS = $(patsubst $(TEST_DIR)/%.cpp,$(BUILD_DIR)/test_%.o,$(TEST_SOURCES))
ALL_OBJECTS = $(SRC_FLAT_OBJECTS) $(SRC_SECURITY_OBJECTS) $(SRC_DEVTOOLS_OBJECTS) $(SRC_PROTOCOL_OBJECTS) $(TEST_OBJECTS)

# Output
TEST_BINARY = $(BUILD_DIR)/core_test

# Extra flags (can be overridden for ASan, etc.)
EXTRA_CXXFLAGS ?=
EXTRA_LDFLAGS ?=

# WIP subsystems are gated out of production builds (see RillSandboxNative.podspec).
# The test build always enables them so the CDP and native-security code keeps
# compiling and running — tests are what stop "WIP" from rotting into "broken".
WIP_DEFS = -DRILL_WIP_CDP_DEVTOOLS=1 -DRILL_WIP_NATIVE_SECURITY=1 -DRILL_WIP_BINARY_PROTOCOL=1

# C++ compiler flags
CXXFLAGS = -std=c++17 -O2 -Wall -Wextra -Wpedantic
CXXFLAGS += -I. $(WIP_DEFS)
CXXFLAGS += $(EXTRA_CXXFLAGS)

# Linker flags
LDFLAGS = -lpthread $(EXTRA_LDFLAGS)

# Default target
all: $(TEST_BINARY)

# Create build directory
$(BUILD_DIR):
	mkdir -p $(BUILD_DIR)

# Compile flat source files
$(BUILD_DIR)/src_%.o: $(SRC_DIR)/%.cpp | $(BUILD_DIR)
	$(CXX) $(CXXFLAGS) -c $< -o $@

# Compile security subdirectory source files
$(BUILD_DIR)/src_security_%.o: $(SRC_DIR)/security/%.cpp | $(BUILD_DIR)
	$(CXX) $(CXXFLAGS) -c $< -o $@

# Compile devtools subdirectory source files
$(BUILD_DIR)/src_devtools_%.o: $(SRC_DIR)/devtools/%.cpp | $(BUILD_DIR)
	$(CXX) $(CXXFLAGS) -c $< -o $@

# Compile protocol subdirectory source files
$(BUILD_DIR)/src_protocol_%.o: $(SRC_DIR)/protocol/%.cpp | $(BUILD_DIR)
	$(CXX) $(CXXFLAGS) -c $< -o $@

# Compile test files
$(BUILD_DIR)/test_%.o: $(TEST_DIR)/%.cpp | $(BUILD_DIR)
	$(CXX) $(CXXFLAGS) -c $< -o $@

# Link test binary
$(TEST_BINARY): $(ALL_OBJECTS)
	$(CXX) $(ALL_OBJECTS) $(LDFLAGS) -o $@

# Run tests
test: $(TEST_BINARY)
	@echo ""
	@./$(TEST_BINARY)

# Clean build artifacts
clean:
	rm -rf $(BUILD_DIR)

# Debug build
debug: CXXFLAGS = -std=c++17 -g -O0 -Wall -Wextra -Wpedantic -DDEBUG -I. $(WIP_DEFS) $(EXTRA_CXXFLAGS)
debug: clean all

# Address sanitizer build
asan: EXTRA_CXXFLAGS = -fsanitize=address -fno-omit-frame-pointer -g -O1
asan: EXTRA_LDFLAGS = -fsanitize=address
asan: clean all test

# Thread sanitizer build
tsan: EXTRA_CXXFLAGS = -fsanitize=thread -g -O1
tsan: EXTRA_LDFLAGS = -fsanitize=thread
tsan: clean all test

.PHONY: all test clean debug asan tsan
