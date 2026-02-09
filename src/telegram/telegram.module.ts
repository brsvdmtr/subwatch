import { Module } from '@nestjs/common';
import { RecurrenceModule } from '../recurrence/recurrence.module';
import { ReminderModule } from '../reminder/reminder.module';
import { TelegramService } from './telegram.service';

@Module({
  imports: [ReminderModule, RecurrenceModule],
  providers: [TelegramService],
  exports: [TelegramService]
})
export class TelegramModule {}
