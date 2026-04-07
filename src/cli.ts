#!/usr/bin/env node

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Command } from 'commander'

import {
  registerActivityCommands,
  registerLogCommand,
} from './commands/activity'
import { registerCompanyCommands } from './commands/company'
import { registerContactCommands } from './commands/contact'
import { registerDealCommands, registerPipelineCommand } from './commands/deal'
import { registerDupesCommand } from './commands/dupes'
import { registerFuseCommands } from './commands/fuse'
import { registerImportExportCommands } from './commands/importexport'
import { registerReportCommands } from './commands/report'
import { registerSearchCommands } from './commands/search'
import { registerTagCommands } from './commands/tag'
import { startDaemon } from './fuse-daemon'
import { cleanArgv } from './lib/helpers'

const __dirname = dirname(fileURLToPath(import.meta.url))
const pkg = JSON.parse(
  readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'),
)

const program = new Command()
program.name('crm').description('Headless CLI-first CRM').version(pkg.version)
program.exitOverride()

registerContactCommands(program)
registerCompanyCommands(program)
registerDealCommands(program)
registerPipelineCommand(program)
registerLogCommand(program)
registerActivityCommands(program)
registerTagCommands(program)
registerSearchCommands(program)
registerReportCommands(program)
registerImportExportCommands(program)
registerDupesCommand(program)
registerFuseCommands(program)

// Hidden subcommand: runs the FUSE daemon in-process (used by `crm mount`)
if (cleanArgv[0] === '__daemon') {
  startDaemon(cleanArgv.slice(1)).catch((err) => {
    console.error('fuse-daemon fatal:', err)
    process.exit(1)
  })
} else {
  try {
    program.parse(['node', 'crm', ...cleanArgv])
  } catch (e: unknown) {
    const err = e as { exitCode?: number; message?: string }
    if (err.exitCode !== undefined && err.exitCode === 0) {
      process.exit(0)
    }
    if (err.exitCode !== undefined) {
      process.exit(err.exitCode)
    }
    console.error(err.message || e)
    process.exit(1)
  }
}
