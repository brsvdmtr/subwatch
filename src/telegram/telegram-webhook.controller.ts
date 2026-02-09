import { Body, Controller, Headers, HttpCode, Post, UnauthorizedException } from '@nestjs/common';
import { TelegramService } from './telegram.service';

function normalizeWebhookPath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) {
    return 'telegram/webhook';
  }

  return trimmed.replace(/^\/+/, '');
}

const WEBHOOK_PATH = normalizeWebhookPath(process.env.TELEGRAM_WEBHOOK_PATH ?? '/telegram/webhook');

@Controller()
export class TelegramWebhookController {
  constructor(private readonly telegram: TelegramService) {}

  @Post(WEBHOOK_PATH)
  @HttpCode(200)
  handleWebhook(
    @Body() update: unknown,
    @Headers('x-telegram-bot-api-secret-token') secretTokenHeader?: string
  ): { ok: true } {
    const expectedSecret = process.env.TELEGRAM_SECRET_TOKEN;

    if (expectedSecret && expectedSecret.length > 0 && secretTokenHeader !== expectedSecret) {
      throw new UnauthorizedException('Invalid Telegram secret token');
    }

    void this.telegram.handleUpdate(update);
    return { ok: true };
  }
}

