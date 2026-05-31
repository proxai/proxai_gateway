export interface RelativeTimeOptions {
  now?: Date;
  locale?: string;
  timeZone?: string;
}

const MS_PER_SECOND = 1000;
const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;

const MONTH_SHORT = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

export function formatLocalTimestamp(iso: string, options: RelativeTimeOptions = {}): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  const formatter = new Intl.DateTimeFormat(options.locale ?? 'en-US', {
    timeZone: options.timeZone,
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = formatter.formatToParts(new Date(ms));
  const lookup: Record<string, string> = {};
  for (const p of parts) lookup[p.type] = p.value;
  const day = lookup['day'] ?? '';
  const month = lookup['month'] ?? '';
  const hour = lookup['hour'] ?? '';
  const minute = lookup['minute'] ?? '';
  const second = lookup['second'] ?? '';
  const monthKnown = MONTH_SHORT.includes(month) ? month : monthFromIso(ms);
  return `${day} ${monthKnown} ${hour}:${minute}:${second}`;
}

function monthFromIso(ms: number): string {
  const d = new Date(ms);
  return MONTH_SHORT[d.getUTCMonth()] ?? '';
}

export function formatRelative(iso: string, options: RelativeTimeOptions = {}): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  const nowMs = (options.now ?? new Date()).getTime();
  const diff = nowMs - ms;
  if (diff < 0) {
    return formatRelativePositive(-diff, true);
  }
  return formatRelativePositive(diff, false);
}

function formatRelativePositive(diff: number, future: boolean): string {
  const suffix = future ? 'from now' : 'ago';
  if (diff < MS_PER_MINUTE) {
    const s = Math.max(1, Math.floor(diff / MS_PER_SECOND));
    return `${s.toString()}s ${suffix}`;
  }
  if (diff < MS_PER_HOUR) {
    const m = Math.floor(diff / MS_PER_MINUTE);
    return `${m.toString()} min ${suffix}`;
  }
  if (diff < MS_PER_DAY) {
    const h = Math.floor(diff / MS_PER_HOUR);
    return `${h.toString()} h ${suffix}`;
  }
  const d = Math.floor(diff / MS_PER_DAY);
  return `${d.toString()} d ${suffix}`;
}

export function formatTimeWithRelative(iso: string, options: RelativeTimeOptions = {}): string {
  const ts = formatLocalTimestamp(iso, options);
  const rel = formatRelative(iso, options);
  return rel.length > 0 ? `${ts} (${rel})` : ts;
}

export function toLocalIsoString(
  date: Date,
  offsetMinutes: number = -date.getTimezoneOffset(),
): string {
  const shifted = new Date(date.getTime() + offsetMinutes * MS_PER_MINUTE);
  const pad = (n: number, width = 2): string => n.toString().padStart(width, '0');
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const absOffset = Math.abs(offsetMinutes);
  const offHours = pad(Math.trunc(absOffset / 60));
  const offMinutes = pad(absOffset % 60);
  return (
    `${shifted.getUTCFullYear().toString()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}` +
    `T${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:${pad(shifted.getUTCSeconds())}` +
    `.${pad(shifted.getUTCMilliseconds(), 3)}${sign}${offHours}:${offMinutes}`
  );
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0 B';
  if (n < 1024) return `${n.toString()} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = n / 1024;
  let unitIdx = 0;
  while (value >= 1024 && unitIdx < units.length - 1) {
    value /= 1024;
    unitIdx++;
  }
  const rounded = value < 10 ? value.toFixed(2) : value < 100 ? value.toFixed(1) : value.toFixed(0);
  return `${rounded} ${units[unitIdx] ?? 'B'}`;
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0 ms';
  if (ms < 1000) return `${Math.round(ms).toString()} ms`;
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec.toString()} s`;
  const totalMin = Math.floor(totalSec / 60);
  if (totalMin < 60) return `${totalMin.toString()} min`;
  const hours = Math.floor(totalMin / 60);
  const minutes = totalMin % 60;
  if (hours < 24) return `${hours.toString()}h ${minutes.toString()}m`;
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return `${days.toString()}d ${remHours.toString()}h`;
}

export function formatPercent(value: number, total: number): string {
  if (!Number.isFinite(value) || !Number.isFinite(total) || total <= 0) return '0%';
  const pct = (value / total) * 100;
  if (pct < 1 && pct > 0) return '<1%';
  return `${Math.round(pct).toString()}%`;
}
