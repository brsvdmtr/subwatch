import { Module } from '@nestjs/common';
import { RecurrenceModule } from '../recurrence/recurrence.module';
import { ReminderModule } from '../reminder/reminder.module';
import { TelegramModule } from '../telegram/telegram.module';
import { ReminderProducerService } from '../queue/reminder-producer.service';
import { ReminderWorkerService } from '../queue/worker/reminder.worker';
import { SchedulerService } from './scheduler.service';

@Module({
  imports: [ReminderModule, RecurrenceModule, TelegramModule],
  providers: [SchedulerService, ReminderProducerService, ReminderWorkerService]
})
export class SchedulerModule {}
