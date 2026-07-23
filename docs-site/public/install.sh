#!/usr/bin/env bash
set -euo pipefail

# glrs bootstrap — installs bun, gh, and @glrs-dev/cli
# usage: curl -fsSL https://glrs.dev/install.sh | bash

RED='\033[0;31m'
BOLD='\033[1m'
DIM='\033[2m'
RESET='\033[0m'

log()   { printf "${BOLD}glrs${RESET} %s\n" "$*"; }
ok()    { printf "${BOLD}glrs${RESET} ✓ %s\n" "$*"; }
warn()  { printf "${BOLD}glrs${RESET} ${RED}!${RESET} %s\n" "$*"; }
dim()   { printf "${DIM}     %s${RESET}\n" "$*"; }

confirm() {
  printf "${BOLD}glrs${RESET} %s [y/N] " "$1"
  read -r ans
  case "$ans" in
    [yY]|[yY][eE][sS]) return 0 ;;
    *) return 1 ;;
  esac
}

# ── bun ────────────────────────────────────────────────────────────

if command -v bun &>/dev/null; then
  ok "bun $(bun --version)"
else
  warn "bun not found"
  if confirm "Install bun?"; then
    curl -fsSL https://bun.sh/install | bash
    # source the shell config to get bun on PATH
    export BUN_INSTALL="$HOME/.bun"
    export PATH="$BUN_INSTALL/bin:$PATH"
    if command -v bun &>/dev/null; then
      ok "bun $(bun --version) installed"
    else
      warn "bun installed but not on PATH — restart your shell and re-run this script"
      exit 1
    fi
  else
    warn "bun is required — install from https://bun.sh"
    exit 1
  fi
fi

# ── git ────────────────────────────────────────────────────────────

if command -v git &>/dev/null; then
  ok "git $(git --version | awk '{print $3}')"
else
  warn "git not found — install git and re-run this script"
  exit 1
fi

# ── gh (github cli) ───────────────────────────────────────────────

if command -v gh &>/dev/null; then
  ok "gh $(gh --version | head -1 | awk '{print $3}')"
else
  warn "gh (GitHub CLI) not found"
  if confirm "Install gh?"; then
    OS="$(uname -s)"
    case "$OS" in
      Darwin)
        if command -v brew &>/dev/null; then
          brew install gh
        else
          warn "homebrew not found — install gh manually: https://cli.github.com"
          dim "skipping gh install (glrs works without it, but GitHub commands won't)"
        fi
        ;;
      Linux)
        if command -v apt-get &>/dev/null; then
          (type -p wget >/dev/null || sudo apt-get install wget -y) \
            && sudo mkdir -p -m 755 /etc/apt/keyrings \
            && out=$(mktemp) && wget -nv -O"$out" https://cli.github.com/packages/githubcli-archive-keyring.gpg \
            && cat "$out" | sudo tee /etc/apt/keyrings/githubcli-archive-keyring.gpg > /dev/null \
            && sudo chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
            && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | sudo tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
            && sudo apt-get update \
            && sudo apt-get install gh -y
        elif command -v dnf &>/dev/null; then
          sudo dnf install -y gh
        else
          warn "unsupported linux package manager — install gh manually: https://cli.github.com"
          dim "skipping gh install"
        fi
        ;;
      *)
        warn "unsupported OS for auto-install — install gh manually: https://cli.github.com"
        dim "skipping gh install"
        ;;
    esac
    if command -v gh &>/dev/null; then
      ok "gh $(gh --version | head -1 | awk '{print $3}') installed"
    fi
  else
    dim "skipping gh — glrs works without it, but GitHub commands won't"
  fi
fi

# ── @glrs-dev/cli ─────────────────────────────────────────────────

log "installing @glrs-dev/cli..."
npm i -g @glrs-dev/cli

if command -v glrs &>/dev/null; then
  ok "glrs $(glrs --version 2>/dev/null || echo 'installed')"
else
  warn "glrs installed but not on PATH — check your npm global bin directory"
  dim "try: npm bin -g"
  exit 1
fi

# ── harness ────────────────────────────────────────────────────────

log ""
log "installing harness plugin..."
glrs harness install

log ""
ok "done. run 'opencode' to start."
