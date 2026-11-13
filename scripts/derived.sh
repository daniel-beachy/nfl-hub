#!/usr/bin/env bash
# The `derived` branch holds reproducible pipeline output (docs/PLAN.md 5.3): one orphan
# commit, force-pushed by every run. A job fetches it, rewrites only its own files, and
# pushes, so a stage that fails leaves its previous files in place.
#   scripts/derived.sh fetch <dir>    put the branch's files in <dir> (empty dir if no branch yet)
#   scripts/derived.sh push <dir>     replace the branch with <dir>'s contents
set -euo pipefail

cmd="${1:?fetch or push}"
dir="${2:?directory}"
: "${GITHUB_REPOSITORY:?}" "${GITHUB_TOKEN:?}"
remote="https://x-access-token:${GITHUB_TOKEN}@github.com/${GITHUB_REPOSITORY}.git"

case "$cmd" in
  fetch)
    rm -rf "$dir"
    if git ls-remote --exit-code --heads "$remote" derived >/dev/null 2>&1; then
      git clone --quiet --depth 1 --branch derived "$remote" "$dir"
      rm -rf "$dir/.git"
    else
      mkdir -p "$dir"
      echo "No derived branch yet; starting empty."
    fi
    ;;
  push)
    cd "$dir"
    rm -rf .git
    git init --quiet --initial-branch derived
    git config user.name "github-actions[bot]"
    git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
    git add --all
    git commit --quiet --allow-empty --message "Derived data $(date -u +%Y-%m-%dT%H:%MZ)"
    git push --quiet --force "$remote" derived
    rm -rf .git
    ;;
  *)
    echo "Unknown command: $cmd" >&2
    exit 2
    ;;
esac
