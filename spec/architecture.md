# Architecture — Design Decisions

## Spec-first methodology

We wrote 337 functional tests across 13 files before writing a single line of implementation code. This is unusual and intentional.

The reasoning: the README is the interface spec. Tests are the behavioral contracts. Implementation = make tests green. This means:

1. **Every design decision is made upfront.** You can't write a test for `crm deal move` without deciding how stage history works, whether to use activities or a JSON column, what the output format looks like. Tests force decisions.
2. **Implementation is mechanical.** Once the tests exist, the implementer doesn't need to make design choices — they just need to make tests pass. This is especially powerful with CC (AI coding tools), which excels at "make this test green" but struggles with "decide how this should work."
3. **The spec can't lie.** A README can describe behavior that doesn't exist. A passing test proves it works. Tests are executable documentation.

The scope decision came from the eng review: 337 tests were already written across every feature (CRUD, normalization, search, reports, FUSE, hooks). The question was whether to cut scope and carry dead test files, or implement everything. We chose everything — the tests are written, implementation is mechanical, and carrying partially-implemented features is more complex than finishing them.

## Why functional tests, not unit tests

Every test spawns the actual CLI binary via `Bun.spawnSync` and checks stdout/stderr/exit codes. No mocking, no importing internal modules, no test doubles.

The reasoning:

1. **Tests survive refactoring.** If we restructure `src/commands/contact.ts` into three files, unit tests break. Functional tests don't care about internal structure — they only care about CLI behavior.
2. **Tests are the spec.** A functional test reads like documentation: "when I run `crm contact add --name Jane --email jane@acme.com`, the output should contain the new contact ID." Anyone can read this without knowing the codebase.
3. **Tests catch integration bugs.** A unit test for phone normalization might pass, but the integration between normalization and storage might fail. Functional tests exercise the full stack.
4. **Fresh state per test.** Each test creates a temp directory and fresh database. No shared state, no ordering dependencies, no cleanup. Tests can run in parallel (Bun's default).

The trade-off: functional tests are slower than unit tests (~25ms per test for Bun cold start). With 337 tests, that's ~8 seconds total. Acceptable.

## Why Bun, not Node.js

The original design was pure TypeScript. The Bun-specific reasoning:

1. **`bun build --compile`** produces a standalone executable with the runtime embedded. Users don't need Node.js or Bun installed. This is the distribution story — a single binary, like Go or Rust, but written in TypeScript.
2. **Cold start time.** Bun starts in ~25ms vs Node.js ~75ms. Every `crm` command is a cold start (no daemon), so this compounds. 50ms savings × thousands of daily commands adds up.
3. **Built-in test runner.** `bun test` works with no config. No Jest, no Vitest, no babel/ts-jest/esbuild adapter chain.
4. **Native SQLite.** Bun includes `bun:sqlite` natively. We use libSQL for Drizzle compatibility, but having a native SQLite option means we could drop the libSQL dependency later if needed.

## Why libSQL + Drizzle, not bun:sqlite

Bun's native SQLite (`bun:sqlite`) is faster but doesn't integrate with Drizzle ORM. We chose Drizzle because:

1. **Type-safe schema definition.** The schema is defined in TypeScript, generates DDL, and provides TypeScript types. One source of truth for DB schema and type system.
2. **Migration system.** `drizzle-kit` generates migration files. Schema changes are versioned and reviewable, not ad-hoc `ALTER TABLE` statements.
3. **Query safety.** The query builder parameterizes inputs, preventing SQL injection. For a CLI that takes arbitrary user input (`--set`, `--filter`), this matters.
4. **Escape hatch to Turso.** libSQL is wire-compatible with Turso's hosted SQLite. If someone ever wants cloud sync, the migration path exists without changing the ORM layer.

The overhead of libSQL over `bun:sqlite` is negligible at our query volume (a few queries per CLI invocation).

## Why commander for CLI parsing

We need ~30 subcommands with repeatable flags, nested subcommands (e.g., `crm report pipeline`), help text generation, and flag validation. Building this from `process.argv` is a maintenance nightmare.

`commander` is the standard answer: stable, well-documented, supports everything we need. The only alternative we considered was `yargs`, which has a similar feature set but heavier API surface. Commander's chainable API is a better fit for our subcommand structure.

The key feature: repeatable flags (`--email jane@acme.com --email jane@gmail.com`). Both commander and yargs support this; raw argv parsing doesn't.

## Why Zod for validation

Zod sits between user input and the database. It validates flag values, import data, and FUSE write payloads.

The key reasoning: Zod schemas generate TypeScript types. We define the validation schema once, and the type system enforces it everywhere. No "validated at the boundary but typed as `any` internally" pattern.

For FUSE writes specifically, Zod provides machine-readable error messages (`Missing required field: "name"`, `Invalid type for "emails": expected array, got string`) that map to FUSE errno values (EINVAL). This gives AI agents writing through the filesystem immediate, actionable feedback on validation failures.

## Two search strategies and why both exist

**`crm search` (FTS5):** SQLite's built-in full-text search. Keyword matching across all entity fields. Fast, zero dependencies, always available. Handles "find everyone at Acme" or "deals mentioning enterprise."

**`crm find` (semantic):** Natural language search via local ONNX embeddings (`all-MiniLM-L6-v2`, ~80MB). Handles "that fintech CTO from London" or "deals we haven't touched in 2 weeks."

Why both:
- FTS5 is the baseline — it works on every machine, adds no dependencies, and covers exact/keyword matching perfectly. Most searches are keyword searches.
- Semantic search handles the long tail — queries where the user doesn't remember the exact terms. But it requires ONNX runtime (~50MB dependency) and the embedding model (~80MB download).
- We made semantic search *optional* and *degradable*. `crm find` falls back to FTS5 if ONNX is unavailable. The install script's `--minimal` flag skips ONNX entirely.

**Why local, not API:** The target user is a developer who cares about privacy and offline capability. CRM data is sensitive — contact details, deal values, meeting notes. Sending it to an embedding API is a non-starter for many users. Local inference means no API keys, no network calls, no data leaving the machine.

**Why ONNX was accepted as a dependency:** We debated whether an 80MB model download was too heavy for a CLI tool. The decision: it's optional, downloads lazily on first use, and caches locally. Users who don't want it never see it. Users who do want it get surprisingly good results from MiniLM for zero configuration.

## Concurrency model

No daemon (except the FUSE mount). Every CLI command is a stateless process. The concurrency questions:

**CLI + FUSE:** The FUSE helper opens the DB read-only. The CLI opens read-write. SQLite WAL mode supports concurrent readers + one writer. The FUSE helper queries on every read (no cache), so CLI writes are reflected on the next FUSE read with no invalidation needed.

**Multiple CLI processes:** Two terminals can run `crm` simultaneously. SQLite WAL handles concurrent writes with a lock — the second writer waits (default 5s timeout), then fails with "database locked" if it can't acquire. This is acceptable because the target user is one person running commands sequentially, not a web server handling concurrent requests.

**Why no daemon for the CLI:** A persistent daemon could provide warm caches, connection pooling, and faster startup. But it adds complexity (process management, IPC, crash recovery) for marginal benefit. At <5K records, SQLite queries are <1ms cold. The FUSE mount is the only feature that requires a persistent process, and it's a separate binary with a simple lifecycle.

## Error model

**stdout = data, stderr = errors.** This is a Unix convention, but it matters: `crm contact list --format json | jq '...'` works because errors don't pollute the JSON stream.

**Exit codes:** 0 = success, non-zero = error. We considered distinguishing user errors (invalid input, not found) from system errors (DB locked, disk full) with different exit codes (1 vs 2), but decided to keep it simple for v0.1. A non-zero exit code means something went wrong — the stderr message explains what.

**Error messages go to stderr, not stdout.** This seems obvious but it's the single most important decision for pipe-friendliness. `crm contact add --phone "not-a-number"` should write the error to stderr and exit 1, not print an error to stdout that downstream tools would try to parse as data.
