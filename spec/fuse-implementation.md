# FUSE Virtual Filesystem — Implementation Spec

## Why FUSE, not MCP

Every CLI CRM exposes data via subcommands. The closest competitor (crmcli.sh) adds an MCP server so AI agents can query the CRM. That's an integration — agents need to speak the MCP protocol.

FUSE makes CRM data accessible via the filesystem. Any tool that reads files — `cat`, `grep`, `jq`, Claude Code, Codex, vim — has CRM access without any integration. The filesystem is the universal API. It's a lower, more universal layer than any protocol.

This was the original insight: FUSE is an AI-native interface *by accident*. Nobody designed the filesystem for AI agents, but it turns out to be the ideal surface because every agent already knows how to read files. MCP requires adoption. FUSE requires nothing.

## The N-API Library Graveyard (2026-04-04)

The obvious approach — use an npm FUSE binding — doesn't work. We tried everything.

### fuse-native@2.2.6

The most popular Node.js FUSE package. Last published ~5 years ago.

**Failure chain:**
1. `bun add fuse-native` → installs fine
2. `bun pm trust fuse-native` → triggers native rebuild via bundled node-gyp v6.1.0
3. node-gyp v6.1.0 has a known bug on Node.js 20+: `Cannot assign to read only property 'cflags'`
4. Dead. No fix possible without forking the package and updating its bundled node-gyp.

### node-fuse-bindings@2.12.4

Same bundled node-gyp v6.1.0 → same crash. We tried upgrading to global node-gyp v12.2.0, which bypasses the cflags bug. But then:

1. The C++ source includes `<fuse.h>` (FUSE2 API)
2. Modern Linux only ships `fuse3` — no `fuse.pc` pkg-config file
3. We symlinked `fuse3.pc` as `fuse.pc` to trick pkg-config
4. Compilation fails anyway — the C++ code uses FUSE2 struct layouts that don't exist in FUSE3 headers

**Conclusion:** Both N-API packages target FUSE2 and ship with ancient, broken build tools. There is no working N-API FUSE3 binding in the npm ecosystem as of April 2026.

### Why we didn't write our own N-API binding

Considered and rejected. Writing N-API bindings for FUSE3 means maintaining C++ glue code, dealing with node-gyp build chains across platforms, and testing against Bun's N-API compatibility layer (which has its own gaps). The juice isn't worth the squeeze when a simpler approach exists.

## Validated Approach: Compiled C Helper

Write a minimal FUSE3 program in C, compile it against libfuse3, spawn from Bun. We built a smoke test and it works.

### Reproducing the smoke test

```bash
# Prerequisites (Debian/Ubuntu)
sudo apt-get install -y fuse3 libfuse3-dev
pkg-config --libs fuse3    # → -lfuse3 -lpthread

# /dev/fuse permissions (may be 0600 root:root by default)
sudo chmod 666 /dev/fuse
# Or: sudo usermod -aG fuse $USER

# Compile and run
cd test/fuse-smoke
gcc -Wall -o hello_fuse hello_fuse.c $(pkg-config --cflags --libs fuse3)
cd ../..
bun run test/fuse-smoke/smoke.ts
```

All 4 assertions pass: mount, readdir, readfile (JSON content), ENOENT on missing file.

### What the smoke test proves and doesn't prove

**Proves:**
- FUSE3 + libfuse3-dev compiles with no special flags — just `pkg-config`
- Bun's `fs` API (`readFileSync`, `readdirSync`) works transparently with FUSE mounts — no special handling needed
- Error codes propagate correctly through kernel FUSE → Node.js `fs` (ENOENT works)
- `Bun.spawn()` manages the FUSE process lifecycle correctly (start, kill, cleanup)

**Doesn't prove (needs testing during implementation):**
- SQLite reads from inside FUSE callbacks (the real helper queries the DB on every read)
- Symlink resolution through FUSE (the index directories use symlinks)
- macOS + macFUSE (only tested on Linux)
- Concurrent CLI writes + FUSE reads (WAL mode should handle this, but untested)
- Performance with hundreds of entities

## Why C, Not Bun FFI

We considered three approaches for the FUSE daemon:

**Bun FFI (rejected):** FUSE requires passing a struct of ~40 callback function pointers to `fuse_main()`. Bun's FFI supports callbacks, but: (a) each callback needs individual FFI registration, (b) the callbacks are invoked from kernel threads outside the Bun event loop, (c) FUSE callbacks involve raw buffer pointers and offset arithmetic that's painful in FFI, (d) debugging C-level crashes in FFI callbacks is brutal. The complexity isn't worth it.

**Node.js/Bun subprocess with N-API binding (rejected):** No working FUSE3 N-API binding exists (see graveyard above). Even if one existed, spawning a full Bun runtime for the FUSE daemon adds ~50MB memory overhead. A C binary is ~20KB.

**Compiled C binary (chosen):** Simple, fast, debuggable. The tradeoff is a build step and duplicated SQLite queries (Drizzle in CLI, raw SQL in C). But the build step is hidden by the install script, and the FUSE helper only needs read queries — a small, stable surface area.

## macOS Compatibility Concern

This is the biggest open risk. macFUSE exposes a FUSE2-compatible API, but our helper targets FUSE3 (`#define FUSE_USE_VERSION 35`). Three possible outcomes:

1. **macFUSE's FUSE3 compat layer works** — best case, no code changes
2. **Needs conditional compilation** — `#ifdef __APPLE__` with FUSE2 code path for macOS
3. **FUSE-T works instead** — FUSE-T is a pure-userspace FUSE for macOS (no kernel extension, no SIP issues). Newer and less battle-tested but avoids the macFUSE kernel extension pain.

Half the target audience is on macOS. This needs testing before v0.1 ships. If neither macFUSE nor FUSE-T works cleanly, the fallback is `crm export-fs` — a static file tree export that provides the same directory structure without a live mount.

## Open Design Questions

### SQLite queries: C or shell out?

The FUSE helper reads SQLite directly via the C API. This means SQL queries exist in two places — Drizzle ORM (CLI) and raw SQL (C helper). Keeping them in sync is a maintenance burden.

Alternative: the FUSE helper shells out to `crm show <id> --format json` on every file read. Simpler (single source of truth for queries), but adds ~25ms latency per read (Bun cold start). For `ls` on a directory with 100 entries, that's 2.5 seconds. Probably too slow.

Current decision: duplicate the queries in C. The FUSE helper only does reads, and the read queries are simple (`SELECT * FROM contacts WHERE id = ?`). The surface area is small enough that sync drift is manageable.

### Caching

If the FUSE helper caches query results, CLI writes won't be reflected until the cache expires. Options considered:

1. **No cache — query on every read.** Simple. Works for <5K records. This is the v0.1 approach.
2. **inotify on the SQLite file.** Invalidate cache when the WAL changes. More complex but scales better.
3. **Shared-memory signal.** CLI writes a flag, FUSE daemon reads it. Overkill for v0.1.

Decision: no cache for v0.1. SQLite reads are fast enough at our scale. Revisit if someone reports latency with large datasets.

### The `crm export-fs` fallback

If FUSE is completely unavailable (containers, Windows, macOS without macFUSE), `crm export-fs ~/crm-export` generates a static directory tree — same JSON files, same symlink indexes, one-time snapshot. Not live (stale until re-run), but covers the core use case of "agent reads CRM files."

This is a safety net, not a primary feature. The FUSE mount is the real differentiator — live, always-current, zero-copy. But having a fallback means FUSE unavailability doesn't block the entire "files as AI interface" story.
