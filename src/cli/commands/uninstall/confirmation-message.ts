import chalk from 'chalk';

import type { UninstallCommandDeps } from 'cli/commands/uninstall/uninstall.types.ts';

export function buildConfirmationMessage(_deps: UninstallCommandDeps, isDevMode: boolean): string {
  const lines: string[] = [];

  const terminalWidth = process.stdout.columns || 80;
  const innerWidth = Math.min(78, Math.max(40, terminalWidth - 4));

  function renderLine(content: string): string {
    const esc = String.fromCharCode(27);
    const cleanContent = content.replace(new RegExp(esc + '\\[[0-9;]*m', 'g'), '');
    const len = cleanContent.length;
    const spaces = Math.max(0, innerWidth - len);
    return chalk.bold.red('║') + content + ' '.repeat(spaces) + chalk.bold.red('║');
  }

  lines.push(chalk.bold.red('╔' + '═'.repeat(innerWidth) + '╗'));

  if (isDevMode) {
    lines.push(renderLine(' ' + chalk.bold('DEVELOPER TECHNICAL DETAILS')));
    lines.push(chalk.bold.red('╠' + '═'.repeat(innerWidth) + '╣'));
    lines.push(renderLine(' Technical comparison:'));
    lines.push(renderLine('  • Soft: Stops daemon processes and'));
    lines.push(renderLine('    removes binary and system integration'));
    lines.push(renderLine('    links (launchd/systemd unit files).'));
    lines.push(renderLine('  • Reset: Triggers filesystem wipe:'));
    lines.push(renderLine('    - rm -rf config & log directories'));
    lines.push(renderLine('    - rm lock, flat/nested markers'));
    lines.push(renderLine('    - rm DEV_MODE boot sentinel'));
  } else {
    lines.push(renderLine(' ' + chalk.bold('IMPORTANT NOTICE')));
    lines.push(chalk.bold.red('╠' + '═'.repeat(innerWidth) + '╣'));
    lines.push(renderLine(' ' + chalk.bold.red('WARNING: --reset is NOT recommended!')));
    lines.push(renderLine(''));
    lines.push(renderLine(' This reset is extremely destructive. All'));
    lines.push(renderLine(' local credentials, configurations, and'));
    lines.push(renderLine(' captured pending data will be permanently'));
    lines.push(renderLine(' deleted from this machine.'));
    lines.push(renderLine(''));
    lines.push(renderLine(' ' + chalk.bold.green('RECOMMENDED ALTERNATIVE:')));
    lines.push(renderLine(' A standard soft uninstall is safe and'));
    lines.push(renderLine(' highly recommended. It decommissions the'));
    lines.push(renderLine(' service and binary but preserves your'));
    lines.push(renderLine(' configurations and pending uploads so'));
    lines.push(renderLine(' you do not lose any data.'));
  }

  lines.push(chalk.bold.red('╠' + '═'.repeat(innerWidth) + '╣'));
  lines.push(renderLine(' Please type "uninstall --reset" to confirm'));
  lines.push(renderLine(' this reset, or press Enter to abort.'));

  lines.push(chalk.bold.red('╚' + '═'.repeat(innerWidth) + '╝'));
  lines.push('');

  return lines.join('\n');
}
