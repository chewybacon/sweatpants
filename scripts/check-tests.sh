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
configs=(packages/*/tsconfig.test.json)
configs+=(acceptance/tsconfig.json)
if (( $# > 0 )); then
  configs=()
  for selection in "$@"; do
    selection="${selection%/}"
    if [[ "$selection" == "acceptance" ]]; then
      configs+=("acceptance/tsconfig.json")
      continue
    fi
    if [[ ! "$selection" =~ ^packages/[^/]+$ || ! -f "$selection/tsconfig.test.json" ]]; then
      echo "Unknown test typecheck package: $selection" >&2
      exit 2
    fi
    configs+=("$selection/tsconfig.test.json")
  done
fi
for config in "${configs[@]}"; do
  package="$(dirname "$config")"
  checked=$((checked + 1))
  if ! ./node_modules/.bin/tsc -p "$config"; then
    echo "  ^ test typecheck failed: $package" >&2
    status=1
  fi
done
echo "Typechecked tests in ${checked} package(s)."
exit "$status"
