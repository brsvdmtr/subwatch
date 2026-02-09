import { Controller, Get } from '@nestjs/common';
import { TelegramService } from './telegram/telegram.service';

@Controller('health')
export class AppController {
  constructor(private readonly telegram: TelegramService) {}

  @Get()
  health(): { status: string; telegramMode: string; gitSha: string } {
    const gitSha = process.env.GIT_SHA?.trim() || 'unknown';
    return { status: 'ok', telegramMode: this.telegram.getTelegramMode(), gitSha };
  }
}
