#!/usr/bin/env bash
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/zhonghai10777-crypto/agent.git}"
BRANCH="${BRANCH:-fix/plan-mode-transcript-baseline}"
BASE_BRANCH="${BASE_BRANCH:-main}"
WORKDIR="${WORKDIR:-$PWD/agent-review-fixes}"
PATCH_DIR="${PATCH_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"

PATCH_1="$PATCH_DIR/0001-block-cross-thread-messaging-in-plan-mode.patch"
PATCH_2="$PATCH_DIR/0002-advance-transcript-baseline-after-successful-read.patch"

for patch in "$PATCH_1" "$PATCH_2"; do
  [[ -f "$patch" ]] || { echo "Missing patch: $patch" >&2; exit 1; }
done

if [[ -e "$WORKDIR" ]]; then
  echo "Refusing to overwrite existing path: $WORKDIR" >&2
  exit 1
fi

git clone "$REPO_URL" "$WORKDIR"
cd "$WORKDIR"

git fetch origin "$BASE_BRANCH"
git switch "$BASE_BRANCH"
git pull --ff-only origin "$BASE_BRANCH"

if git show-ref --verify --quiet "refs/remotes/origin/$BRANCH"; then
  echo "Remote branch already exists: origin/$BRANCH" >&2
  exit 1
fi

git switch -c "$BRANCH"

git apply --check "$PATCH_1"
git apply --check "$PATCH_2"
git apply "$PATCH_1"
git apply "$PATCH_2"

git diff --check

echo "Changed files:"
git status --short

if [[ "${RUN_TESTS:-0}" == "1" ]]; then
  pnpm install --frozen-lockfile
  pnpm typecheck
  pnpm --filter @pi-gui/pi-sdk-driver test
  pnpm --filter @pi-gui/desktop run test:e2e:runner -- \
    apps/desktop/tests/unit/permission.spec.ts
fi

# Stage only the reviewed patch scope. Never stage unrelated work.
git add -- \
  apps/desktop/electron/permission-mode.ts \
  apps/desktop/tests/unit/permission.spec.ts \
  packages/pi-sdk-driver/src/session-supervisor.ts \
  packages/pi-sdk-driver/test/disk-tail.test.mts

git diff --cached --check
git diff --cached --stat

git commit -m "Fix plan-mode mutation bypass and transcript tailing"
git push -u origin "$BRANCH"

PR_BODY_FILE="$PATCH_DIR/agent-review-fixes-pr-body.md"
if command -v gh >/dev/null 2>&1; then
  gh pr create \
    --repo zhonghai10777-crypto/agent \
    --base "$BASE_BRANCH" \
    --head "$BRANCH" \
    --draft \
    --title "Fix plan-mode mutation bypass and transcript tailing" \
    --body-file "$PR_BODY_FILE"
else
  echo
  echo "Branch pushed. GitHub CLI is not installed, so create the draft PR with:"
  echo "  base: $BASE_BRANCH"
  echo "  head: $BRANCH"
  echo "  title: Fix plan-mode mutation bypass and transcript tailing"
  echo "  body: $PR_BODY_FILE"
fi
