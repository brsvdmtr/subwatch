import { Injectable } from '@nestjs/common';
import { ReminderEventStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class ReminderProducerService {
  constructor(private readonly prisma: PrismaService) {}

  async getDueEventIds(limit = 100): Promise<string[]> {
    const dueEvents = await this.prisma.reminderEvent.findMany({
      where: {
        status: ReminderEventStatus.PLANNED,
        plannedAt: { lte: new Date() }
      },
      orderBy: { plannedAt: 'asc' },
      take: limit,
      select: { id: true }
    });

    return dueEvents.map((event) => event.id);
  }
}
