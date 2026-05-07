#!/usr/bin/env node
const { spawnSync } = require('child_process');

const platform = process.platform;
const arch = process.arch;
const ext = platform === 'win32' ? '.exe' : '';
const pkgName = `@proxai/gateway-${platform}-${arch}`;

let binPath;
try {
  binPath = require.resolve(`${pkgName}/proxai-gateway${ext}`);
} catch {
  console.error(`@proxai/gateway: no binary for ${platform}-${arch}`);
  console.error(`Install the matching platform package: npm install -g ${pkgName}`);
  process.exit(1);
}

const { status } = spawnSync(binPath, process.argv.slice(2), { stdio: 'inherit' });
process.exit(status ?? 1);
