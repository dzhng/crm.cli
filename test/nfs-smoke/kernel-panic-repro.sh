#!/bin/bash
# Reproduces a macOS kernel panic caused by Bun's writeFileSync on NFS mounts.
#
# writeFileSync uses O_CREAT|O_TRUNC which panics the macOS NFS client
# on the very first call. Shell echo/printf does NOT trigger the bug.
#
# Usage:
#   ./test/nfs-smoke/kernel-panic-repro.sh
#
# WARNING: This WILL kernel panic your Mac if the bug is present.
# Only run this when you're actively working on a fix.

set -e

PROJECT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
CRM_NFS="$HOME/.crm/bin/crm-nfs"

if [ ! -x "$CRM_NFS" ]; then
  echo "Error: crm-nfs not found at $CRM_NFS"
  echo "Build it: cd $PROJECT_DIR/src/nfs-server && cargo build --release && cat target/release/crm-nfs > $CRM_NFS && chmod +x $CRM_NFS"
  exit 1
fi

DB=$(mktemp -u).db
SOCK=$(mktemp -u).sock
MNT=$(mktemp -d)

cleanup() {
  umount "$MNT" 2>/dev/null || true
  kill $NFS_PID $DAEMON_PID 2>/dev/null || true
  rm -rf "$MNT" "$SOCK" "$DB" "${DB}-shm" "${DB}-wal"
}
trap cleanup EXIT

echo "Starting daemon..."
bun run "$PROJECT_DIR/src/fuse-daemon.ts" "$SOCK" "$DB" 2>/dev/null &
DAEMON_PID=$!
sleep 1

echo "Starting NFS server..."
PORT=11500
"$CRM_NFS" "$SOCK" "$PORT" 2>/dev/null &
NFS_PID=$!
sleep 1

echo "Mounting..."
/sbin/mount_nfs -o locallocks,vers=3,tcp,port=$PORT,mountport=$PORT,soft,intr,timeo=10,retrans=3,noac 127.0.0.1:/ "$MNT"

echo "Calling writeFileSync (O_CREAT|O_TRUNC) on NFS mount..."
echo "If this kernel panics, the bug is still present."
echo ""

bun -e "
const fs = require('fs');
fs.writeFileSync('$MNT/contacts/new.json', JSON.stringify({name:'Test',emails:['t@x.com']}));
console.log('PASS: writeFileSync survived without kernel panic.');
"
