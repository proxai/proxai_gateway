import chalk from 'chalk';

const PINO_LEVEL_LABEL: Record<number, string> = {
  10: 'TRACE',
  20: 'DEBUG',
  30: 'INFO',
  40: 'WARN',
  50: 'ERROR',
  60: 'FATAL',
};

const RESERVED_KEYS = new Set([
  'level',
  'time',
  'msg',
  'source_app',
  'event',
  'pid',
  'hostname',
  'service',
  'version',
  'host_id',
]);

export function formatLine(line: string): string {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return line;
  }
  const time = typeof parsed['time'] === 'number' ? parsed['time'] : Date.now();
  const level = typeof parsed['level'] === 'number' ? parsed['level'] : 30;
  const msg = typeof parsed['msg'] === 'string' ? parsed['msg'] : '';
  const sourceApp = typeof parsed['source_app'] === 'string' ? parsed['source_app'] : null;
  const event = typeof parsed['event'] === 'string' ? parsed['event'] : null;

  const timeStr = formatLocalTime(time);
  const levelLabel = PINO_LEVEL_LABEL[level] ?? String(level);
  const levelColored = colorLevel(level, levelLabel.padEnd(5));
  const sourceTag = sourceApp !== null ? chalk.cyan(`[${sourceApp}] `) : '';
  const eventTag = event !== null ? `${chalk.dim(event.padEnd(24))} ` : '';

  const extras = formatExtras(parsed);
  return `${chalk.gray(timeStr)}  ${levelColored}  ${sourceTag}${eventTag}${msg}${extras}`;
}

function formatLocalTime(timeMs: number): string {
  const d = new Date(timeMs);
  const hh = d.getHours().toString().padStart(2, '0');
  const mm = d.getMinutes().toString().padStart(2, '0');
  const ss = d.getSeconds().toString().padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

function colorLevel(level: number, label: string): string {
  if (level >= 60) return chalk.bgRed.white(label);
  if (level >= 50) return chalk.red(label);
  if (level >= 40) return chalk.yellow(label);
  if (level >= 30) return chalk.green(label);
  if (level >= 20) return chalk.blue(label);
  return chalk.gray(label);
}

function formatExtras(parsed: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(parsed)) {
    if (RESERVED_KEYS.has(key)) continue;
    if (value === null || value === undefined) continue;
    const formatted = typeof value === 'string' ? value : JSON.stringify(value);
    parts.push(`${chalk.dim(key)}=${formatted}`);
  }
  if (parts.length === 0) return '';
  return ` ${parts.join(' ')}`;
}
