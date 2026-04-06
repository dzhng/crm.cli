#!/bin/bash
# Build the nfsserve demo binary for NFS smoke testing.
# Requires: Rust toolchain (curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh)
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BIN_DIR="$SCRIPT_DIR/bin"
REPO_DIR="$SCRIPT_DIR/.nfsserve"

if [ -f "$BIN_DIR/nfs-demo" ]; then
  echo "nfs-demo already built at $BIN_DIR/nfs-demo"
  exit 0
fi

if ! command -v cargo &>/dev/null; then
  echo "Error: cargo not found. Install Rust: curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh"
  exit 1
fi

echo "Cloning nfsserve..."
rm -rf "$REPO_DIR"
git clone --depth=1 https://github.com/huggingface/nfsserve.git "$REPO_DIR"

echo "Building demo..."
cd "$REPO_DIR"
cargo build --example demo --features demo --release

mkdir -p "$BIN_DIR"
cp target/release/examples/demo "$BIN_DIR/nfs-demo"
echo "Built $BIN_DIR/nfs-demo"

# Clean up source (keep only the binary)
rm -rf "$REPO_DIR"
