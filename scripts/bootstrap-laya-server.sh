#!/usr/bin/env bash
set -euo pipefail

REPO_URL="https://github.com/nvkudva/laya-server.git"
COMMIT="0a2928f7ab415e8dd14bde483dc793e566c9f8fb"
MODEL="${1:-laya}"
INSTALL_DIR="${DRAGON_LAYA_HOME:-$HOME/.dragon/laya-server}"

if ! command -v git >/dev/null 2>&1; then
  echo "git is required" >&2
  exit 1
fi
if ! command -v uv >/dev/null 2>&1; then
  echo "==> Installing uv"
  curl -LsSf https://astral.sh/uv/install.sh | sh
  export PATH="$HOME/.local/bin:$PATH"
fi
command -v uv >/dev/null 2>&1 || { echo "uv installation failed" >&2; exit 1; }

if [ ! -d "$INSTALL_DIR/.git" ]; then
  echo "==> Cloning laya-server into $INSTALL_DIR"
  git clone "$REPO_URL" "$INSTALL_DIR"
fi

echo "==> Selecting pinned laya-server commit $COMMIT"
git -C "$INSTALL_DIR" fetch --depth 1 origin "$COMMIT"
git -C "$INSTALL_DIR" checkout --detach "$COMMIT"

echo "==> Installing laya-server command"
uv tool install --editable "$INSTALL_DIR" --quiet
export PATH="$HOME/.local/bin:$PATH"

echo "==> Downloading Laya model: $MODEL"
laya-server pull "$MODEL"

echo
echo "Laya is installed. Dragon can now start it with the default command: laya-server"
echo "Model cache: ${HF_HOME:-$HOME/.cache/huggingface}"
