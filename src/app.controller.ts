import { Controller, Get } from '@nestjs/common';
import { TelegramService } from './telegram/telegram.service';

@Controller('health')
export class AppController {
  constructor(private readonly telegram: TelegramService) {}

  @Get()
  health(): { status: string; telegramMode: string } {
    return { status: 'ok', telegramMode: this.telegram.getTelegramMode() };
  }
}
