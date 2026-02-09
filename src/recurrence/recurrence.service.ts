import { Injectable } from '@nestjs/common';
import { RecurrenceType } from '@prisma/client';
import { DateTime } from 'luxon';

const DEFAULT_ZONE = 'Europe/Moscow';

@Injectable()
export class RecurrenceService {
  computeNextChargeAt(
    currentNextChargeAt: Date,
    recurrenceType: RecurrenceType,
    recurrenceJson: unknown,
    timezone = DEFAULT_ZONE
  ): Date {
    const currentLocal = DateTime.fromJSDate(currentNextChargeAt, { zone: timezone });

    if (!currentLocal.isValid) {
      throw new Error('Invalid currentNextChargeAt date');
    }

    switch (recurrenceType) {
      case RecurrenceType.MONTHLY_BY_DAY:
        return this.computeMonthly(currentLocal, recurrenceJson, timezone).toUTC().toJSDate();
      case RecurrenceType.EVERY_N_DAYS:
        return this.computeEveryNDays(currentLocal, recurrenceJson).toUTC().toJSDate();
      case RecurrenceType.YEARLY:
        return this.computeYearly(currentLocal, recurrenceJson, timezone).toUTC().toJSDate();
      default:
        return currentLocal.plus({ days: 30 }).toUTC().toJSDate();
    }
  }

  private computeMonthly(currentLocal: DateTime, recurrenceJson: unknown, timezone: string): DateTime {
    const parsed = this.parseMonthlyJson(recurrenceJson);
    const monthsToAdd = Math.max(1, parsed.everyNMonths);
    const base = currentLocal.plus({ months: monthsToAdd }).setZone(timezone);
    const lastDay = base.endOf('month').day;

    const day = parsed.day === 'LAST_DAY' ? lastDay : Math.min(Math.max(1, parsed.day), lastDay);

    return base.set({ day, second: 0, millisecond: 0 });
  }

  private computeEveryNDays(currentLocal: DateTime, recurrenceJson: unknown): DateTime {
    const intervalDays = this.parseIntervalDays(recurrenceJson);
    return currentLocal.plus({ days: intervalDays });
  }

  private computeYearly(currentLocal: DateTime, recurrenceJson: unknown, timezone: string): DateTime {
    const parsed = this.parseYearlyJson(recurrenceJson);
    const targetYear = currentLocal.year + 1;
    const base = DateTime.fromObject(
      {
        year: targetYear,
        month: parsed.month,
        day: 1,
        hour: currentLocal.hour,
        minute: currentLocal.minute,
        second: 0,
        millisecond: 0
      },
      { zone: timezone }
    );

    const lastDay = base.endOf('month').day;
    const day = parsed.day === 'LAST_DAY' ? lastDay : Math.min(Math.max(1, parsed.day), lastDay);

    return base.set({ day });
  }

  private parseMonthlyJson(input: unknown): { day: number | 'LAST_DAY'; everyNMonths: number } {
    const obj = this.asRecord(input);

    // Backward compatibility with early MVP format.
    if (obj.mode === 'LAST_DAY') {
      return { day: 'LAST_DAY', everyNMonths: 1 };
    }

    if (obj.mode === 'DAY_OF_MONTH') {
      const fallbackDay = this.toInt(obj.day, 1);
      return { day: fallbackDay, everyNMonths: 1 };
    }

    const dayRaw = obj.day;
    const day = dayRaw === 'LAST_DAY' ? 'LAST_DAY' : this.toInt(dayRaw, 1);
    const everyNMonths = this.toInt(obj.everyNMonths, 1);

    return {
      day,
      everyNMonths
    };
  }

  private parseYearlyJson(input: unknown): { month: number; day: number | 'LAST_DAY' } {
    const obj = this.asRecord(input);

    const month = this.clamp(this.toInt(obj.month, 1), 1, 12);
    const dayRaw = obj.day;
    const day = dayRaw === 'LAST_DAY' ? 'LAST_DAY' : this.toInt(dayRaw, 1);

    return { month, day };
  }

  private parseIntervalDays(input: unknown): number {
    const obj = this.asRecord(input);
    return this.clamp(this.toInt(obj.intervalDays, 30), 1, 365);
  }

  private asRecord(input: unknown): Record<string, unknown> {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      return {};
    }

    return input as Record<string, unknown>;
  }

  private toInt(value: unknown, fallback: number): number {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return Math.trunc(value);
    }

    if (typeof value === 'string' && value.trim() !== '') {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        return Math.trunc(parsed);
      }
    }

    return fallback;
  }

  private clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
  }
}
