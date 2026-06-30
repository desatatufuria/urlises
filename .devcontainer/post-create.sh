#!/usr/bin/env bash
set -euo pipefail

# ---------------------------------------------------------------------------
# Helper: recarga el PATH desde los archivos de perfil del usuario.
# En Debian, .bashrc tiene un guard de modo interactivo (return early),
# por eso también se lee .profile que no tiene ese guard.
# ---------------------------------------------------------------------------
refresh_env() {
  export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$PATH"
  # shellcheck source=/dev/null
  [ -f "$HOME/.profile" ] && source "$HOME/.profile" 2>/dev/null || true
  # shellcheck source=/dev/null
  [ -f "$HOME/.bashrc" ]  && source "$HOME/.bashrc"  2>/dev/null || true
}

refresh_env

# ---------------------------------------------------------------------------
# npm — redirigir el prefix global a un directorio del usuario.
# Sin esto, "npm install -g" falla con EACCES porque intenta escribir en
# /usr/local/lib/node_modules (propiedad de root).
# ---------------------------------------------------------------------------
echo "==> Configuring npm user-local prefix..."
mkdir -p "$HOME/.npm-global"
npm config set prefix "$HOME/.npm-global"
export PATH="$HOME/.npm-global/bin:$PATH"
# Persistir para sesiones futuras
grep -qxF 'export PATH="$HOME/.npm-global/bin:$PATH"' "$HOME/.bashrc" \
  || echo 'export PATH="$HOME/.npm-global/bin:$PATH"' >> "$HOME/.bashrc"

# ---------------------------------------------------------------------------
# opencode
# ---------------------------------------------------------------------------
echo "==> Installing opencode..."
curl -fsSL https://opencode.ai/install | bash

refresh_env

# ---------------------------------------------------------------------------
# codex
# ---------------------------------------------------------------------------
echo "==> Installing codex..."
curl -fsSL https://chatgpt.com/codex/install.sh | sh

refresh_env

# ---------------------------------------------------------------------------
# gentle-ai
# El script upstream sale con código 1 por una variable 'tmpdir' no ligada
# durante el cleanup, aunque el binario se instala correctamente.
# Por eso usamos || true.
# ---------------------------------------------------------------------------
echo "==> Installing gentle-ai..."
curl -fsSL https://raw.githubusercontent.com/Gentleman-Programming/gentle-ai/main/scripts/install.sh | bash || true

refresh_env

# ---------------------------------------------------------------------------
# codegraph
# Pasos: 1) instalar CLI  2) conectar agentes  3) indexar el proyecto
# ---------------------------------------------------------------------------
echo "==> Installing codegraph..."
curl -fsSL https://raw.githubusercontent.com/colbymchenry/codegraph/main/install.sh | sh

refresh_env

echo "==> Wiring codegraph into detected agents (non-interactive)..."
codegraph install --yes || true

echo "==> Initializing codegraph index for /workspace..."
codegraph init /workspace || true

refresh_env

echo "==> post-create setup complete."
