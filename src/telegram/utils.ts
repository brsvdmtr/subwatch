const MOSCOW_OFFSET_MINUTES = 180;

export function parseMoneyToCents(input: string): number | null {
  const normalized = input.trim().replace(',', '.');
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) {
    return null;
  }

  const amount = Number(normalized);
  if (!Number.isFinite(amount) || amount < 0) {
    return null;
  }

  return Math.round(amount * 100);
}

export function parseDateDDMMYYYY(input: string, timezone: string): Date | null {
  const match = input.trim().match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (!match) {
    return null;
  }

  const day = Number(match[1]);
  const month = Number(match[2]);
  const year = Number(match[3]);

  const base = new Date(Date.UTC(year, month - 1, day));
  if (
    base.getUTCFullYear() !== year ||
    base.getUTCMonth() !== month - 1 ||
    base.getUTCDate() !== day
  ) {
    return null;
  }

  const offsetMinutes = timezone === 'Europe/Moscow' ? MOSCOW_OFFSET_MINUTES : 0;
  const utcMs = Date.UTC(year, month - 1, day, 0, 0, 0) - offsetMinutes * 60 * 1000;
  return new Date(utcMs);
}

export function formatDate(date: Date, timezone: string): string {
  const formatter = new Intl.DateTimeFormat('ru-RU', {
    timeZone: timezone || 'Europe/Moscow',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric'
  });

  return formatter.format(date);
}
