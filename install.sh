#!/bin/sh
set -e

REPO="dzhng/crm.cli"
INSTALL_DIR="${CRM_INSTALL_DIR:-$HOME/.local/bin}"
FUSE_DEPS=false
ONNX_DEPS=false
MINIMAL=false

usage() {
  cat <<EOF
crm.cli installer

Usage:
  curl -fsSL https://raw.githubusercontent.com/$REPO/main/install.sh | sh
  curl -fsSL https://raw.githubusercontent.com/$REPO/main/install.sh | sh -s -- [OPTIONS]

Options:
  --all       Install with all optional dependencies (FUSE + ONNX)
  --minimal   Binary only (no FUSE, no semantic search)
  --help      Show this help message
EOF
  exit 0
}

# Parse arguments
for arg in "$@"; do
  case "$arg" in
    --all)
      FUSE_DEPS=true
      ONNX_DEPS=true
      ;;
    --minimal)
      MINIMAL=true
      ;;
    --help|-h)
      usage
      ;;
  esac
done

# Detect platform
OS="$(uname -s)"
ARCH="$(uname -m)"

case "$OS" in
  Linux)  PLATFORM="linux" ;;
  Darwin) PLATFORM="darwin" ;;
  *)
    echo "Error: unsupported OS: $OS"
    exit 1
    ;;
esac

case "$ARCH" in
  x86_64|amd64)  ARCH="x64" ;;
  aarch64|arm64) ARCH="arm64" ;;
  *)
    echo "Error: unsupported architecture: $ARCH"
    exit 1
    ;;
esac

echo "Detected platform: ${PLATFORM}-${ARCH}"

# Get latest release tag
LATEST=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" | grep '"tag_name"' | sed -E 's/.*"([^"]+)".*/\1/')
if [ -z "$LATEST" ]; then
  echo "Error: could not determine latest release"
  exit 1
fi
echo "Latest release: $LATEST"

# Download binary
BINARY_NAME="crm-${PLATFORM}-${ARCH}"
DOWNLOAD_URL="https://github.com/$REPO/releases/download/$LATEST/$BINARY_NAME"
echo "Downloading $DOWNLOAD_URL..."

TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT

curl -fsSL -o "$TMP_DIR/crm" "$DOWNLOAD_URL"
chmod +x "$TMP_DIR/crm"

# Install binary
mkdir -p "$INSTALL_DIR"
mv "$TMP_DIR/crm" "$INSTALL_DIR/crm"
echo "Installed crm to $INSTALL_DIR/crm"

# Check if INSTALL_DIR is in PATH
case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *)
    echo ""
    echo "Warning: $INSTALL_DIR is not in your PATH."
    echo "Add it with:"
    echo "  export PATH=\"$INSTALL_DIR:\$PATH\""
    echo ""
    ;;
esac

# Optional FUSE dependencies
if [ "$FUSE_DEPS" = true ] && [ "$MINIMAL" = false ]; then
  echo ""
  echo "Installing FUSE dependencies..."
  case "$PLATFORM" in
    linux)
      if command -v apt-get >/dev/null 2>&1; then
        sudo apt-get install -y libfuse3-dev libsqlite3-dev
      elif command -v yum >/dev/null 2>&1; then
        sudo yum install -y fuse3-devel sqlite-devel
      elif command -v pacman >/dev/null 2>&1; then
        sudo pacman -S --noconfirm fuse3 sqlite
      else
        echo "Warning: could not detect package manager. Install libfuse3-dev and libsqlite3-dev manually."
      fi
      ;;
    darwin)
      if command -v brew >/dev/null 2>&1; then
        brew install macfuse
      else
        echo "Warning: Homebrew not found. Install macFUSE from https://osxfuse.github.io/"
      fi
      ;;
  esac
fi

# Optional ONNX runtime for semantic search
if [ "$ONNX_DEPS" = true ] && [ "$MINIMAL" = false ]; then
  echo ""
  echo "Downloading embedding model for semantic search..."
  MODEL_DIR="$HOME/.crm/models"
  mkdir -p "$MODEL_DIR"
  if [ ! -f "$MODEL_DIR/all-MiniLM-L6-v2.onnx" ]; then
    curl -fsSL -o "$MODEL_DIR/all-MiniLM-L6-v2.onnx" \
      "https://huggingface.co/Xenova/all-MiniLM-L6-v2/resolve/main/onnx/model_quantized.onnx" || \
      echo "Warning: failed to download embedding model. Semantic search (crm find) will use keyword fallback."
  else
    echo "Embedding model already present."
  fi
fi

echo ""
echo "crm.cli installed successfully!"
echo "Run 'crm --help' to get started."
