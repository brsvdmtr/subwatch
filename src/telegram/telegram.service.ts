import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import {
  Prisma,
  RecurrenceType,
  ReminderType,
  SpaceMemberRole,
  SpaceType,
  SubscriptionStatus
} from '@prisma/client';
import { DateTime } from 'luxon';
import { Markup, Scenes, Telegraf, session } from 'telegraf';
import { RecurrenceService } from '../recurrence/recurrence.service';
import { ReminderService } from '../reminder/reminder.service';
import { PrismaService } from '../prisma/prisma.service';
import { formatDate, parseDateDDMMYYYY, parseMoneyToCents } from './utils';
import { AddSubscriptionDraft, BotContext } from './telegram.types';

const ADD_SUBSCRIPTION_SCENE_ID = 'add-subscription';
const CATEGORY_OPTIONS = ['Связь', 'Дом', 'Развлечения', 'Работа', 'Другое'] as const;

const STEP_MONTHLY_DAY = 5;
const STEP_N_DAYS = 6;
const STEP_YEARLY_DAY_MONTH = 7;
const STEP_CATEGORY = 8;

const MAIN_MENU_KEYBOARD = Markup.keyboard([
  ['➕ Добавить подписку'],
  ['📅 Ближайшие'],
  ['📚 Все'],
  ['⚙️ Настройки']
])
  .resize()
  .oneTime(false);

const RECURRENCE_KEYBOARD = Markup.keyboard([
  ['Каждый месяц'],
  ['Каждые N дней'],
  ['Раз в год']
])
  .resize()
  .oneTime(true);

const CATEGORY_KEYBOARD = Markup.keyboard([
  ['Связь', 'Дом'],
  ['Развлечения', 'Работа'],
  ['Другое']
])
  .resize()
  .oneTime(true);

const AFTER_SAVE_KEYBOARD = Markup.keyboard([['📚 Все', '📅 Ближайшие'], ['➕ Добавить еще']])
  .resize()
  .oneTime(false);

interface ReadySubscriptionDraft {
  title: string;
  amountCents: number;
  nextChargeAt: Date;
  recurrenceType: RecurrenceType;
  recurrenceJson: Record<string, unknown>;
  category: string;
}

type SendMessageExtra = Parameters<Telegraf<BotContext>['telegram']['sendMessage']>[2];
type TelegramMode = 'polling' | 'webhook';

@Injectable()
export class TelegramService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TelegramService.name);
  private readonly reconnectDelayMs = 5000;
  private readonly pendingEditDateByTelegramId = new Map<number, string>();

  private bot?: Telegraf<BotContext>;
  private token?: string;
  private telegramMode: TelegramMode = 'polling';
  private launchTimer?: NodeJS.Timeout;
  private isLaunching = false;
  private isStopping = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly reminderService: ReminderService,
    private readonly recurrenceService: RecurrenceService
  ) {}

  getTelegramMode(): TelegramMode {
    return this.telegramMode;
  }

  async onModuleInit(): Promise<void> {
    this.telegramMode = this.resolveTelegramMode();
    this.logger.log(`Telegram mode: ${this.telegramMode}`);

    const token = process.env.BOT_TOKEN;

    if (!token) {
      this.logger.warn('BOT_TOKEN is not set. Telegram bot will stay disabled.');
      return;
    }

    this.token = token;

    if (this.telegramMode === 'webhook') {
      await this.startWebhookMode();
    } else {
      this.scheduleLaunch(0);
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.isStopping = true;

    if (this.launchTimer) {
      clearTimeout(this.launchTimer);
      this.launchTimer = undefined;
    }

    if (this.bot) {
      try {
        this.bot.stop('SIGTERM');
      } catch (error) {
        this.logger.warn(`Failed to stop Telegram bot gracefully: ${String(error)}`);
      }
      this.bot = undefined;
    }
  }

  async sendMessage(telegramId: string | number | bigint, text: string, extra?: SendMessageExtra): Promise<void> {
    if (!this.bot) {
      throw new Error('Telegram bot is not initialized');
    }

    const chatId = typeof telegramId === 'bigint' ? telegramId.toString() : telegramId;
    await this.bot.telegram.sendMessage(chatId as string | number, text, extra);
  }

  async handleUpdate(update: unknown): Promise<void> {
    if (!this.bot) {
      this.logger.warn('Telegram update received but bot is not initialized yet');
      return;
    }

    try {
      await this.bot.handleUpdate(update as never);
    } catch (error) {
      this.logger.error(`Failed to handle Telegram update: ${String(error)}`);
    }
  }

  buildReminderInlineKeyboard(subscriptionId: string): NonNullable<SendMessageExtra>['reply_markup'] {
    return Markup.inlineKeyboard([
      [Markup.button.callback('⏸ Пауза', `pause:${subscriptionId}`)],
      [Markup.button.callback('✏️ Изменить дату', `editdate:${subscriptionId}`)],
      [Markup.button.callback('✅ Отметить списалось', `paid:${subscriptionId}`)]
    ]).reply_markup;
  }

  private registerHandlers(bot: Telegraf<BotContext>): void {
    const stage = new Scenes.Stage<BotContext>([this.createAddSubscriptionWizard()]);

    bot.use(session());
    bot.use(async (ctx, next) => this.attachContextState(ctx, next));
    bot.use(stage.middleware());

    bot.use(async (ctx, next) => {
      const text = this.getMessageText(ctx);
      if (text && text.startsWith('/')) {
        this.logger.log(`Command received: ${text}`);
      }
      await next();
    });

    bot.catch((error) => {
      this.logger.error(`Telegraf handler error: ${String(error)}`);
    });

    bot.start(async (ctx) => {
      await this.handleStart(ctx);
    });

    bot.command('ping', async (ctx) => {
      await ctx.reply('pong', MAIN_MENU_KEYBOARD);
    });

    bot.action(/^pause:(.+)$/, async (ctx) => {
      const subscriptionId = ctx.match[1];
      await this.handlePauseAction(ctx, subscriptionId);
    });

    bot.action(/^editdate:(.+)$/, async (ctx) => {
      const subscriptionId = ctx.match[1];
      await this.handleEditDateAction(ctx, subscriptionId);
    });

    bot.action(/^paid:(.+)$/, async (ctx) => {
      const subscriptionId = ctx.match[1];
      await this.handlePaidAction(ctx, subscriptionId);
    });

    bot.on('text', async (ctx, next) => {
      if (ctx.scene.current) {
        await next();
        return;
      }

      if (!(await this.handlePendingEditDateInput(ctx))) {
        await next();
      }
    });

    bot.hears('➕ Добавить подписку', async (ctx) => {
      if (!(await this.ensureUserContext(ctx))) {
        return;
      }
      await ctx.scene.enter(ADD_SUBSCRIPTION_SCENE_ID);
    });

    bot.hears('➕ Добавить еще', async (ctx) => {
      if (!(await this.ensureUserContext(ctx))) {
        return;
      }
      await ctx.scene.enter(ADD_SUBSCRIPTION_SCENE_ID);
    });

    bot.hears('📚 Все', async (ctx) => {
      await this.handleAllSubscriptions(ctx);
    });

    bot.hears('📅 Ближайшие', async (ctx) => {
      await this.handleUpcomingSubscriptions(ctx);
    });

    bot.hears('⚙️ Настройки', async (ctx) => {
      await ctx.reply('Настройки добавим на следующем шаге.', MAIN_MENU_KEYBOARD);
    });
  }

  private async attachContextState(ctx: BotContext, next: () => Promise<void>): Promise<void> {
    ctx.state ??= {};

    if (!ctx.from) {
      await next();
      return;
    }

    try {
      const user = await this.prisma.user.findUnique({
        where: { telegramId: BigInt(ctx.from.id) },
        select: {
          id: true,
          ownedSpaces: {
            where: { type: SpaceType.PERSONAL },
            select: { id: true, timezone: true },
            orderBy: { createdAt: 'asc' },
            take: 1
          },
          memberships: {
            where: { space: { type: SpaceType.PERSONAL } },
            select: { space: { select: { id: true, timezone: true } } },
            orderBy: { createdAt: 'asc' },
            take: 1
          }
        }
      });

      if (user) {
        ctx.state.userId = user.id;
        const personalSpace = user.ownedSpaces[0] ?? user.memberships[0]?.space;
        if (personalSpace) {
          ctx.state.spaceId = personalSpace.id;
          ctx.state.timezone = personalSpace.timezone;
        }
      }
    } catch (error) {
      this.logger.error(`Failed to attach ctx.state user/space: ${String(error)}`);
    }

    await next();
  }

  private async handleStart(ctx: BotContext): Promise<void> {
    if (!ctx.from) {
      return;
    }

    const user = await this.prisma.user.upsert({
      where: { telegramId: BigInt(ctx.from.id) },
      update: {
        firstName: ctx.from.first_name ?? null,
        lastName: ctx.from.last_name ?? null,
        username: ctx.from.username ?? null
      },
      create: {
        telegramId: BigInt(ctx.from.id),
        firstName: ctx.from.first_name ?? null,
        lastName: ctx.from.last_name ?? null,
        username: ctx.from.username ?? null
      }
    });

    let personalSpace = await this.prisma.space.findFirst({
      where: {
        ownerId: user.id,
        type: SpaceType.PERSONAL
      },
      select: {
        id: true,
        timezone: true
      }
    });

    if (!personalSpace) {
      const displayName = user.firstName?.trim() || 'Личное';
      personalSpace = await this.prisma.space.create({
        data: {
          ownerId: user.id,
          type: SpaceType.PERSONAL,
          title: `${displayName} пространство`
        },
        select: {
          id: true,
          timezone: true
        }
      });
    }

    await this.prisma.spaceMember.upsert({
      where: {
        spaceId_userId: {
          spaceId: personalSpace.id,
          userId: user.id
        }
      },
      update: {
        role: SpaceMemberRole.OWNER
      },
      create: {
        spaceId: personalSpace.id,
        userId: user.id,
        role: SpaceMemberRole.OWNER
      }
    });

    await this.ensureDefaultReminderRules(personalSpace.id);

    ctx.state.userId = user.id;
    ctx.state.spaceId = personalSpace.id;
    ctx.state.timezone = personalSpace.timezone;

    await ctx.reply(
      'Привет! Я SubWatch. Помогу учитывать подписки и напоминать о платежах.',
      MAIN_MENU_KEYBOARD
    );
  }

  private createAddSubscriptionWizard(): Scenes.WizardScene<BotContext> {
    return new Scenes.WizardScene<BotContext>(
      ADD_SUBSCRIPTION_SCENE_ID,
      async (ctx) => {
        if (!(await this.ensureUserContext(ctx))) {
          await ctx.scene.leave();
          return;
        }

        this.resetWizardDraft(ctx);
        await ctx.reply('Введите название подписки:', Markup.removeKeyboard());
        ctx.wizard.next();
      },
      async (ctx) => {
        const title = this.getMessageText(ctx);
        if (!title) {
          await ctx.reply('Название должно быть текстом. Попробуйте ещё раз.');
          return;
        }

        this.setWizardDraft(ctx, { title });

        await ctx.reply('Введите сумму в рублях. Формат: 499 или 499.90');
        ctx.wizard.next();
      },
      async (ctx) => {
        const amountInput = this.getMessageText(ctx);
        if (!amountInput) {
          await ctx.reply('Введите сумму текстом. Пример: 499 или 499.90');
          return;
        }

        const amountCents = parseMoneyToCents(amountInput);
        if (amountCents === null || amountCents < 0) {
          await ctx.reply('Некорректная сумма. Используйте формат 499 или 499.90 (не меньше 0).');
          return;
        }

        this.setWizardDraft(ctx, { amountCents });

        await ctx.reply('Введите дату следующего списания в формате DD.MM.YYYY');
        ctx.wizard.next();
      },
      async (ctx) => {
        const dateInput = this.getMessageText(ctx);
        const timezone = ctx.state.timezone || 'Europe/Moscow';

        if (!dateInput) {
          await ctx.reply('Введите дату в формате DD.MM.YYYY');
          return;
        }

        const nextChargeAt = parseDateDDMMYYYY(dateInput, timezone);
        if (!nextChargeAt) {
          await ctx.reply('Некорректная дата. Используйте строгий формат DD.MM.YYYY, например 25.12.2026');
          return;
        }

        this.setWizardDraft(ctx, { nextChargeAt });

        await ctx.reply('Выберите периодичность:', RECURRENCE_KEYBOARD);
        ctx.wizard.next();
      },
      async (ctx) => {
        const recurrenceChoice = this.getMessageText(ctx);
        if (!recurrenceChoice) {
          await ctx.reply('Выберите периодичность кнопкой ниже.', RECURRENCE_KEYBOARD);
          return;
        }

        if (recurrenceChoice === 'Каждый месяц') {
          this.setWizardDraft(ctx, { recurrenceType: RecurrenceType.MONTHLY_BY_DAY });
          await ctx.reply('Введите день месяца (1-31) или "последний день":', Markup.removeKeyboard());
          ctx.wizard.selectStep(STEP_MONTHLY_DAY);
          return;
        }

        if (recurrenceChoice === 'Каждые N дней') {
          this.setWizardDraft(ctx, { recurrenceType: RecurrenceType.EVERY_N_DAYS });
          await ctx.reply('Введите N (от 1 до 365):', Markup.removeKeyboard());
          ctx.wizard.selectStep(STEP_N_DAYS);
          return;
        }

        if (recurrenceChoice === 'Раз в год') {
          this.setWizardDraft(ctx, { recurrenceType: RecurrenceType.YEARLY });
          await ctx.reply('Введите дату ежегодного повтора в формате DD.MM (например 15.09):', Markup.removeKeyboard());
          ctx.wizard.selectStep(STEP_YEARLY_DAY_MONTH);
          return;
        }

        await ctx.reply('Нужно выбрать один из вариантов: Каждый месяц / Каждые N дней / Раз в год', RECURRENCE_KEYBOARD);
      },
      async (ctx) => {
        const monthlyInput = this.getMessageText(ctx);
        if (!monthlyInput) {
          await ctx.reply('Введите день месяца (1-31) или "последний день".');
          return;
        }

        const normalized = monthlyInput.trim().toLowerCase();
        let recurrenceJson: Record<string, unknown> | null = null;

        if (normalized === 'последний день') {
          recurrenceJson = { day: 'LAST_DAY', everyNMonths: 1 };
        } else {
          const day = Number(normalized);
          if (Number.isInteger(day) && day >= 1 && day <= 31) {
            recurrenceJson = { day, everyNMonths: 1 };
          }
        }

        if (!recurrenceJson) {
          await ctx.reply('Некорректно. Введите число от 1 до 31 или фразу "последний день".');
          return;
        }

        this.setWizardDraft(ctx, { recurrenceJson });

        await this.askCategory(ctx);
        ctx.wizard.selectStep(STEP_CATEGORY);
      },
      async (ctx) => {
        const nDaysInput = this.getMessageText(ctx);
        if (!nDaysInput) {
          await ctx.reply('Введите число N (от 1 до 365).');
          return;
        }

        const nDays = Number(nDaysInput.trim());
        if (!Number.isInteger(nDays) || nDays < 1 || nDays > 365) {
          await ctx.reply('Некорректно. N должен быть целым числом от 1 до 365.');
          return;
        }

        this.setWizardDraft(ctx, { recurrenceJson: { intervalDays: nDays } });

        await this.askCategory(ctx);
        ctx.wizard.selectStep(STEP_CATEGORY);
      },
      async (ctx) => {
        const yearlyInput = this.getMessageText(ctx);
        if (!yearlyInput) {
          await ctx.reply('Введите дату в формате DD.MM, например 15.09');
          return;
        }

        const parsed = this.parseDayMonth(yearlyInput);
        if (!parsed) {
          await ctx.reply('Некорректный формат. Используйте DD.MM, например 15.09');
          return;
        }

        this.setWizardDraft(ctx, { recurrenceJson: parsed });

        await this.askCategory(ctx);
        ctx.wizard.selectStep(STEP_CATEGORY);
      },
      async (ctx) => {
        const categoryInput = this.getMessageText(ctx);
        if (!categoryInput || !CATEGORY_OPTIONS.includes(categoryInput as (typeof CATEGORY_OPTIONS)[number])) {
          await ctx.reply('Выберите категорию кнопкой.', CATEGORY_KEYBOARD);
          return;
        }

        this.setWizardDraft(ctx, { category: categoryInput });

        await ctx.reply('Введите теги через запятую или "-", чтобы пропустить:', Markup.removeKeyboard());
        ctx.wizard.next();
      },
      async (ctx) => {
        const tagsInput = this.getMessageText(ctx);
        if (!tagsInput) {
          await ctx.reply('Введите теги через запятую или "-", чтобы пропустить.');
          return;
        }

        const draft = await this.ensureDraftReady(ctx, this.getWizardDraft(ctx));
        if (!draft) {
          await ctx.scene.leave();
          return;
        }

        const tags =
          tagsInput.trim() === '-'
            ? []
            : tagsInput
                .split(',')
                .map((tag) => tag.trim())
                .filter((tag) => tag.length > 0);

        const space = await this.prisma.space.findUnique({
          where: { id: ctx.state.spaceId },
          select: { id: true, currencyDefault: true, timezone: true }
        });

        if (!space) {
          await ctx.reply('Не найдено личное пространство. Отправьте /start, чтобы пересоздать профиль.', MAIN_MENU_KEYBOARD);
          await ctx.scene.leave();
          return;
        }

        await this.ensureDefaultReminderRules(space.id);

        const created = await this.prisma.subscription.create({
          data: {
            spaceId: space.id,
            title: draft.title,
            amountCents: draft.amountCents,
            currency: space.currencyDefault,
            category: draft.category,
            tags,
            status: SubscriptionStatus.ACTIVE,
            recurrenceType: draft.recurrenceType,
            recurrenceJson: draft.recurrenceJson as Prisma.InputJsonValue,
            nextChargeAt: draft.nextChargeAt
          }
        });

        let reminderStatusLine = 'Напоминания созданы.';
        try {
          await this.reminderService.generateEventsForNextCharge(created.id);
        } catch (error) {
          reminderStatusLine = 'Подписка сохранена, но напоминания не создались (посмотрите логи).';
          this.logger.error(`Failed to generate reminder events for ${created.id}: ${String(error)}`);
        }

        await ctx.reply(
          [
            `Сохранено: ${created.title}`,
            `Сумма: ${this.formatMoney(created.amountCents, created.currency)}`,
            `Следующее списание: ${formatDate(created.nextChargeAt, space.timezone)}`,
            reminderStatusLine
          ].join('\n'),
          AFTER_SAVE_KEYBOARD
        );

        this.resetWizardDraft(ctx);
        await ctx.scene.leave();
      }
    );
  }

  private async ensureDraftReady(
    ctx: BotContext,
    draft: AddSubscriptionDraft | undefined
  ): Promise<ReadySubscriptionDraft | null> {
    if (!(await this.ensureUserContext(ctx))) {
      return null;
    }

    if (
      !draft ||
      !draft.title ||
      draft.amountCents === undefined ||
      !draft.nextChargeAt ||
      !draft.category ||
      !draft.recurrenceType ||
      !draft.recurrenceJson
    ) {
      await ctx.reply('Не удалось собрать данные подписки. Начните заново через ➕ Добавить подписку.', MAIN_MENU_KEYBOARD);
      return null;
    }

    return {
      title: draft.title,
      amountCents: draft.amountCents,
      nextChargeAt: draft.nextChargeAt,
      recurrenceType: draft.recurrenceType,
      recurrenceJson: draft.recurrenceJson,
      category: draft.category
    };
  }

  private async askCategory(ctx: BotContext): Promise<void> {
    await ctx.reply('Выберите категорию:', CATEGORY_KEYBOARD);
  }

  private async handleAllSubscriptions(ctx: BotContext): Promise<void> {
    if (!(await this.ensureUserContext(ctx))) {
      return;
    }

    const timezone = ctx.state.timezone || 'Europe/Moscow';
    const subscriptions = await this.prisma.subscription.findMany({
      where: {
        spaceId: ctx.state.spaceId,
        status: SubscriptionStatus.ACTIVE
      },
      orderBy: {
        nextChargeAt: 'asc'
      },
      take: 20,
      select: {
        title: true,
        amountCents: true,
        currency: true,
        nextChargeAt: true
      }
    });

    if (!subscriptions.length) {
      await ctx.reply('Пока нет активных подписок. Добавьте первую через ➕ Добавить подписку.', MAIN_MENU_KEYBOARD);
      return;
    }

    const lines = subscriptions.map((item, idx) => {
      return `${idx + 1}. ${item.title} — ${this.formatMoney(item.amountCents, item.currency)} — ${formatDate(item.nextChargeAt, timezone)}`;
    });

    await ctx.reply(`📚 Все подписки (до 20):\n${lines.join('\n')}`, MAIN_MENU_KEYBOARD);
  }

  private async handleUpcomingSubscriptions(ctx: BotContext): Promise<void> {
    if (!(await this.ensureUserContext(ctx))) {
      return;
    }

    const timezone = ctx.state.timezone || 'Europe/Moscow';
    const subscriptions = await this.prisma.subscription.findMany({
      where: {
        spaceId: ctx.state.spaceId,
        status: SubscriptionStatus.ACTIVE
      },
      orderBy: {
        nextChargeAt: 'asc'
      },
      take: 5,
      select: {
        title: true,
        amountCents: true,
        currency: true,
        nextChargeAt: true
      }
    });

    if (!subscriptions.length) {
      await ctx.reply('Ближайших подписок пока нет. Добавьте их через ➕ Добавить подписку.', MAIN_MENU_KEYBOARD);
      return;
    }

    const lines = subscriptions.map((item, idx) => {
      return `${idx + 1}. ${item.title} — ${this.formatMoney(item.amountCents, item.currency)} — ${formatDate(item.nextChargeAt, timezone)}`;
    });

    await ctx.reply(`📅 Ближайшие списания (топ-5):\n${lines.join('\n')}`, MAIN_MENU_KEYBOARD);
  }

  private async handlePauseAction(ctx: BotContext, subscriptionId: string): Promise<void> {
    await ctx.answerCbQuery();

    const subscription = await this.getSubscriptionForCurrentUser(ctx, subscriptionId);
    if (!subscription) {
      await ctx.reply('Подписка не найдена или нет доступа.', MAIN_MENU_KEYBOARD);
      return;
    }

    await this.prisma.subscription.update({
      where: { id: subscription.id },
      data: { status: SubscriptionStatus.PAUSED }
    });

    await this.reminderService.deletePlannedEvents(subscription.id);
    await ctx.reply('Поставил на паузу', MAIN_MENU_KEYBOARD);
  }

  private async handleEditDateAction(ctx: BotContext, subscriptionId: string): Promise<void> {
    await ctx.answerCbQuery();

    if (!ctx.from) {
      return;
    }

    const subscription = await this.getSubscriptionForCurrentUser(ctx, subscriptionId);
    if (!subscription) {
      await ctx.reply('Подписка не найдена или нет доступа.', MAIN_MENU_KEYBOARD);
      return;
    }

    this.pendingEditDateByTelegramId.set(ctx.from.id, subscription.id);
    await ctx.reply('Введи новую дату DD.MM.YYYY');
  }

  private async handlePaidAction(ctx: BotContext, subscriptionId: string): Promise<void> {
    await ctx.answerCbQuery();

    const subscription = await this.getSubscriptionForCurrentUser(ctx, subscriptionId);
    if (!subscription) {
      await ctx.reply('Подписка не найдена или нет доступа.', MAIN_MENU_KEYBOARD);
      return;
    }

    const timezone = subscription.space.timezone || 'Europe/Moscow';
    const newNextChargeAt = this.recurrenceService.computeNextChargeAt(
      subscription.nextChargeAt,
      subscription.recurrenceType,
      subscription.recurrenceJson,
      timezone
    );

    await this.prisma.subscription.update({
      where: { id: subscription.id },
      data: {
        nextChargeAt: newNextChargeAt,
        status: SubscriptionStatus.ACTIVE
      }
    });

    await this.reminderService.deletePlannedEvents(subscription.id);
    await this.reminderService.generateEventsForNextCharge(subscription.id);

    await ctx.reply('Ок, перенес на следующий платеж', MAIN_MENU_KEYBOARD);
  }

  private async handlePendingEditDateInput(ctx: BotContext): Promise<boolean> {
    if (!ctx.from) {
      return false;
    }

    const subscriptionId = this.pendingEditDateByTelegramId.get(ctx.from.id);
    if (!subscriptionId) {
      return false;
    }

    const input = this.getMessageText(ctx);
    if (!input) {
      await ctx.reply('Введите дату в формате DD.MM.YYYY');
      return true;
    }

    const timezone = ctx.state.timezone || 'Europe/Moscow';
    const parsedDate = parseDateDDMMYYYY(input, timezone);
    if (!parsedDate) {
      await ctx.reply('Некорректная дата. Используйте формат DD.MM.YYYY, например 17.03.2026');
      return true;
    }

    const subscription = await this.getSubscriptionForCurrentUser(ctx, subscriptionId);
    if (!subscription) {
      this.pendingEditDateByTelegramId.delete(ctx.from.id);
      await ctx.reply('Подписка не найдена или нет доступа.', MAIN_MENU_KEYBOARD);
      return true;
    }

    const currentLocal = DateTime.fromJSDate(subscription.nextChargeAt, { zone: timezone });
    const newLocalDate = DateTime.fromJSDate(parsedDate, { zone: timezone }).set({
      hour: currentLocal.hour,
      minute: currentLocal.minute,
      second: 0,
      millisecond: 0
    });

    await this.prisma.subscription.update({
      where: { id: subscription.id },
      data: {
        nextChargeAt: newLocalDate.toUTC().toJSDate(),
        status: SubscriptionStatus.ACTIVE
      }
    });

    await this.reminderService.deletePlannedEvents(subscription.id);
    await this.reminderService.generateEventsForNextCharge(subscription.id);

    this.pendingEditDateByTelegramId.delete(ctx.from.id);
    await ctx.reply('Дата обновлена', MAIN_MENU_KEYBOARD);
    return true;
  }

  private async getSubscriptionForCurrentUser(ctx: BotContext, subscriptionId: string) {
    if (!(await this.ensureUserContext(ctx))) {
      return null;
    }

    return this.prisma.subscription.findFirst({
      where: {
        id: subscriptionId,
        spaceId: ctx.state.spaceId
      },
      select: {
        id: true,
        nextChargeAt: true,
        recurrenceType: true,
        recurrenceJson: true,
        status: true,
        space: {
          select: {
            timezone: true
          }
        }
      }
    });
  }

  private async ensureDefaultReminderRules(spaceId: string): Promise<void> {
    await this.prisma.reminderRule.upsert({
      where: {
        spaceId_type: {
          spaceId,
          type: ReminderType.BEFORE
        }
      },
      update: {
        offsetMinutes: 4320,
        enabled: true
      },
      create: {
        spaceId,
        type: ReminderType.BEFORE,
        offsetMinutes: 4320,
        enabled: true
      }
    });

    await this.prisma.reminderRule.upsert({
      where: {
        spaceId_type: {
          spaceId,
          type: ReminderType.DAY_OF
        }
      },
      update: {
        offsetMinutes: 0,
        dayOfTime: '09:00',
        enabled: true
      },
      create: {
        spaceId,
        type: ReminderType.DAY_OF,
        offsetMinutes: 0,
        dayOfTime: '09:00',
        enabled: true
      }
    });
  }

  private getMessageText(ctx: BotContext): string | null {
    const message = ctx.message;
    if (!message || !('text' in message)) {
      return null;
    }

    const text = message.text.trim();
    return text.length > 0 ? text : null;
  }

  private parseDayMonth(input: string): { day: number; month: number } | null {
    const match = input.trim().match(/^(\d{2})\.(\d{2})$/);
    if (!match) {
      return null;
    }

    const day = Number(match[1]);
    const month = Number(match[2]);
    const probe = new Date(Date.UTC(2024, month - 1, day));

    if (probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) {
      return null;
    }

    return { day, month };
  }

  private formatMoney(amountCents: number, currency: string): string {
    return `${(amountCents / 100).toFixed(2)} ${currency}`;
  }

  private getWizardDraft(ctx: BotContext): AddSubscriptionDraft | undefined {
    const state = ctx.wizard.state as { draft?: AddSubscriptionDraft };
    return state.draft;
  }

  private setWizardDraft(ctx: BotContext, patch: Partial<AddSubscriptionDraft>): void {
    const state = ctx.wizard.state as { draft?: AddSubscriptionDraft };
    state.draft = {
      ...(state.draft ?? {}),
      ...patch
    };
  }

  private resetWizardDraft(ctx: BotContext): void {
    const state = ctx.wizard.state as { draft?: AddSubscriptionDraft };
    state.draft = {};
  }

  private async ensureUserContext(ctx: BotContext): Promise<boolean> {
    if (ctx.state.userId && ctx.state.spaceId) {
      return true;
    }

    await ctx.reply('Сначала отправьте /start, чтобы подготовить личное пространство.', MAIN_MENU_KEYBOARD);
    return false;
  }

  private resolveTelegramMode(): TelegramMode {
    const raw = String(process.env.TELEGRAM_MODE ?? 'polling').trim().toLowerCase();
    return raw === 'webhook' ? 'webhook' : 'polling';
  }

  private async startWebhookMode(): Promise<void> {
    if (!this.token || this.isStopping || this.isLaunching) {
      return;
    }

    const baseUrl = String(process.env.PUBLIC_BASE_URL ?? '').trim();
    const hookPath = String(process.env.TELEGRAM_WEBHOOK_PATH ?? '/telegram/webhook').trim();
    const secretToken = String(process.env.TELEGRAM_SECRET_TOKEN ?? '').trim() || undefined;

    if (!baseUrl) {
      this.logger.error('PUBLIC_BASE_URL is not set. Telegram webhook mode is enabled but webhook cannot be configured.');
      return;
    }

    if (!hookPath) {
      this.logger.error(
        'TELEGRAM_WEBHOOK_PATH is not set. Telegram webhook mode is enabled but webhook cannot be configured.'
      );
      return;
    }

    let webhookUrl: string;

    try {
      webhookUrl = new URL(hookPath, baseUrl).toString();
    } catch (error) {
      this.logger.error(`Invalid webhook URL parts: baseUrl=${baseUrl}, hookPath=${hookPath}. ${String(error)}`);
      return;
    }

    this.isLaunching = true;
    const bot = new Telegraf<BotContext>(this.token);
    this.registerHandlers(bot);
    this.bot = bot;

    try {
      await bot.telegram.setWebhook(
        webhookUrl,
        {
          drop_pending_updates: true,
          ...(secretToken ? { secret_token: secretToken } : {})
        } as never
      );

      this.logger.log(`Telegram bot started in webhook mode. Webhook URL: ${webhookUrl}`);
      if (secretToken) {
        this.logger.log('Telegram webhook secret token is enabled');
      }
    } catch (error) {
      this.logger.error(`Failed to set Telegram webhook (${webhookUrl}): ${String(error)}`);
    } finally {
      this.isLaunching = false;
    }
  }

  private async launchBot(): Promise<void> {
    if (!this.token || this.isStopping || this.isLaunching) {
      return;
    }

    this.isLaunching = true;
    const bot = new Telegraf<BotContext>(this.token);
    this.registerHandlers(bot);
    this.bot = bot;

    try {
      await bot.launch(() => {
        this.logger.log('Telegram bot started (polling mode)');
      });
    } catch (error) {
      const errorText = String(error);
      if (errorText.includes('409')) {
        this.logger.warn(
          `Telegram polling conflict (409). Вероятно запущен второй экземпляр бота или для этого BOT_TOKEN включен webhook. Retrying in ${this.reconnectDelayMs / 1000}s...`
        );
      } else {
        this.logger.error(`Failed to start Telegram bot: ${errorText}`);
      }

      try {
        bot.stop('RETRY_AFTER_ERROR');
      } catch {
        // no-op
      }
      this.bot = undefined;

      if (!this.isStopping) {
        this.scheduleLaunch(this.reconnectDelayMs);
      }
    } finally {
      this.isLaunching = false;
    }
  }

  private scheduleLaunch(delayMs: number): void {
    if (this.isStopping) {
      return;
    }

    if (this.launchTimer) {
      clearTimeout(this.launchTimer);
    }

    this.launchTimer = setTimeout(() => {
      void this.launchBot();
    }, delayMs);
  }
}
