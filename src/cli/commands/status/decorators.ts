import chalk from 'chalk';

export type StatusHealth = 'healthy' | 'warning' | 'error' | 'inactive';

export function statusDot(health: StatusHealth): string {
  if (health === 'healthy') return chalk.green('●');
  if (health === 'warning') return chalk.yellow('●');
  if (health === 'error') return chalk.red('●');
  return chalk.dim('○');
}

export function sectionHeader(label: string): string {
  return `── ${chalk.bold(label)} ──`;
}
