#!/bin/bash
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

echo "== Dyad-Zenith Omni-Fixed =="
echo ""

# Clean
rm -f ~/Library/Application\ Support/dyad/SingletonLock 2>/dev/null
pkill -f "vite.*5173" 2>/dev/null || true
sleep 1

# Build main process
echo "-> Building..."
rm -rf .vite/build .vite/deps
# Build main targets using forge-style vite commands
npx vite build --config vite.main.config.mts --outDir .vite/build --emptyOutDir 2>&1 | grep "built" && \
npx vite build --config vite.preload.config.mts --outDir .vite/build --emptyOutDir false 2>&1 | grep "built" && \
npx vite build --config vite.sandbox-worker.config.mts --outDir .vite/build --emptyOutDir false 2>&1 | grep "built" && \
npx vite build --config vite.code-explorer-worker.config.mts --outDir .vite/build --emptyOutDir false 2>&1 | grep "built" && \
npx vite build --config vite.supabase-dependency-analysis-worker.config.mts --outDir .vite/build --emptyOutDir false 2>&1 | grep "built"

# Check main.js exists
if [ ! -f .vite/build/main.js ]; then
  echo "ERROR: Build failed. Run: npx electron-forge start"
  exit 1
fi
echo "   Build OK"

# Start Vite and VERIFY before continuing
echo "-> Starting Vite..."
npx vite --port 5173 --config vite.renderer.config.mts --strictPort &
VITE_PID=$!

for i in $(seq 1 30); do
  HTTP=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:5173/ --max-time 2 2>/dev/null)
  if [ "$HTTP" = "200" ]; then
    echo "   Vite ready on :5173 (verified)"
    break
  fi
  sleep 1
done

# CRITICAL: double-check Vite is actually serving
HTTP=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:5173/ --max-time 2 2>/dev/null)
if [ "$HTTP" != "200" ]; then
  echo "ERROR: Vite failed to start"
  kill $VITE_PID 2>/dev/null
  exit 1
fi

# Launch Electron
echo "-> Launching Electron..."
DYAD_NO_KEYCHAIN=1 node_modules/electron/dist/Electron.app/Contents/MacOS/Electron . &
ELECTRON_PID=$!

echo ""
echo "   Electron PID: $ELECTRON_PID   Vite PID: $VITE_PID"
echo "   Close the app window to stop."
echo ""

wait $ELECTRON_PID 2>/dev/null
kill $VITE_PID 2>/dev/null
echo "-> Stopped."
