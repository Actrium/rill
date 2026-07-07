# Standalone build for the WireDecoder differential-fuzz driver (NEW; opt-in).
#
# Not referenced by the normal Makefile / test suite. Compiles the fuzz driver
# together with the WIP WireDecoder under AddressSanitizer + UndefinedBehavior
# Sanitizer so any OOB / use-after-free / UB in the decoder aborts the run.
#
# Usage (from native/core/test/):
#   make -f fuzz.mk                       # build ./build_fuzz/fuzz_wire_decoder
#   make -f fuzz.mk run ITER=100000 SEED=1
#
# Or just run scripts/fuzz-wire-differential.sh from the repo root, which builds
# this, runs it, then runs the TS side + differential comparison.

CXX ?= clang++
BUILD_DIR = build_fuzz
BIN = $(BUILD_DIR)/fuzz_wire_decoder

SRC = fuzz_wire_decoder.cpp ../src/protocol/WireDecoder.cpp

# RILL_WIP_BINARY_PROTOCOL=1 un-gates the WIP decoder. -fno-sanitize-recover so
# a UBSan finding aborts (nonzero exit) instead of merely logging.
CXXFLAGS = -std=c++17 -g -O1 -Wall -Wextra \
	-DRILL_WIP_BINARY_PROTOCOL=1 \
	-fsanitize=address,undefined -fno-sanitize-recover=all -fno-omit-frame-pointer
LDFLAGS = -fsanitize=address,undefined

ITER ?= 100000
SEED ?= 0
CORPUS ?= $(BUILD_DIR)/fuzz_corpus.bin
RESULTS ?= $(BUILD_DIR)/fuzz_cpp.results

all: $(BIN)

$(BUILD_DIR):
	mkdir -p $(BUILD_DIR)

$(BIN): $(SRC) ../src/protocol/WireDecoder.h | $(BUILD_DIR)
	$(CXX) $(CXXFLAGS) $(SRC) $(LDFLAGS) -o $(BIN)

run: $(BIN)
	ASAN_OPTIONS=abort_on_error=1:detect_leaks=0 UBSAN_OPTIONS=print_stacktrace=1:halt_on_error=1 \
		$(BIN) $(ITER) $(SEED) $(CORPUS) $(RESULTS)

clean:
	rm -rf $(BUILD_DIR)

.PHONY: all run clean
