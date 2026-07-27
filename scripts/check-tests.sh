#!/usr/bin/env bash
# Typechecks test files, which package builds deliberately exclude so that
# declaration output stays free of test types. That exclusion also meant tests
# were never typechecked at all: a test could `await` an Operation and assert
# against the generator object rather than its result.
set -uo pipefail

# packages/framework carries a legacy tsconfig.test.json that nothing ever ran
# and that disables strict, exactOptionalPropertyTypes, and
# noUncheckedIndexedAccess. It reports 87 errors under its own weakened settings.
# It is excluded here rather than silently skipped, and is scheduled with the
# framework decomposition. packages/core is likewise deferred (20 errors).
excluded=("packages/framework")

status=0
checked=0
for config in packages/*/tsconfig.test.json; do
  package="$(dirname "$config")"
  skip=""
  for entry in "${excluded[@]}"; do
    [ "$package" = "$entry" ] && skip=1
  done
  [ -n "$skip" ] && continue
  checked=$((checked + 1))
  if ! ./node_modules/.bin/tsc -p "$config"; then
    echo "  ^ test typecheck failed: $package" >&2
    status=1
  fi
done
echo "Typechecked tests in ${checked} package(s)."
exit "$status"
