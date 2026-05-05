#!/usr/bin/env bun
import { Command } from 'commander';

import packageJson from '../package.json' with { type: 'json' };

const program = new Command();

program.name('proxai-gateway').description(packageJson.description).version(packageJson.version);

program.parse();
