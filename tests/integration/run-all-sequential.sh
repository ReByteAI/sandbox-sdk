#!/bin/bash
# Run all integration tests sequentially (one by one)
# Usage: ./run-all-sequential.sh [dev|prod]

# Note: Don't use set -e here - we handle errors via if/else and want to continue on failures

ENV="${1:-prod}"
LOG_FILE="/tmp/sdk-test.log"
cd "$(dirname "$0")/../.."

# Redirect all output to log file and console
exec > >(tee -a "$LOG_FILE") 2>&1

echo ""
echo "=== Running integration tests sequentially against $ENV ==="
echo "Log file: $LOG_FILE"
echo "Started at: $(date)"
echo ""

TESTS=(
  "sandbox.test.ts"
  "commands.test.ts"
  "filesystem.test.ts"
  "network.test.ts"
  "pause-resume.test.ts"
  "pty.test.ts"
  "randomness.test.ts"
  "streaming-pause.test.ts"
  "advanced.test.ts"
  "template-v2.test.ts"
  "traffic-simulation.test.ts"
  "stress.test.ts"
  "vm-stress.test.ts"
)

PASSED=0
FAILED=0
FAILED_TESTS=""

for test in "${TESTS[@]}"; do
  echo "=========================================="
  echo "Running: $test"
  echo "=========================================="

  if TEST_ENV="$ENV" npx vitest run "tests/integration/$test" --reporter=basic 2>&1; then
    echo "✓ PASSED: $test"
    ((PASSED++))
  else
    echo "✗ FAILED: $test"
    ((FAILED++))
    FAILED_TESTS="$FAILED_TESTS $test"
  fi
  echo ""
done

echo "=========================================="
echo "SUMMARY"
echo "=========================================="
echo "Passed: $PASSED"
echo "Failed: $FAILED"
if [ -n "$FAILED_TESTS" ]; then
  echo "Failed tests:$FAILED_TESTS"
fi
echo ""
echo "Finished at: $(date)"
echo "Log file: $LOG_FILE"
echo ""

exit $FAILED
