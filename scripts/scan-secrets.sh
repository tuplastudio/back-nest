#!/usr/bin/env bash
#
# Scan exactly the content that would be committed, not the working tree.
#
# Why not `gitleaks dir .`: that walks everything including gitignored files, so
# it reports the operator's local .env on every run — noise that trains you to
# ignore the scanner. Why not `gitleaks git --staged`: before the first commit
# there is no HEAD, so it reports "0 commits scanned" and silently passes.
#
# This materialises the committable set (staged + untracked-but-not-ignored,
# resolved through .gitignore) into a temporary tree and scans that.
#
# Usage: scripts/scan-secrets.sh [--staged]
#   default    scan the committable set, using index content for staged files
#   --staged   index-only content: what the next commit would record exactly
#
# Exits non-zero if a secret is found.

set -euo pipefail

RED=$'\033[31m'
GREEN=$'\033[32m'
DIM=$'\033[2m'
RESET=$'\033[0m'
command -v gitleaks >/dev/null 2>&1 || {
  printf '%sgitleaks not installed. Install with: brew install gitleaks%s\n' "$RED" "$RESET" >&2
  exit 127
}

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

MODE="${1:-}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT INT TERM

if [ "$MODE" = "--staged" ]; then
  # Index truth: only paths that differ from HEAD, at their staged content.
  PATHS="$(git diff --cached --name-only --diff-filter=ACMR 2>/dev/null || true)"
  [ -n "$PATHS" ] && printf '%s\n' "$PATHS" | git checkout-index --stdin --prefix="$WORK/" 2>/dev/null || true
  LABEL="staged content"
else
  # Committable set, honouring .gitignore.
  git ls-files --cached --others --exclude-standard -z \
    | tar -c --null -T - 2>/dev/null \
    | tar -x -C "$WORK" 2>/dev/null || true
  LABEL="committable files"
fi

printf '%s▸ gitleaks: scanning %s (%s file(s))%s\n' "$DIM" "$LABEL" "$(find "$WORK" -type f | wc -l | tr -d ' ')" "$RESET"

if gitleaks dir "$WORK" --redact --no-banner --verbose; then
  printf '%s✔ no secrets in %s%s\n' "$GREEN" "$LABEL" "$RESET"
  exit 0
else
  printf '\n%s✖ gitleaks found a secret in %s.%s\n' "$RED" "$LABEL" "$RESET" >&2
  printf '  Rotate the credential, purge it from history if it was ever committed,\n' >&2
  printf '  and re-stage. Do not commit with --no-verify.\n' >&2
  exit 1
fi