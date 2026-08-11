# Dyad Zenith — build/install/verify automation
# Usage: make doctor | deps | typecheck | test | build | install | verify | deploy | audit
# `make deploy` = the full pipeline (build → install → verify).

SHELL := /bin/bash
APP_NAME := Dyad-Zenith
APP_PATH := /Applications/$(APP_NAME).app
BUNDLE_APP := out/dyad-darwin-arm64/*.app
NODE24 := $(HOME)/.openclaw-autoclaw/workspace/dyad/userData/managed-tools/node/v24.18.0/bin
USERDATA := $(HOME)/Library/Application Support/dyad

.PHONY: help doctor deps typecheck test build install verify deploy audit guides clean

help: ## List targets
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

doctor: ## Environment self-check (node, disk, memory, app state)
	@echo "── Node:"; node -v 2>/dev/null || echo "  ⚠ no node in PATH — use managed: export PATH=$(NODE24):$$PATH"
	@echo "── Free memory:"; vm_stat | awk '/Pages free/ {printf "  %.0f MB free\n", $$3*16384/1048576}'
	@echo "── Disk:"; df -h / | tail -1 | awk '{print "  " $$4 " free"}'
	@echo "── App running:"; pgrep -f "$(APP_NAME).app/Contents/MacOS" >/dev/null && echo "  yes" || echo "  no"
	@echo "── Bundle installed:"; ls "$(APP_PATH)/Contents/Resources/app.asar" >/dev/null 2>&1 && echo "  yes" || echo "  no"

deps: ## Install dependencies
	export PATH="$(NODE24):$$PATH"; npm install

typecheck: ## TypeScript check
	export PATH="$(NODE24):$$PATH"; npx tsc --noEmit

test: ## Run the key unit suites (parser + handler history)
	export PATH="$(NODE24):$$PATH"; npx vitest run \
		src/lib/streamingMessageParser.test.ts \
		src/components/chat/DyadMarkdownParser.test.tsx

preflight: ## Kill running app + clean build state
	@echo "── Killing running app…"
	@pkill -f "$(APP_NAME).app/Contents/MacOS" 2>/dev/null || true
	@sleep 3
	@echo "── Cleaning build state…"
	@rm -rf out
	@rm -f userData/SingletonSocket userData/SingletonCookie userData/SingletonLock || true
	@rm -f "$(USERDATA)/SingletonLock" "$(USERDATA)/SingletonCookie" "$(USERDATA)/SingletonSocket" 2>/dev/null || true

build: preflight ## Package the app (main + renderer + packager)
	export PATH="$(NODE24):$$PATH"; E2E_TEST_BUILD=true npm run package
	@test -d out/dyad-darwin-arm64 || { echo "✗ BUILD SILENTLY FAILED: no out/dyad-darwin-arm64 produced (packager died mid-copy — usually memory pressure). Free ~3 GB and retry." >&2; exit 1; }
	@test -d "$(wildcard out/dyad-darwin-arm64/*.app)" || { echo "✗ BUILD SILENTLY FAILED: no .app in out/dyad-darwin-arm64/ — check ls out/dyad-darwin-arm64/ for the actual name." >&2; exit 1; }
	@echo "  ✔ Package produced: $(wildcard out/dyad-darwin-arm64/*.app)"

build-memory-safe: preflight ## Memory-safe package: clean stale packager temps + split phases + capped heap (research-backed best way for pressure-constrained hosts)
	@echo "── Cleaning stale electron-packager temp dirs (they can trigger packager's 'already exists' skip and waste disk)…"
	@rm -rf "$$TMPDIR"/electron-packager 2>/dev/null || rm -rf /var/folders/*/*/T/electron-packager 2>/dev/null || true
	@rm -rf out release
	@echo "── Phase 1/3: native rebuild (isolated so clang spikes never overlap packaging)…"
	export PATH="$(NODE24):$$PATH"; npm run rebuild:keychain-reader
	@echo "── Phase 2/3: forge package with capped Node heap + bounded rollup parallelism…"
	export PATH="$(NODE24):$$PATH"; NODE_OPTIONS="--max-old-space-size=2560" E2E_TEST_BUILD=true npx electron-forge package
	@test -d out/dyad-darwin-arm64 || { echo "✗ Phase 2/3 silently produced no out/ dir (packager died mid-copy). Free ~3 GB RAM and retry." >&2; exit 1; }
	@test -d "$(wildcard out/dyad-darwin-arm64/*.app)" || { echo "✗ Phase 2/3 silently produced no .app in out/dyad-darwin-arm64/. Free ~3 GB RAM and retry." >&2; exit 1; }
	@echo "  ✔ Package produced: $(wildcard out/dyad-darwin-arm64/*.app)"
	@echo "── Phase 3/3: install + relaunch…"
	@$(MAKE) install
	@$(MAKE) verify

install: ## Copy built app to /Applications and relaunch
	@echo "── Installing $(APP_NAME)…"
	@rm -rf "$(APP_PATH)"
	@cp -R $(BUNDLE_APP) "$(APP_PATH)"
	@rm -f "$(USERDATA)/SingletonLock" "$(USERDATA)/SingletonCookie" "$(USERDATA)/SingletonSocket" 2>/dev/null || true
	@open "$(APP_PATH)"
	@echo "  ✔ Installed & launched"

verify: ## Verify installed bundle contains today's fixes
	@cd /tmp && npx asar list "$(APP_PATH)/Contents/Resources/app.asar" | grep -m1 "\.vite/build/main-.*js" | sed 's|^/||' > /tmp/bundle_name.txt
	@echo "── Installed bundle: $$(cat /tmp/bundle_name.txt)"
	@cd /tmp && npx asar extract-file "$(APP_PATH)/Contents/Resources/app.asar" "$$(cat /tmp/bundle_name.txt)" && mv "$$(basename $$(cat /tmp/bundle_name.txt))" /tmp/dyad-bundle.js
	@echo "── Fix markers in bundle:"
	@grep -c "falling back to" /tmp/dyad-bundle.js | sed 's/^/   model fallback: /'
	@grep -c "truncated to fit the context window" /tmp/dyad-bundle.js | sed 's/^/   context budget: /'
	@grep -c "Legacy alias for" /tmp/dyad-bundle.js | sed 's/^/   tool aliases: /'
	@grep -c "meta-prompting" /tmp/dyad-bundle.js | sed 's/^/   guides: /'

deploy: build install verify ## Full pipeline: build → install → verify

audit: ## Tool-failure analytics from the chat DB
	python3 scripts/audit-tools.py "$(USERDATA)/sqlite.db"

guides: ## List registered agent guides
	@ls src/prompts/guides/*.md | sed 's|.*/||; s|\.md$$||'

clean: ## Remove build output only (keep node_modules)
	rm -rf out
