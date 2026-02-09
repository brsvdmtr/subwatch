import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Job, Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';
import { ReminderProducerService } from '../queue/reminder-producer.service';
import { ReminderWorkerService } from '../queue/worker/reminder.worker';

interface ReminderJobData {
  reminderEventId: string;
}

const REMINDERS_QUEUE = 'reminders';

@Injectable()
export class SchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SchedulerService.name);
  private readonly pollIntervalMs = Number(process.env.REMINDER_POLL_INTERVAL_MS || 60_000);

  private queueRedis?: IORedis;
  private workerRedis?: IORedis;
  private queue?: Queue<ReminderJobData>;
  private worker?: Worker<ReminderJobData>;
  private pollTimer?: NodeJS.Timeout;

  constructor(
    private readonly reminderProducer: ReminderProducerService,
    private readonly reminderWorker: ReminderWorkerService
  ) {}

  async onModuleInit(): Promise<void> {
    const redisUrl = process.env.REDIS_URL;

    if (!redisUrl) {
      this.logger.warn('REDIS_URL is not set. Reminder queue is disabled.');
      return;
    }

    this.queueRedis = new IORedis(redisUrl, {
      maxRetriesPerRequest: null,
      enableReadyCheck: false
    });

    this.workerRedis = new IORedis(redisUrl, {
      maxRetriesPerRequest: null,
      enableReadyCheck: false
    });

    this.queue = new Queue<ReminderJobData>(REMINDERS_QUEUE, {
      connection: this.queueRedis,
      defaultJobOptions: {
        removeOnComplete: true,
        removeOnFail: false,
        attempts: 1
      }
    });

    this.worker = new Worker<ReminderJobData>(
      REMINDERS_QUEUE,
      async (job) => this.reminderWorker.handle(job.data.reminderEventId),
      {
        connection: this.workerRedis,
        concurrency: 5
      }
    );

    this.worker.on('completed', (job) => {
      this.logger.log(`Reminder job completed: ${job.id}`);
    });

    this.worker.on('failed', (job, error) => {
      this.logger.error(`Reminder job failed: ${job?.id} ${String(error)}`);
    });

    await this.enqueueDueReminderEvents();
    this.pollTimer = setInterval(() => {
      void this.enqueueDueReminderEvents();
    }, this.pollIntervalMs);

    this.logger.log(`Reminder queue initialized: ${REMINDERS_QUEUE}, poll every ${this.pollIntervalMs}ms`);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }

    if (this.worker) {
      await this.worker.close();
      this.worker = undefined;
    }

    if (this.queue) {
      await this.queue.close();
      this.queue = undefined;
    }

    if (this.workerRedis) {
      await this.workerRedis.quit();
      this.workerRedis = undefined;
    }

    if (this.queueRedis) {
      await this.queueRedis.quit();
      this.queueRedis = undefined;
    }
  }

  private async enqueueDueReminderEvents(): Promise<void> {
    if (!this.queue) {
      return;
    }

    const dueEventIds = await this.reminderProducer.getDueEventIds(100);
    if (!dueEventIds.length) {
      return;
    }

    let queued = 0;

    for (const reminderEventId of dueEventIds) {
      await this.queue.add(
        'send-reminder',
        { reminderEventId },
        {
          jobId: reminderEventId,
          removeOnComplete: true,
          removeOnFail: 1000
        }
      );
      queued += 1;
    }

    this.logger.log(`Reminder producer queued ${queued} event(s)`);
  }
}
