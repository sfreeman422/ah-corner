#!/usr/bin/env bash
# Run once per hour from the Docker host's crontab. The API controls concurrency.
set -euo pipefail

project_dir="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$project_dir"
if ! command -v docker >/dev/null 2>&1; then
  printf '%s AH Corner hourly collection failed: docker is not installed or not on PATH.\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" >&2
  exit 1
fi

# The internal endpoint only accepts an unproxied loopback request from inside
# the application container. It waits for the collection and returns a failure
# status if the refresh or database write fails.
if ! docker compose exec -T app node --input-type=module -e '
try {
  const response = await fetch("http://127.0.0.1:3000/internal/collect", {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: "{}",
    signal: AbortSignal.timeout(45 * 60 * 1000)
  });
  const result = await response.json();
  if (!response.ok) {
    console.error(new Date().toISOString(), "AH Corner hourly collection failed:", result.error?.message || `HTTP ${response.status}`);
    process.exitCode = 1;
  } else {
    console.log(new Date().toISOString(), "AH Corner hourly collection completed.");
  }
} catch (error) {
  console.error(new Date().toISOString(), "AH Corner hourly collection failed:", error instanceof Error ? error.message : "Unknown error");
  process.exitCode = 1;
}
'; then
  printf '%s AH Corner hourly collection command failed.\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" >&2
  exit 1
fi
