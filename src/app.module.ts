import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { PrismaModule } from './prisma/prisma.module';
import { RecurrenceModule } from './recurrence/recurrence.module';
import { ReminderModule } from './reminder/reminder.module';
import { SchedulerModule } from './scheduler/scheduler.module';
import { TelegramModule } from './telegram/telegram.module';

@Module({
  imports: [TelegramModule, PrismaModule, SchedulerModule, ReminderModule, RecurrenceModule],
  controllers: [AppController]
})
export class AppModule {}
