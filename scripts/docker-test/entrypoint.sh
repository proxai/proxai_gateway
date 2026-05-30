#!/usr/bin/env bash
# Entrypoint for the proxai_gateway local cross-platform test container.
# Installs Linux-native dependencies, runs the cross-platform test report,
# persists the rendered report to a gitignored per-arch artifact dir inside the
# bind-mounted repo, then STAYS RUNNING as a lightweight on-demand service.
#
# Lifecycle: this is PID 1. After the run it drops a `.done` sentinel (so the
# orchestrator knows the run finished — it lives on the bind mount, visible on
# the host) and then idles via `tail -f /dev/null`. The container keeps running
# until a developer stops it (`po stop gateway:<arch>`) or removes it
# (`po clean`). It deliberately does NOT exit on test failure — the failing
# report stays viewable via `po logs`, and the container stays up.
set -u
# Merge stderr into stdout so the whole run is captured on the container's
# stdout (what `docker logs` / `po logs` show).
exec 2>&1

# Piped output (docker logs) is not a TTY, so force chalk color on; the report's
# saved copy is de-ANSI'd below to stay grep-clean.
export FORCE_COLOR=1

ARCH="${GATEWAY_TEST_ARCH:-unknown}"
ARTIFACT_DIR="/app/.tmp/docker-test/${ARCH}"
mkdir -p "${ARTIFACT_DIR}"
# Clear any prior sentinel so the orchestrator waits for THIS run.
rm -f "${ARTIFACT_DIR}/.done"

echo "==> proxai_gateway test:report  (arch=${ARCH}, $(uname -m), bun $(bun --version))"

bun install --frozen-lockfile
bun run test:report | tee "${ARTIFACT_DIR}/report.txt"

# Terminal/logs already got the colored stream via tee; strip ANSI from the
# saved copy so the artifact is clean to read/grep.
sed -i -E 's/\x1b\[[0-9;]*m//g' "${ARTIFACT_DIR}/report.txt"

# Signal completion (host-visible via the bind mount), then idle.
touch "${ARTIFACT_DIR}/.done"
echo "==> run complete — container staying up (po stop gateway:${ARCH} to stop, po logs gateway ${ARCH} to view)"
exec tail -f /dev/null
