# NFS Smoke Test

Validates the **pure-NFS approach** (no FUSE) for mounting CRM data on macOS.

Uses [nfsserve](https://github.com/huggingface/nfsserve), a Rust NFS v3 server
library used in production by HuggingFace and Turso (agentfs).

## Why NFS instead of FUSE?

We hit multiple issues with FUSE-T (the kext-less FUSE for macOS):

| Issue | Root cause | Impact |
|-------|-----------|--------|
| `JSON Parse error: Unrecognized token ''` | FUSE-T's NFS backend zero-pads reads to `st_size` when actual content is shorter | All file reads broken |
| System hang on unmount | Killing FUSE helper before `umount` leaves stale NFS mount; `umount` blocks forever waiting for dead server | Tests hang, require force-reboot |
| Kernel panic on `umount -f` | Force-unmounting while FUSE-T's NFS server is still alive panics macOS 26's NFS client | Full system reboot |
| Kernel panic on rapid mount/unmount | Async NFS teardown races with next mount; ~35 cycles triggers panic | Full system reboot during tests |

### Key lesson: FUSE-T *is* NFS under the hood

FUSE-T works by running a local NFS v4 server and mounting it via macOS's
built-in NFS client. The FUSE API is just a translation layer on top. All the
instability comes from how FUSE-T manages the NFS lifecycle.

### The agentfs approach

[agentfs](https://github.com/tursodatabase/agentfs) (by Turso) skips FUSE
entirely on macOS and runs its own NFS v3 server directly:

```
/sbin/mount_nfs -o locallocks,vers=3,tcp,port=PORT,mountport=PORT,soft,timeo=100,retrans=5 127.0.0.1:/ /mountpoint
```

Key mount options:
- **`soft`** — returns errors instead of hanging when server is unreachable
- **`timeo=100`** — 10-second timeout (in tenths of a second)
- **`retrans=5`** — max 5 retries before failing
- **`locallocks`** — use local locking (no NLM protocol needed)
- **`vers=3`** — NFS v3 (simpler and more stable than v4 on macOS)

This eliminates all FUSE-T issues because:
1. No FUSE dependency (no kernel extension, no FUSE-T)
2. NFS v3 (well-tested in macOS kernel, unlike FUSE-T's v4)
3. Soft mount (operations fail fast instead of hanging)
4. We control the server lifecycle directly

## Prerequisites

```bash
# Install Rust (if not already installed)
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# Build the NFS demo server
./build.sh
```

## Running

```bash
bun test test/nfs-smoke/nfs-smoke.test.ts --timeout 30000
```

## What it tests

1. **Basic mount/read/unmount** — start NFS server, mount, read a file, unmount
2. **Correct file sizes** — no null-byte padding (the FUSE-T bug)
3. **Soft mount failover** — server dies → reads fail fast (no hang)
4. **Rapid mount/unmount** — 10 cycles without kernel panic
