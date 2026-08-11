#!/bin/bash
# bun-ci-retry.sh
# Retry bun install up to 3 times to handle intermittent errors.
# Replaces the former npm-ci-retry.sh.

set -e

MAX_ATTEMPTS=3
RETRY_DELAY=10

for i in $(seq 1 $MAX_ATTEMPTS); do
  if bun install --frozen-lockfile; then
    exit 0
  fi
  echo "bun install attempt $i failed, retrying in ${RETRY_DELAY}s..."
  sleep $RETRY_DELAY
  rm -rf node_modules || true
done

echo "bun install failed after $MAX_ATTEMPTS attempts"
exit 1
