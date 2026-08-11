#!/bin/bash
# Deploy dyad to a Windmill instance
# Usage: bash deploy.sh [WINDMILL_URL] [WINDMILL_TOKEN] [WORKSPACE]

WINDMILL_URL="${1:-http://localhost:8001}"
WINDMILL_TOKEN="${2}"
WORKSPACE="${3:-dyad}"
FLOW_FILE="flow.json"

echo "🚀 Deploying dyad to Windmill..."

if [ -z "$WINDMILL_TOKEN" ]; then
  echo "❌ WINDMILL_TOKEN required. Get it from Windmill → Account → API Keys."
  exit 1
fi

# Create workspace
curl -s -X POST "$WINDMILL_URL/api/w/${WORKSPACE}/workspaces/create" \
  -H "Authorization: Bearer $WINDMILL_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"id\": \"$WORKSPACE\", \"name\": \"$WORKSPACE\", \"username\": \"admin\"}"

# Push flow
curl -s -X POST "$WINDMILL_URL/api/w/${WORKSPACE}/jobs/run/f/${WORKSPACE}" \
  -H "Authorization: Bearer $WINDMILL_TOKEN" \
  -H "Content-Type: application/json" \
  -d @flow.json

echo "✅ Deployed! Open $WINDMILL_URL/run/${WORKSPACE}"
