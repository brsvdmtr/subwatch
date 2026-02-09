import { Module } from '@nestjs/common';
import { RecurrenceModule } from '../recurrence/recurrence.module';
import { ReminderModule } from '../reminder/reminder.module';
import { TelegramWebhookController } from './telegram-webhook.controller';
import { TelegramService } from './telegram.service';

@Module({
  imports: [ReminderModule, RecurrenceModule],
  controllers: [TelegramWebhookController],
  providers: [TelegramService],
  exports: [TelegramService]
})
export class TelegramModule {}
