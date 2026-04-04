#!/usr/bin/env bun

import { Command } from 'commander'
import { cleanArgv } from './lib/helpers'
import { registerContactCommands } from './commands/contact'
import { registerCompanyCommands } from './commands/company'
import { registerDealCommands, registerPipelineCommand } from './commands/deal'
import { registerLogCommand, registerActivityCommands } from './commands/activity'
import { registerTagCommands } from './commands/tag'
import { registerSearchCommands } from './commands/search'
import { registerReportCommands } from './commands/report'
import { registerImportExportCommands } from './commands/importexport'
import { registerDupesCommand } from './commands/dupes'

const program = new Command()
program.name('crm').description('Headless CLI-first CRM').version('0.1.0')
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

try {
  program.parse(['node', 'crm', ...cleanArgv])
} catch (e: any) {
  if (e.exitCode !== undefined && e.exitCode === 0) process.exit(0)
  if (e.exitCode !== undefined) {
    process.exit(e.exitCode)
  }
  console.error(e.message || e)
  process.exit(1)
}
