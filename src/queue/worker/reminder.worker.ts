import { Injectable, Logger } from '@nestjs/common';
import { Prisma, RecurrenceType, ReminderEventStatus, ReminderType, SubscriptionStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { RecurrenceService } from '../../recurrence/recurrence.service';
import { ReminderService } from '../../reminder/reminder.service';
import { TelegramService } from '../../telegram/telegram.service';
import { formatDate } from '../../telegram/utils';

@Injectable()
export class ReminderWorkerService {
  private readonly logger = new Logger(ReminderWorkerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly telegramService: TelegramService,
    private readonly reminderService: ReminderService,
    private readonly recurrenceService: RecurrenceService
  ) {}

  async handle(reminderEventId: string): Promise<void> {
    const event = await this.prisma.reminderEvent.findUnique({
      where: { id: reminderEventId },
      select: {
        id: true,
        status: true,
        type: true,
        subscription: {
          select: {
            id: true,
            title: true,
            amountCents: true,
            currency: true,
            status: true,
            nextChargeAt: true,
            recurrenceType: true,
            recurrenceJson: true,
            space: {
              select: {
                timezone: true,
                owner: {
                  select: {
                    telegramId: true
                  }
                }
              }
            }
          }
        }
      }
    });

    if (!event) {
      this.logger.warn(`Reminder event not found: ${reminderEventId}`);
      return;
    }

    if (event.status !== ReminderEventStatus.PLANNED) {
      return;
    }

    const timezone = event.subscription.space.timezone || 'Europe/Moscow';
    const text = `Скоро списание: ${event.subscription.title} — ${this.formatMoney(event.subscription.amountCents, event.subscription.currency)}\nДата: ${formatDate(event.subscription.nextChargeAt, timezone)}`;

    try {
      await this.telegramService.sendMessage(event.subscription.space.owner.telegramId, text, {
        reply_markup: this.telegramService.buildReminderInlineKeyboard(event.subscription.id)
      });

      await this.prisma.reminderEvent.update({
        where: { id: event.id },
        data: {
          status: ReminderEventStatus.SENT,
          sentAt: new Date(),
          error: null
        }
      });

      this.logger.log(`Reminder sent: event=${event.id} type=${event.type}`);

      if (event.type === ReminderType.DAY_OF && event.subscription.status === SubscriptionStatus.ACTIVE) {
        await this.afterDayOfSent(
          event.subscription.id,
          event.subscription.nextChargeAt,
          event.subscription.recurrenceType,
          event.subscription.recurrenceJson,
          timezone
        );
      }
    } catch (error) {
      const errorText = this.serializeError(error);

      await this.prisma.reminderEvent.update({
        where: { id: event.id },
        data: {
          status: ReminderEventStatus.FAILED,
          error: errorText
        }
      });

      this.logger.error(`Reminder failed: event=${event.id} error=${errorText}`);
      throw error;
    }
  }

  private async afterDayOfSent(
    subscriptionId: string,
    currentNextChargeAt: Date,
    recurrenceType: RecurrenceType,
    recurrenceJson: Prisma.JsonValue,
    timezone: string
  ): Promise<void> {
    const newNextChargeAt = this.recurrenceService.computeNextChargeAt(
      currentNextChargeAt,
      recurrenceType,
      recurrenceJson,
      timezone
    );

    await this.prisma.subscription.update({
      where: { id: subscriptionId },
      data: { nextChargeAt: newNextChargeAt }
    });

    await this.reminderService.deletePlannedEvents(subscriptionId);
    await this.reminderService.generateEventsForNextCharge(subscriptionId);

    this.logger.log(`DAY_OF rollover done for subscription=${subscriptionId}`);
  }

  private formatMoney(amountCents: number, currency: string): string {
    return `${(amountCents / 100).toFixed(2)} ${currency}`;
  }

  private serializeError(error: unknown): string {
    if (error instanceof Error) {
      return `${error.name}: ${error.message}`;
    }

    return String(error);
  }
}
