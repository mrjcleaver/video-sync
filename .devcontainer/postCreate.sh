#!/usr/bin/env bash
set -euo pipefail

echo "[postCreate] starting"

# Ensure ~/.local/bin is usable in this script run
export PATH="$HOME/.local/bin:$PATH"

# 1) Node global: Claude Code
if ! command -v claude >/dev/null 2>&1; then
  echo "[postCreate] installing @anthropic-ai/claude-code"
  npm install -g @anthropic-ai/claude-code
else
  echo "[postCreate] claude already present"
fi

# 2) Rust: wasm-pack
if ! command -v wasm-pack >/dev/null 2>&1; then
  echo "[postCreate] installing wasm-pack"
  cargo install wasm-pack
else
  echo "[postCreate] wasm-pack already present"
fi

# 3) Web deps
if [ -d "web" ]; then
  echo "[postCreate] npm install in ./web"
  (cd web && npm install)
else
  echo "[postCreate] ./web not found, skipping web npm install"
fi

# 4) uv
if ! command -v uv >/dev/null 2>&1; then
  echo "[postCreate] installing uv"
  curl -LsSf https://astral.sh/uv/install.sh | sh
else
  echo "[postCreate] uv already present"
fi

# ensure PATH after uv install
export PATH="$HOME/.local/bin:$PATH"

# 5) claude-swap
if ! command -v cswap >/dev/null 2>&1; then
  echo "[postCreate] installing claude-swap via uv tool"
  uv tool install claude-swap
else
  echo "[postCreate] cswap already present"
fi

cswap --help >/dev/null

# 6) gcloud (Google Cloud CLI)
if ! command -v gcloud >/dev/null 2>&1; then
  echo "[postCreate] installing google-cloud-cli"
  sudo apt-get update
  sudo apt-get install -y ca-certificates curl gnupg apt-transport-https

  sudo install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://packages.cloud.google.com/apt/doc/apt-key.gpg \
    | sudo gpg --dearmor -o /etc/apt/keyrings/google-cloud-cli.gpg
  sudo chmod a+r /etc/apt/keyrings/google-cloud-cli.gpg

  echo "deb [signed-by=/etc/apt/keyrings/google-cloud-cli.gpg] https://packages.cloud.google.com/apt cloud-sdk main" \
    | sudo tee /etc/apt/sources.list.d/google-cloud-cli.list >/dev/null

  sudo apt-get update
  sudo apt-get install -y google-cloud-cli
else
  echo "[postCreate] gcloud already present"
fi

gcloud version >/dev/null 2>&1 || true
echo "[postCreate] done"