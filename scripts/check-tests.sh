#!/usr/bin/env bash
# Typechecks test files, which package builds deliberately exclude so that
# declaration output stays free of test types. That exclusion also meant tests
# were never typechecked at all: a test could `await` an Operation and assert
# against the generator object rather than its result.
set -uo pipefail

# Every package carrying tsconfig.test.json is mandatory. There are no stated
# exceptions; adding a package to the gate means keeping it strict and green.
status=0
checked=0
for config in packages/*/tsconfig.test.json; do
  package="$(dirname "$config")"
  checked=$((checked + 1))
  if ! ./node_modules/.bin/tsc -p "$config"; then
    echo "  ^ test typecheck failed: $package" >&2
    status=1
  fi
done
echo "Typechecked tests in ${checked} package(s)."
exit "$status"
