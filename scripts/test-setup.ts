// Test preload (wired via bunfig.toml [test].preload). Pins CLI rendering to
// plain text so render-output assertions are deterministic regardless of where
// the suite runs. Color is a runtime/TTY concern — chalk emits ANSI in an
// interactive terminal and plain text when piped or in CI — which otherwise
// makes the same render function produce different bytes on different machines
// (substrings that span a styled boundary, like "5 files scanned", break only
// when colored). Forcing chalk.level = 0 removes that variable. NO_COLOR /
// FORCE_COLOR cover any non-chalk colorizers (ora, pino-pretty, supports-color)
// that read them at import time. The app itself is unaffected — it still colors
// normally in a real terminal; this only changes the test process.
import chalk from 'chalk';

process.env.NO_COLOR = '1';
process.env.FORCE_COLOR = '0';
chalk.level = 0;
