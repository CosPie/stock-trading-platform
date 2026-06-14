#!/usr/bin/env bash
# Manage local TradingAgents submodule changes via patches/tradingagents-local.patch.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SUBMODULE="${REPO_ROOT}/third_party/tradingagents"
PATCH="${REPO_ROOT}/patches/tradingagents-local.patch"

usage() {
  cat <<'EOF'
Usage: scripts/tradingagents-vendor.sh <command>

Commands:
  apply     Apply patches/tradingagents-local.patch to the submodule
  export    Save submodule changes into the patch file, then clean submodule
  clean     Discard all local changes in the submodule
  status    Show whether the submodule is clean or dirty
  sync      Update submodule from upstream, then re-apply the local patch

Typical workflow:
  1. ./scripts/tradingagents-vendor.sh apply
  2. edit files under third_party/tradingagents/
  3. ./scripts/tradingagents-vendor.sh export
  4. git add patches/tradingagents-local.patch && git commit
EOF
}

require_submodule() {
  if [[ ! -e "${SUBMODULE}/.git" ]]; then
    echo "error: submodule not initialized. Run: git submodule update --init" >&2
    exit 1
  fi
}

cmd_apply() {
  require_submodule
  if [[ ! -f "${PATCH}" ]]; then
    echo "No patch file found at patches/tradingagents-local.patch"
    exit 1
  fi
  (
    cd "${SUBMODULE}"
    if [[ -n "$(git status --porcelain)" ]]; then
      echo "error: submodule is dirty. Run 'export' or 'clean' first." >&2
      exit 1
    fi
    git apply "${PATCH}"
  )
  echo "Applied ${PATCH#${REPO_ROOT}/}"
}

cmd_export() {
  require_submodule
  (
    cd "${SUBMODULE}"
    if [[ -z "$(git status --porcelain)" ]]; then
      echo "Nothing to export; submodule is already clean."
      exit 0
    fi
    git add -A
    git diff --cached > "${PATCH}"
    git reset HEAD >/dev/null
    git restore .
    git clean -fd >/dev/null
  )
  echo "Exported to patches/tradingagents-local.patch"
  echo "Submodule is clean. Commit the patch in the parent repo."
}

cmd_clean() {
  require_submodule
  (
    cd "${SUBMODULE}"
    git restore . 2>/dev/null || true
    git clean -fd
  )
  echo "Submodule is clean."
}

cmd_status() {
  require_submodule
  (
    cd "${SUBMODULE}"
    if [[ -z "$(git status --porcelain)" ]]; then
      echo "Submodule: clean"
    else
      echo "Submodule: dirty"
      git status --short
    fi
  )
  if [[ -f "${PATCH}" ]]; then
    echo "Patch file: patches/tradingagents-local.patch"
  else
    echo "Patch file: missing"
  fi
}

cmd_sync() {
  require_submodule
  (
    cd "${REPO_ROOT}"
    git submodule update --remote third_party/tradingagents
  )
  if [[ -f "${PATCH}" ]]; then
    cmd_apply
    echo "Upstream updated and local patch re-applied."
  else
    echo "Upstream updated. No local patch to apply."
  fi
}

main() {
  local command="${1:-}"
  case "${command}" in
    apply) cmd_apply ;;
    export) cmd_export ;;
    clean) cmd_clean ;;
    status) cmd_status ;;
    sync) cmd_sync ;;
    -h|--help|help|"") usage ;;
    *)
      echo "error: unknown command '${command}'" >&2
      usage
      exit 1
      ;;
  esac
}

main "$@"
