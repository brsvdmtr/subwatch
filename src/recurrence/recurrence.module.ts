import { Module } from '@nestjs/common';
import { RecurrenceService } from './recurrence.service';

@Module({
  providers: [RecurrenceService],
  exports: [RecurrenceService]
})
export class RecurrenceModule {}
