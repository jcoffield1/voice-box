#!/usr/bin/env bash
# scripts/setup_python_env.sh
#
# Downloads a portable Python runtime (python-build-standalone), creates a
# virtual environment with --copies so the interpreter is fully self-contained,
# then installs all Python dependencies from python/requirements.txt.
#
# The resulting python/venv/ directory is bundled into the shipped app via
# electron-builder extraResources — end users never need Python installed.
#
# Usage:
#   npm run setup:python          # normal install / update
#   FORCE=1 npm run setup:python  # force re-download + re-create (clean install)
#
# Outputs:
#   python/runtime/   — standalone CPython interpreter (dev build tool, not shipped)
#   python/venv/      — virtual env with --copies (shipped in the app bundle)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

PYTHON_VERSION="3.11.9"
PBS_DATE="20240726"

RUNTIME_DIR="$REPO_ROOT/python/runtime"
VENV_DIR="$REPO_ROOT/python/venv"
REQUIREMENTS="$REPO_ROOT/python/requirements.txt"

# ── Platform detection ────────────────────────────────────────────────────────

OS="$(uname -s)"
ARCH="$(uname -m)"

if [ "$OS" != "Darwin" ]; then
  echo "ERROR: This setup script currently supports macOS only." >&2
  echo "       For Linux/Windows CI, adapt the PBS_ARCH / URL pattern below." >&2
  exit 1
fi

if [ "$ARCH" = "arm64" ]; then
  PBS_ARCH="aarch64"
else
  PBS_ARCH="x86_64"
fi

TARBALL="cpython-${PYTHON_VERSION}+${PBS_DATE}-${PBS_ARCH}-apple-darwin-install_only.tar.gz"
DOWNLOAD_URL="https://github.com/indygreg/python-build-standalone/releases/download/${PBS_DATE}/${TARBALL}"

# ── Helpers ───────────────────────────────────────────────────────────────────

step() { echo ""; echo "▶ $*"; }
ok()   { echo "  ✔ $*"; }
skip() { echo "  ↷ $* (already present, use FORCE=1 to redo)"; }

FORCE="${FORCE:-0}"

# ── 1. Download standalone Python runtime ─────────────────────────────────────

step "Standalone Python ${PYTHON_VERSION} (${PBS_ARCH})"

if [ "$FORCE" = "1" ]; then
  rm -rf "$RUNTIME_DIR"
fi

if [ -f "$RUNTIME_DIR/bin/python3" ]; then
  skip "python/runtime/"
else
  TMP_DIR="$(mktemp -d)"
  trap 'rm -rf "$TMP_DIR"' EXIT

  echo "  Downloading $TARBALL …"
  curl -fL --progress-bar "$DOWNLOAD_URL" -o "$TMP_DIR/$TARBALL"

  echo "  Extracting …"
  tar -xzf "$TMP_DIR/$TARBALL" -C "$TMP_DIR"

  mkdir -p "$RUNTIME_DIR"
  cp -r "$TMP_DIR/python/." "$RUNTIME_DIR/"

  ok "python/runtime/ ready  ($(du -sh "$RUNTIME_DIR" | cut -f1))"
fi

PYTHON_BIN="$RUNTIME_DIR/bin/python3"

# ── 2. Create virtual environment with --copies ───────────────────────────────

step "Virtual environment (python/venv/)"

if [ "$FORCE" = "1" ]; then
  rm -rf "$VENV_DIR"
fi

if [ -f "$VENV_DIR/bin/python3" ]; then
  skip "python/venv/"
else
  echo "  Creating venv with --copies (portable, no symlinks) …"
  "$PYTHON_BIN" -m venv --copies "$VENV_DIR"
  ok "python/venv/ created"
fi

# The copied python3 binary resolves libpython via @executable_path/../lib/
# which points inside the venv, not the runtime.  Copy the dylib in so the
# binary can load at runtime (both in dev and when shipped in the .app).
step "Copying shared library into venv"
DYLIB_SRC="$RUNTIME_DIR/lib/libpython3.11.dylib"
DYLIB_DST="$VENV_DIR/lib/libpython3.11.dylib"
if [ -f "$DYLIB_DST" ] && [ "$FORCE" != "1" ]; then
  skip "libpython3.11.dylib already in venv/lib/"
elif [ -f "$DYLIB_SRC" ]; then
  cp "$DYLIB_SRC" "$DYLIB_DST"
  ok "libpython3.11.dylib copied to python/venv/lib/"
else
  echo "  WARNING: $DYLIB_SRC not found — skipping dylib copy" >&2
fi

VENV_PYTHON="$VENV_DIR/bin/python3"

# ── 3. Bootstrap pip + install dependencies ───────────────────────────────────
# python-build-standalone venvs may not have a pip binary in bin/ —
# use `python -m ensurepip` to bootstrap it, then `python -m pip` throughout.

step "Python dependencies"

echo "  Bootstrapping pip …"
"$VENV_PYTHON" -m ensurepip --upgrade 2>/dev/null || true

echo "  Upgrading pip …"
"$VENV_PYTHON" -m pip install --upgrade pip --quiet

echo "  Installing requirements …"
"$VENV_PYTHON" -m pip install -r "$REQUIREMENTS"

ok "All dependencies installed"

# ── 4. Smoke-test ─────────────────────────────────────────────────────────────

step "Smoke test"
"$VENV_PYTHON" -c "import numpy, soundfile; print('  numpy', numpy.__version__, '| soundfile', soundfile.__version__)"
ok "Imports OK"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Python environment ready."
echo "  Venv:   python/venv/"
echo "  Python: $("$VENV_PYTHON" --version)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
