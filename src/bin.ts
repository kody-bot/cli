#!/usr/bin/env node
import { runCli } from './cli.js'

const code = await runCli()
process.exitCode = code
