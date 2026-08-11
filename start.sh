#!/bin/bash
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

echo "== Dyad-Zenith Omni-Fixed =="
echo ""

# Clean stale locks from previous runs
rm -f ~/Library/Application\ Support/dyad/SingletonLock 2>/dev/null

# Kill any orphaned vite from a previous run (but NOT a healthy one we can reuse)
if ! curl -s -o /dev/null http://localhost:5173/ --max-time 2 2>/dev/null; then
  pkill -f "vite.*5173" 2>/dev/null || true
  sleep 1
fi

# Build main process (correct forge-style lib build — see vite.main.rebuild.mts)
echo "-> Building main bundle..."
if [ ! -f .vite/build/main.js ] || [ "$1" = "--rebuild" ]; then
  rm -rf .vite/build/main*.js
  npx vite build --config vite.main.rebuild.mts 2>&1 | tail -1
  npx vite build --config vite.preload.config.mts --outDir .vite/build --emptyOutDir false 2>&1 | tail -1
fi
if [ ! -f .vite/build/main.js ]; then
  echo "ERROR: Build failed. Run: bash start.sh --rebuild"
  exit 1
fi
echo "   Bundle OK: $(grep -o 'main-[A-Za-z0-9_]*\.js' .vite/build/main.js | head -1)"

# Start Vite with a supervisor so it auto-restarts if it dies
# (Electron's renderer retry logic then recovers automatically — never blank)
echo "-> Starting Vite (supervised)..."
if curl -s -o /dev/null http://localhost:5173/ --max-time 2 2>/dev/null; then
  echo "   Vite already running on :5173 — reusing"
else
  npx vite --port 5173 --config vite.renderer.config.mts --strictPort > /tmp/vite-dyad.log 2>&1 &
  VITE_PID=$!
fi

for i in $(seq 1 30); do
  HTTP=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:5173/ --max-time 2 2>/dev/null)
  if [ "$HTTP" = "200" ]; then
    echo "   Vite ready on :5173 (verified)"
    break
  fi
  sleep 1
done

HTTP=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:5173/ --max-time 2 2>/dev/null)
if [ "$HTTP" != "200" ]; then
  echo "ERROR: Vite failed to start"
  exit 1
fi

# Supervisor: keep Vite alive no matter what
(
  while true; do
    if ! curl -s -o /dev/null http://localhost:5173/ --max-time 2 2>/dev/null; then
      echo "[supervisor] Vite died — restarting..." >> /tmp/vite-dyad.log
      npx vite --port 5173 --config vite.renderer.config.mts --strictPort >> /tmp/vite-dyad.log 2>&1 &
    fi
    sleep 5
  done
) &
SUPERVISOR_PID=$!
trap 'kill $SUPERVISOR_PID 2>/dev/null' EXIT

# Launch Electron (direct binary — bypasses Gatekeeper spawn restrictions)
echo "-> Launching Electron..."
DYAD_NO_KEYCHAIN=1 DYAD_SKIP_MOVE_PROMPT=1 node_modules/electron/dist/Electron.app/Contents/MacOS/Electron . > /tmp/dyad-run.log 2>&1 &
ELECTRON_PID=$!

echo ""
echo "   Electron PID: $ELECTRON_PID   Vite: supervised :5173"
echo "   Close the app window to stop. Vite restarts automatically if it dies."
echo ""

wait $ELECTRON_PID 2>/dev/null
echo "-> Stopped."
