#!/usr/bin/env sh
set -eu

ROOT_DIR=${ROOT_DIR:-$(cd "$(dirname "$0")/.." && pwd)}
cd "$ROOT_DIR"

fatal() {
  printf 'predeploy verification failed: %s\n' "$1" >&2
  exit 1
}

step() {
  printf '\n=== %s ===\n' "$1"
}

step 'frontend: vite build'
[ -d node_modules ] || npm install >/dev/null
npm run build || fatal 'vite build failed'

step 'server: install dependencies if missing'
cd "$ROOT_DIR/server"
[ -d node_modules ] || npm install >/dev/null

step 'server: node --check on every source file'
for f in src/*.js; do
  node --check "$f" || fatal "$f failed syntax check"
done
printf 'node --check OK\n'

step 'server: scripts sh -n'
for f in "$ROOT_DIR/scripts"/*.sh; do
  sh -n "$f" || fatal "$f failed shellcheck syntax check"
done
printf 'shell sh -n OK\n'

step 'server: node --test'
npm test --silent || fatal 'unit tests failed'

step 'frontend: confirm no localStorage business writes are unconditional'
for guarded in STUDENTS_STORAGE_KEY CONTENT_STORAGE_KEY APPLICATIONS_STORAGE_KEY REVIEW_PLANS_STORAGE_KEY ENTRANCE_PAPERS_STORAGE_KEY REGISTRATION_APPLICATIONS_STORAGE_KEY KNOWLEDGE_BASE_STORAGE_KEY ACCOUNTS_STORAGE_KEY SESSION_STORAGE_KEY AI_SETTINGS_STORAGE_KEY; do
  if grep -n "localStorage.setItem($guarded" "$ROOT_DIR/src/App.jsx" | grep -v 'isApiConfigured'; then
    fatal "$guarded write is not gated by isApiConfigured"
  fi
done
printf 'localStorage business writes are gated\n'

step 'frontend: confirm loadXxx returns empty under API mode'
for loader in loadContentData loadReviewPlans loadApplicationData loadEntrancePapers loadKnowledgeBase loadAccounts loadSession; do
  if ! grep -n "^const $loader = (" "$ROOT_DIR/src/App.jsx" >/dev/null; then
    continue
  fi
  if ! grep -A2 "^const $loader = (" "$ROOT_DIR/src/App.jsx" | grep -q 'isApiConfigured'; then
    fatal "$loader does not short-circuit on isApiConfigured"
  fi
done
printf 'localStorage loaders short-circuit on isApiConfigured\n'

printf '\npredeploy checks passed.\n'
