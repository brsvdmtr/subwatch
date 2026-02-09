import { Controller, Get } from '@nestjs/common';

@Controller('health')
export class AppController {
  @Get()
  health(): { status: string } {
    return { status: 'ok' };
  }
}
