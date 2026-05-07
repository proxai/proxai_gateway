#!/usr/bin/env node
const { spawnSync } = require('child_process');
const { resolve } = require('node:path');

const ext = process.platform === 'win32' ? '.exe' : '';
const binPath = resolve(__dirname, 'bin', `proxai-gateway${ext}`);

const { status, error } = spawnSync(binPath, process.argv.slice(2), { stdio: 'inherit' });
if (error) {
  console.error(`@proxai/gateway: failed to run binary at ${binPath}`);
  console.error('Try reinstalling: npm install -g @proxai/gateway');
  process.exit(1);
}
process.exit(status ?? 1);
