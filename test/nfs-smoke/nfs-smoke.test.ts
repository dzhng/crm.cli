/**
 * NFS smoke test — validates the pure-NFS approach (no FUSE) on macOS.
 *
 * Uses nfsserve's demo binary (Rust NFS v3 server by HuggingFace).
 * Build first: ./test/nfs-smoke/build.sh
 *
 * Run: bun test test/nfs-smoke/nfs-smoke.test.ts --timeout 30000
 */
import { afterAll, describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Subprocess } from 'bun'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const BIN_PATH = join(import.meta.dir, 'bin', 'nfs-demo')
const MOUNT_NFS = '/sbin/mount_nfs'
const nfsAvailable =
  process.platform === 'darwin' && existsSync(MOUNT_NFS) && existsSync(BIN_PATH)

// Port is hardcoded in the demo binary (11111), so no dynamic allocation needed.

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function startNFSServer(port: number): Subprocess {
  // nfsserve demo listens on the compiled-in port (11111).
  // We patch the port via env var if supported, otherwise use the default.
  // The demo binary binds to 127.0.0.1:HOSTPORT.
  return Bun.spawn([BIN_PATH], {
    env: { ...process.env, HOSTPORT: String(port) },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
}

function nfsMount(port: number, mountpoint: string): boolean {
  const result = Bun.spawnSync(
    [
      MOUNT_NFS,
      '-o',
      `locallocks,vers=3,tcp,port=${port},mountport=${port},soft,timeo=100,retrans=5`,
      '127.0.0.1:/',
      mountpoint,
    ],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  )
  if (result.exitCode !== 0) {
    console.error('mount_nfs failed:', result.stderr.toString())
  }
  return result.exitCode === 0
}

function nfsUnmount(mountpoint: string): void {
  Bun.spawnSync(['/sbin/umount', mountpoint], {
    stdio: ['pipe', 'pipe', 'pipe'],
  })
}

function waitForMount(mountpoint: string, timeoutMs = 5000): boolean {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const entries = readdirSync(mountpoint)
      if (entries.length > 0) {
        return true
      }
    } catch {
      // not ready
    }
    Bun.sleepSync(50)
  }
  return false
}

function killAndWait(proc: Subprocess): void {
  try {
    proc.kill('SIGTERM')
  } catch {
    // already dead
  }
  const deadline = Date.now() + 3000
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) {
      break
    }
    Bun.sleepSync(50)
  }
  try {
    proc.kill('SIGKILL')
  } catch {
    // already dead
  }
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

const cleanups: Array<() => void> = []

afterAll(() => {
  for (const fn of cleanups.reverse()) {
    try {
      fn()
    } catch {
      // best effort
    }
  }
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('nfs smoke test', () => {
  test('nfs-demo binary is built', () => {
    if (!existsSync(BIN_PATH)) {
      console.warn(
        `nfs-demo binary not found at ${BIN_PATH}\n` +
          'Build it with: ./test/nfs-smoke/build.sh\n' +
          "Requires Rust: curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh",
      )
    }
    expect(existsSync(BIN_PATH)).toBe(true)
  })

  test('mount, read files, verify sizes, unmount', () => {
    if (!nfsAvailable) {
      return
    }

    const port = 11_111 // demo binary hardcodes this port
    const proc = startNFSServer(port)
    cleanups.push(() => killAndWait(proc))

    // Wait for server to be ready
    Bun.sleepSync(500)

    const tmpDir = mkdtempSync(join(tmpdir(), 'nfs-smoke-'))
    cleanups.push(() => rmSync(tmpDir, { recursive: true, force: true }))

    const mp = join(tmpDir, 'mnt')
    mkdirSync(mp)

    const mounted = nfsMount(port, mp)
    if (mounted) {
      cleanups.push(() => nfsUnmount(mp))
    }
    expect(mounted).toBe(true)

    expect(waitForMount(mp)).toBe(true)

    // Read a.txt — demo serves "hello world\n"
    const content = readFileSync(join(mp, 'a.txt'), 'utf-8')
    expect(content).toBe('hello world\n')

    // Verify correct size (no null-byte padding — the FUSE-T bug)
    const buf = readFileSync(join(mp, 'a.txt'))
    expect(buf.length).toBe(12) // "hello world\n" = 12 bytes

    // Read directory listing
    const entries = readdirSync(mp)
    expect(entries).toContain('a.txt')
    expect(entries).toContain('b.txt')
    expect(entries).toContain('another_dir')

    // Unmount
    nfsUnmount(mp)
    killAndWait(proc)

    // Verify clean unmount
    const afterEntries = readdirSync(mp)
    expect(afterEntries).not.toContain('a.txt')
  })

  test('soft mount: server dies → reads fail fast, no hang', () => {
    if (!nfsAvailable) {
      return
    }

    const port = 11_111
    const proc = startNFSServer(port)

    Bun.sleepSync(500)

    const tmpDir = mkdtempSync(join(tmpdir(), 'nfs-soft-'))
    cleanups.push(() => rmSync(tmpDir, { recursive: true, force: true }))
    const mp = join(tmpDir, 'mnt')
    mkdirSync(mp)

    expect(nfsMount(port, mp)).toBe(true)
    cleanups.push(() => nfsUnmount(mp))
    expect(waitForMount(mp)).toBe(true)

    // Kill the NFS server
    killAndWait(proc)

    // Read should fail fast (soft mount), NOT hang
    const start = Date.now()
    let threw = false
    try {
      readFileSync(join(mp, 'a.txt'), 'utf-8')
    } catch {
      threw = true
    }
    const elapsed = Date.now() - start

    expect(threw).toBe(true)
    expect(elapsed).toBeLessThan(15_000) // should be well under 15s with soft mount

    nfsUnmount(mp)
  })

  test('rapid mount/unmount cycles (10x) — no kernel panic', () => {
    if (!nfsAvailable) {
      return
    }

    // Start ONE server and mount/unmount different mountpoints against it.
    // This tests the mount/unmount lifecycle without port reuse delays.
    const port = 11_111
    const proc = startNFSServer(port)
    cleanups.push(() => killAndWait(proc))
    Bun.sleepSync(500)

    for (let i = 0; i < 10; i++) {
      const tmpDir = mkdtempSync(join(tmpdir(), `nfs-cycle-${i}-`))
      const mp = join(tmpDir, 'mnt')
      mkdirSync(mp)

      const mounted = nfsMount(port, mp)
      if (!mounted) {
        rmSync(tmpDir, { recursive: true, force: true })
        throw new Error(`mount failed on cycle ${i}`)
      }

      expect(waitForMount(mp)).toBe(true)

      const content = readFileSync(join(mp, 'a.txt'), 'utf-8')
      expect(content).toBe('hello world\n')

      nfsUnmount(mp)
      rmSync(tmpDir, { recursive: true, force: true })
    }

    killAndWait(proc)
  })
})
