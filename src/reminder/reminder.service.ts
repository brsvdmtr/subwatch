import { Injectable, Logger } from '@nestjs/common';
import { Prisma, ReminderEventStatus, ReminderType } from '@prisma/client';
import { DateTime } from 'luxon';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class ReminderService {
  private readonly logger = new Logger(ReminderService.name);

  constructor(private readonly prisma: PrismaService) {}

  async generateEventsForNextCharge(subscriptionId: string): Promise<void> {
    const subscription = await this.prisma.subscription.findUnique({
      where: { id: subscriptionId },
      select: {
        id: true,
        nextChargeAt: true,
        space: {
          select: {
            timezone: true,
            reminderRules: {
              where: { enabled: true },
              select: {
                type: true,
                offsetMinutes: true,
                dayOfTime: true
              }
            }
          }
        }
      }
    });

    if (!subscription) {
      this.logger.warn(`Subscription not found for reminders: ${subscriptionId}`);
      return;
    }

    const timezone = subscription.space.timezone || 'Europe/Moscow';
    const nextLocal = DateTime.fromJSDate(subscription.nextChargeAt, { zone: timezone });

    for (const rule of subscription.space.reminderRules) {
      const plannedAt = this.computePlannedAt(nextLocal, rule.type, rule.offsetMinutes, rule.dayOfTime, timezone);
      if (!plannedAt) {
        continue;
      }

      // Если событие уже в прошлом, сохраняем его как SKIPPED (а не PLANNED),
      // чтобы не отправлять просроченное уведомление и сохранить факт генерации.
      const status = plannedAt.toMillis() <= Date.now() ? ReminderEventStatus.SKIPPED : ReminderEventStatus.PLANNED;

      await this.createReminderEventSafe({
        subscriptionId: subscription.id,
        type: rule.type,
        plannedAt: plannedAt.toUTC().toJSDate(),
        status
      });
    }
  }

  async deletePlannedEvents(subscriptionId: string): Promise<number> {
    const result = await this.prisma.reminderEvent.deleteMany({
      where: {
        subscriptionId,
        status: ReminderEventStatus.PLANNED
      }
    });

    return result.count;
  }

  private computePlannedAt(
    nextLocal: DateTime,
    type: ReminderType,
    offsetMinutes: number,
    dayOfTime: string | null,
    timezone: string
  ): DateTime | null {
    if (type === ReminderType.BEFORE) {
      return nextLocal.minus({ minutes: Math.max(0, offsetMinutes) }).setZone(timezone);
    }

    const timeString = dayOfTime && /^\d{2}:\d{2}$/.test(dayOfTime) ? dayOfTime : '09:00';
    const [hourStr, minuteStr] = timeString.split(':');
    const hour = Number(hourStr);
    const minute = Number(minuteStr);

    if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
      return null;
    }

    return nextLocal.set({ hour, minute, second: 0, millisecond: 0 }).setZone(timezone);
  }

  private async createReminderEventSafe(data: {
    subscriptionId: string;
    plannedAt: Date;
    type: ReminderType;
    status: ReminderEventStatus;
  }): Promise<void> {
    try {
      await this.prisma.reminderEvent.create({ data });
    } catch (error) {
      if (this.isPrismaUniqueViolation(error)) {
        return;
      }
      throw error;
    }
  }

  private isPrismaUniqueViolation(error: unknown): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: string }).code === 'P2002'
    );
  }
}
