import { spawn, spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Command } from 'commander'

import { generateFS } from '../export-fs'
import { slugify } from '../fuse-json'
import { die, getCtx } from '../lib/helpers'

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
}

// Returns extra args needed between process.execPath and `__daemon`.
//
// The daemon is spawned as: spawn(process.execPath, [...getDaemonArgs(), '__daemon', ...])
//
// Compiled binary (install.sh): process.execPath = "/usr/local/bin/crm"
//   argv[1] = "mount" (a subcommand, not a script) → returns []
//   → spawn("/usr/local/bin/crm", ["__daemon", ...])
//
// Runtime (npm i -g, bun i -g, bun run src/cli.ts):
//   process.execPath = "node" or "bun", argv[1] = script path
//   → returns [resolved script] so the runtime knows which file to execute
//   → spawn("node", [".../dist/cli.js", "__daemon", ...])
//   → spawn("bun", ["src/cli.ts", "__daemon", ...])
//
// npm i -g caveat: argv[1] is a symlink like ".../bin/crm" (no .js extension)
// that points to ".../dist/cli.js". We resolve the symlink to get the real path.
function getDaemonArgs(): string[] {
  const script = process.argv[1]
  if (!script) {
    return []
  }
  // Resolve symlinks (npm global bin creates "crm" → "dist/cli.js" symlinks)
  const resolved = realpathSync(script)
  if (/\.[tj]s$/.test(resolved)) {
    return [resolved]
  }
  return []
}

// ── macOS NFS mount (no FUSE dependency) ──

async function mountDarwin(
  mp: string,
  config: {
    database: { path: string }
    pipeline: { stages: string[] }
    mount: { readonly?: boolean }
  },
  _opts: { readonly?: boolean },
) {
  const nfsHelperPath = join(homedir(), '.crm', 'bin', 'crm-nfs')

  if (!existsSync(nfsHelperPath)) {
    // Auto-compile the Rust NFS server
    const nfsSrcDir = join(import.meta.dir, '..', 'nfs-server')
    if (!existsSync(join(nfsSrcDir, 'Cargo.toml'))) {
      die(`Error: NFS server source not found at ${nfsSrcDir}`)
    }
    ensureDir(join(homedir(), '.crm', 'bin'))
    const cargoPath =
      spawnSync('which', ['cargo'], { stdio: ['pipe', 'pipe', 'pipe'] })
        .stdout?.toString()
        .trim() || join(homedir(), '.cargo', 'bin', 'cargo')
    if (!existsSync(cargoPath)) {
      die(
        "Error: Rust not found. Install with: curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh",
      )
    }
    console.log('Compiling NFS server (first time only)...')
    const compile = spawnSync(
      cargoPath,
      ['build', '--release', '--manifest-path', join(nfsSrcDir, 'Cargo.toml')],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    )
    if (compile.status !== 0) {
      die(
        `Error: Failed to compile NFS server.\n${compile.stderr?.toString() || ''}`,
      )
    }
    // cat > strips com.apple.provenance which macOS adds to Cargo-built
    // binaries — the attribute causes SIGKILL when spawned as a child process
    const built = join(nfsSrcDir, 'target', 'release', 'crm-nfs')
    spawnSync('sh', [
      '-c',
      `cat "${built}" > "${nfsHelperPath}" && chmod +x "${nfsHelperPath}"`,
    ])
  }

  // Start the daemon (runs as `crm __daemon` — works with both bun and compiled binary)
  const socketPath = join(tmpdir(), `crm-fuse-${slugify(mp)}.sock`)

  const daemonProc = spawn(
    process.execPath,
    [
      ...getDaemonArgs(),
      '__daemon',
      socketPath,
      config.database.path,
      ...config.pipeline.stages,
    ],
    { stdio: 'ignore', detached: true },
  )
  daemonProc.unref()

  // Wait for daemon socket
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    if (existsSync(socketPath)) {
      break
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  if (!existsSync(socketPath)) {
    daemonProc.kill()
    die('Error: FUSE daemon failed to start.')
  }

  // Start the NFS server (port 0 = auto-assign)
  const nfsProc = spawn(nfsHelperPath, [socketPath, '0'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: true,
  })

  // Read the port from the NFS server's stdout (first line)
  const port = await new Promise<number>((resolve, reject) => {
    let buf = ''
    const timeout = setTimeout(
      () => reject(new Error('NFS server did not report port')),
      5000,
    )
    nfsProc.stdout?.on('data', (chunk: Buffer) => {
      buf += chunk.toString()
      const nl = buf.indexOf('\n')
      if (nl !== -1) {
        clearTimeout(timeout)
        resolve(Number(buf.slice(0, nl).trim()))
      }
    })
    nfsProc.on('exit', (code) => {
      clearTimeout(timeout)
      reject(new Error(`NFS server exited with code ${code}`))
    })
  }).catch((err) => {
    daemonProc.kill()
    try {
      nfsProc.kill()
    } catch {
      // already dead
    }
    die(`Error: ${err.message}`)
    return 0 // unreachable but satisfies TS
  })

  // Detach stdio so the CLI process can exit while NFS server keeps running
  nfsProc.stdout?.destroy()
  nfsProc.stderr?.destroy()
  nfsProc.stdin?.destroy()
  nfsProc.unref()

  // Wait for the NFS server to actually accept connections before mounting.
  // Without this, mount_nfs connects before handle_forever() starts and the
  // NFS client sits in "not responding" for the full timeo duration.
  const connDeadline = Date.now() + 3000
  while (Date.now() < connDeadline) {
    try {
      const net = await import('node:net')
      const ok = await new Promise<boolean>((resolve) => {
        const sock = net.createConnection({ host: '127.0.0.1', port }, () => {
          sock.destroy()
          resolve(true)
        })
        sock.on('error', () => resolve(false))
      })
      if (ok) {
        break
      }
    } catch {
      // not ready
    }
    await new Promise((r) => setTimeout(r, 50))
  }

  // Mount via macOS's built-in NFS client
  const mountResult = spawnSync(
    '/sbin/mount_nfs',
    [
      '-o',
      `locallocks,vers=3,tcp,port=${port},mountport=${port},soft,intr,timeo=10,retrans=3,noac`,
      '127.0.0.1:/',
      mp,
    ],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  )
  if (mountResult.status !== 0) {
    daemonProc.kill()
    try {
      nfsProc.kill()
    } catch {
      // already dead
    }
    die(
      `Error: NFS mount failed: ${mountResult.stderr?.toString() || 'unknown error'}`,
    )
  }

  // Write PID file (same format: line 1 = server PID, line 2 = daemon PID)
  const pidFile = join(tmpdir(), `crm-mount-${slugify(mp)}.pid`)
  writeFileSync(pidFile, `${nfsProc.pid}\n${daemonProc.pid}`)

  console.log(`Mounted at ${mp} (NFS port ${port}, PID ${nfsProc.pid})`)
}

// ── Linux FUSE mount ──

async function mountLinux(
  mp: string,
  config: {
    database: { path: string }
    pipeline: { stages: string[] }
    mount: { readonly?: boolean }
  },
  opts: { readonly?: boolean },
) {
  const helperPath = join(homedir(), '.crm', 'bin', 'crm-fuse')

  if (!existsSync(helperPath)) {
    const srcPath = join(import.meta.dir, '..', 'fuse-helper.c')
    if (!existsSync(srcPath)) {
      die(
        'Error: FUSE helper not found. Install FUSE dependencies and rebuild, or use `crm export-fs` instead.',
      )
    }
    ensureDir(join(homedir(), '.crm', 'bin'))
    const fuseFlags = (() => {
      const pc3 = spawnSync('pkg-config', ['--cflags', '--libs', 'fuse3'])
      if (pc3.status === 0 && pc3.stdout) {
        return pc3.stdout.toString().trim().split(/\s+/)
      }
      return ['-lfuse3', '-lpthread']
    })()
    const compile = spawnSync(
      'gcc',
      ['-o', helperPath, srcPath, ...fuseFlags],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    )
    if (compile.status !== 0) {
      die(
        `Error: Failed to compile FUSE helper. Install libfuse3-dev (apt) or fuse3-devel (yum).\n${compile.stderr?.toString() || ''}`,
      )
    }
  }

  // Start the daemon (runs as `crm __daemon` — works with both bun and compiled binary)
  const socketPath = join(tmpdir(), `crm-fuse-${slugify(mp)}.sock`)

  const daemonProc = spawn(
    process.execPath,
    [
      ...getDaemonArgs(),
      '__daemon',
      socketPath,
      config.database.path,
      ...config.pipeline.stages,
    ],
    { stdio: 'ignore', detached: true },
  )
  daemonProc.unref()

  // Wait for daemon socket
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    if (existsSync(socketPath)) {
      break
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  if (!existsSync(socketPath)) {
    daemonProc.kill()
    die('Error: FUSE daemon failed to start.')
  }

  // Spawn the FUSE helper
  const fuseArgs = ['-f', mp, '--', socketPath]
  if (opts.readonly || config.mount.readonly) {
    fuseArgs.unshift('-o', 'ro')
  }

  const fuseProc = spawn(helperPath, fuseArgs, {
    stdio: 'ignore',
    detached: true,
  })

  await new Promise((resolve) => setTimeout(resolve, 500))

  if (fuseProc.exitCode !== null) {
    daemonProc.kill()
    die('Error: FUSE mount failed. Is FUSE available?')
  }

  fuseProc.unref()

  const pidFile = join(tmpdir(), `crm-mount-${slugify(mp)}.pid`)
  writeFileSync(pidFile, `${fuseProc.pid}\n${daemonProc.pid}`)

  console.log(`Mounted at ${mp} (PID ${fuseProc.pid})`)
}

// ── Unmount ──

async function unmountDarwin(mp: string) {
  const pidFile = join(tmpdir(), `crm-mount-${slugify(mp)}.pid`)

  if (existsSync(pidFile)) {
    const lines = readFileSync(pidFile, 'utf-8').trim().split('\n')
    const serverPid = Number(lines[0])
    const daemonPid = lines[1] ? Number(lines[1]) : null

    // Kill NFS server first and wait for exit — umount while the server
    // is alive panics the macOS NFS client.
    try {
      process.kill(serverPid, 'SIGTERM')
    } catch {
      // already dead
    }
    const deadline = Date.now() + 2000
    while (Date.now() < deadline) {
      try {
        process.kill(serverPid, 0)
        await new Promise((r) => setTimeout(r, 20))
      } catch {
        break
      }
    }
    try {
      process.kill(serverPid, 'SIGKILL')
    } catch {
      // already dead
    }
    // Brief pause for TCP to fully close
    await new Promise((r) => setTimeout(r, 50))

    if (daemonPid) {
      try {
        process.kill(daemonPid)
      } catch {
        // already dead
      }
    }
    unlinkSync(pidFile)
  }

  // Server is dead — umount on a dead NFS mount returns instantly
  spawnSync('umount', [mp], { stdio: ['pipe', 'pipe', 'pipe'] })
}

function unmountLinux(mp: string) {
  // Unmount first so the kernel cleanly tears down the FUSE session — the
  // helper receives the destroy callback and exits naturally. Both orderings
  // produce identical results on Linux (empirically verified), but unmount-
  // first is the canonical FUSE teardown sequence.
  const result = spawnSync('fusermount', ['-u', mp], {
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  if (result.status !== 0) {
    spawnSync('umount', [mp], { stdio: ['pipe', 'pipe', 'pipe'] })
  }

  const pidFile = join(tmpdir(), `crm-mount-${slugify(mp)}.pid`)
  if (existsSync(pidFile)) {
    const pids = readFileSync(pidFile, 'utf-8').trim().split('\n')
    for (const pid of pids) {
      try {
        process.kill(Number(pid))
      } catch {
        // already dead
      }
    }
    unlinkSync(pidFile)
  }

  // Clean up the daemon socket (not removed by kill alone)
  const socketPath = join(tmpdir(), `crm-fuse-${slugify(mp)}.sock`)
  try {
    unlinkSync(socketPath)
  } catch {
    // may not exist
  }
}

// ── CLI registration ──

export function registerFuseCommands(program: Command) {
  program
    .command('mount')
    .description('Mount CRM as virtual filesystem')
    .argument('[mountpoint]', 'Mount point directory')
    .option('--readonly', 'Mount read-only')
    .action(async (mountpoint, opts) => {
      const { config } = await getCtx()
      const mp = mountpoint || config.mount.default_path

      // Check if already mounted
      const pidFile = join(tmpdir(), `crm-mount-${slugify(mp)}.pid`)
      if (existsSync(pidFile)) {
        const pids = readFileSync(pidFile, 'utf-8').trim().split('\n')
        const alive = pids.some((pid) => {
          try {
            process.kill(Number(pid), 0)
            return true
          } catch {
            return false
          }
        })
        if (alive) {
          die(
            `Error: ${mp} is already mounted. Run \`crm unmount ${mp}\` first.`,
          )
        }
        // Stale PID file — clean up
        unlinkSync(pidFile)
      }

      if (!existsSync(mp)) {
        mkdirSync(mp, { recursive: true })
      }

      if (process.platform === 'darwin') {
        await mountDarwin(mp, config, opts)
      } else {
        await mountLinux(mp, config, opts)
      }
    })

  program
    .command('unmount')
    .description('Unmount CRM filesystem')
    .argument('[mountpoint]', 'Mount point')
    .action(async (mountpoint?: string) => {
      const { config } = await getCtx()
      const mp = mountpoint || config.mount.default_path

      if (process.platform === 'darwin') {
        await unmountDarwin(mp)
      } else {
        await unmountLinux(mp)
      }

      console.log(`Unmounted ${mp}`)
    })

  program
    .command('export-fs')
    .description('Export CRM data as static filesystem tree')
    .argument('<dir>', 'Output directory')
    .action(async (dir) => {
      const { db, config } = await getCtx()
      await generateFS(db, config, dir)
      console.log(`Exported to ${dir}`)
    })
}
