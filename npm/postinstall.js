#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const os = require('node:os');

const REPO = 'proxai/proxai_gateway';

function platformAndArch() {
  const platform = process.platform;
  const arch = process.arch;
  const ext = platform === 'win32' ? '.exe' : '';
  return { platform, arch, ext };
}

function readVersion() {
  const pkg = require('./package.json');
  if (typeof pkg.version !== 'string' || pkg.version.length === 0) {
    throw new Error('@proxai/gateway: package.json missing version');
  }
  return pkg.version;
}

function assetUrl(version, platform, arch, ext) {
  return `https://github.com/${REPO}/releases/download/v${version}/proxai-gateway-${platform}-${arch}${ext}`;
}

function fetchToFile(url, destPath, redirectsRemaining) {
  if (redirectsRemaining === undefined) redirectsRemaining = 5;
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: {
          'User-Agent': '@proxai/gateway-postinstall',
          Accept: 'application/octet-stream',
        },
      },
      (res) => {
        if (
          res.statusCode !== undefined &&
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          typeof res.headers.location === 'string'
        ) {
          if (redirectsRemaining <= 0) {
            res.resume();
            reject(new Error(`too many redirects fetching ${url}`));
            return;
          }
          const next = new URL(res.headers.location, url).toString();
          res.resume();
          resolve(fetchToFile(next, destPath, redirectsRemaining - 1));
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`download failed: HTTP ${res.statusCode} for ${url}`));
          return;
        }
        const out = fs.createWriteStream(destPath);
        res.pipe(out);
        out.on('finish', () => out.close(() => resolve(undefined)));
        out.on('error', (err) => {
          fs.unlink(destPath, () => reject(err));
        });
        res.on('error', (err) => {
          fs.unlink(destPath, () => reject(err));
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(60_000, () => {
      req.destroy(new Error(`download timed out after 60s: ${url}`));
    });
  });
}

function manualInstructions(version, platform, arch, ext) {
  const url = assetUrl(version, platform, arch, ext);
  return [
    '',
    'You can install the binary manually:',
    '',
    `  curl -fsSL https://github.com/${REPO}/raw/main/install.sh | bash`,
    '',
    `Or download directly: ${url}`,
    '',
  ].join('\n');
}

async function main() {
  const version = readVersion();
  const { platform, arch, ext } = platformAndArch();

  if (platform === 'darwin' && arch === 'x64') {
    console.error(
      `error: Intel Mac (darwin-x64) is not supported by the prebuilt binary distribution.`,
    );
    console.error(`       Apple Silicon (arm64) Macs only.`);
    console.error(``);
    console.error(`To build a darwin-x64 binary manually:`);
    console.error(`  git clone https://github.com/proxai/proxai_gateway`);
    console.error(`  cd proxai_gateway && bun install && bun run build:darwin-x64`);
    process.exit(1);
  }

  const binDir = path.resolve(__dirname, 'bin');
  const target = path.join(binDir, `proxai-gateway${ext}`);

  if (fs.existsSync(target)) {
    return;
  }

  fs.mkdirSync(binDir, { recursive: true });

  const url = assetUrl(version, platform, arch, ext);
  const tmp = path.join(os.tmpdir(), `proxai-gateway-${process.pid}-${Date.now()}${ext || '.bin'}`);

  console.log(`@proxai/gateway: downloading ${url}`);
  try {
    await fetchToFile(url, tmp);
  } catch (err) {
    console.error(`@proxai/gateway: failed to download binary: ${err.message ?? err}`);
    console.error(manualInstructions(version, platform, arch, ext));
    try {
      fs.unlinkSync(tmp);
    } catch {}
    process.exit(1);
  }

  try {
    const stat = fs.statSync(tmp);
    if (stat.size <= 0) {
      throw new Error('downloaded file was empty');
    }
  } catch (err) {
    console.error(`@proxai/gateway: download verification failed: ${err.message ?? err}`);
    console.error(manualInstructions(version, platform, arch, ext));
    try {
      fs.unlinkSync(tmp);
    } catch {}
    process.exit(1);
  }

  try {
    fs.renameSync(tmp, target);
  } catch (err) {
    if (err && err.code === 'EXDEV') {
      fs.copyFileSync(tmp, target);
      try {
        fs.unlinkSync(tmp);
      } catch {}
    } else {
      console.error(`@proxai/gateway: failed to install binary: ${err.message ?? err}`);
      console.error(manualInstructions(version, platform, arch, ext));
      try {
        fs.unlinkSync(tmp);
      } catch {}
      process.exit(1);
    }
  }

  if (process.platform !== 'win32') {
    try {
      fs.chmodSync(target, 0o755);
    } catch (err) {
      console.error(`@proxai/gateway: failed to chmod ${target}: ${err.message ?? err}`);
      process.exit(1);
    }
  }

  console.log(`@proxai/gateway: installed binary to ${target}`);
}

main().catch((err) => {
  console.error(`@proxai/gateway: postinstall failed: ${err && err.message ? err.message : err}`);
  process.exit(1);
});
