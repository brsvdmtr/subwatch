# SubWatch (MVP)

MVP Telegram-бота для учета подписок и отправки напоминаний о списаниях.

## Почему выбран Telegraf

Для MVP выбран **Telegraf**:
- простой API для команд, кнопок и wizard-сцен;
- легко встраивается в NestJS;
- достаточно функциональности для callback actions и reminder-уведомлений.

## Стек

- Node.js 20+
- TypeScript
- NestJS
- Prisma + Postgres
- BullMQ + Redis
- Telegraf
- Luxon (timezone-safe расчеты)
- Docker Compose

## Что реализовано

### Базовый бот

- `/start`:
  - upsert `User` по `telegramId`;
  - создание `PERSONAL` `Space`, если отсутствует;
  - `SpaceMember` с ролью `OWNER`;
  - idempotent default reminder rules для space:
    - `BEFORE` = 3 дня (`offsetMinutes=4320`)
    - `DAY_OF` = `09:00` (`offsetMinutes=0`)
- `/ping` -> `pong`
- `GET /health`

### Подписки

- Wizard `➕ Добавить подписку`:
  - название;
  - сумма (`499` или `499.90`) -> `amountCents`;
  - дата `DD.MM.YYYY`;
  - периодичность:
    - `MONTHLY_BY_DAY` (`day` 1..31 или `LAST_DAY`, `everyNMonths=1`),
    - `EVERY_N_DAYS` (`intervalDays` 1..365),
    - `YEARLY` (`day` + `month`);
  - категория;
  - теги (или `-` для пропуска);
  - после сохранения: `📚 Все` / `📅 Ближайшие` / `➕ Добавить еще`.
- Экран `📚 Все`: до 20 активных подписок.
- Экран `📅 Ближайшие`: топ-5 по `nextChargeAt`.

### Напоминания (must-have)

- Prisma модели:
  - `ReminderRule`
  - `ReminderEvent`
- `ReminderService`:
  - `generateEventsForNextCharge(subscriptionId)`
  - `deletePlannedEvents(subscriptionId)`
- `RecurrenceService`:
  - `computeNextChargeAt(...)` для `MONTHLY_BY_DAY` / `EVERY_N_DAYS` / `YEARLY`
- BullMQ queue `reminders`:
  - producer каждые 60 секунд выбирает due `PLANNED` события;
  - jobs ставятся с `jobId=reminderEventId` (дедупликация);
  - worker отправляет Telegram-уведомление и помечает `SENT`/`FAILED`.
- После успешного `DAY_OF`:
  - пересчет `nextChargeAt`;
  - удаление PLANNED событий по подписке;
  - генерация событий следующего цикла.

### Inline кнопки в уведомлении

- `⏸ Пауза` (`pause:<subscriptionId>`)
  - `status = PAUSED`, удаление PLANNED, ответ пользователю.
- `✏️ Изменить дату` (`editdate:<subscriptionId>`)
  - бот просит `DD.MM.YYYY`, обновляет `nextChargeAt`, регенерирует события.
- `✅ Отметить списалось` (`paid:<subscriptionId>`)
  - перенос `nextChargeAt` на следующий цикл, регенерация событий.

## Prisma миграции

- `prisma/migrations/20260209204421_init_subwatch_models/migration.sql`
- `prisma/migrations/20260209213328_add_reminder_models/migration.sql`

## Быстрый старт

1. Скопировать переменные окружения:

```bash
cp .env.example .env
```

2. В `.env` указать `BOT_TOKEN`.

3. Поднять сервисы:

```bash
docker compose up --build
```

## Как получить BOT_TOKEN

1. Открыть Telegram и найти `@BotFather`.
2. Отправить `/newbot`.
3. Задать имя и username бота.
4. Вставить токен в `.env` (`BOT_TOKEN=...`).

## Проверки

### 1) Health endpoint

```bash
curl http://localhost:3000/health
```

Ожидаемый ответ:

```json
{"status":"ok","telegramMode":"polling","gitSha":"unknown"}
```

### 2) Создать 2 подписки и проверить списки

1. В Telegram отправить `/start`.
2. Добавить подписку №1 (`➕ Добавить подписку`), затем №2.
3. Нажать `📚 Все` — должны быть обе подписки.
4. Нажать `📅 Ближайшие` — должен быть top-5 ближайших.

### 3) Быстрый тест напоминаний (для локальной проверки)

1. Добавьте подписку с датой ближайшего списания (например сегодня/завтра).
2. Временно уменьшите offset BEFORE до 1 минуты:

```bash
docker compose exec -T postgres psql -U subwatch -d subwatch -c "UPDATE \"ReminderRule\" SET \"offsetMinutes\"=1 WHERE type='BEFORE';"
```

3. Дождитесь минуты и смотрите логи приложения:

```bash
docker compose logs -f app
```

Ожидаемые логи: enqueue due events, send success/failed.

### 4) Проверка rollover после DAY_OF

После отправки DAY_OF:
- `Subscription.nextChargeAt` должен сдвинуться на следующий цикл.

Пример проверки:

```bash
docker compose exec -T postgres psql -U subwatch -d subwatch -c "SELECT id,title,\"nextChargeAt\" FROM \"Subscription\" ORDER BY \"updatedAt\" DESC LIMIT 5;"
```

## Telegram modes

### polling (local/dev, по умолчанию)

Достаточно указать токен:

```env
BOT_TOKEN=...
TELEGRAM_MODE=polling
```

Если в логах видите `409` (conflict), обычно это значит:
- запущен второй экземпляр бота с тем же `BOT_TOKEN`, или
- для этого `BOT_TOKEN` включен webhook (в таком режиме `getUpdates`/polling работать не будет).

### webhook (production)

В webhook-режиме Nest поднимает HTTP endpoint и прокидывает апдейты в Telegraf, а на старте выставляет webhook через Telegram API.

Пример env:

```env
BOT_TOKEN=...
TELEGRAM_MODE=webhook
PUBLIC_BASE_URL=https://subwatch.example.com
TELEGRAM_WEBHOOK_PATH=/telegram/webhook
TELEGRAM_SECRET_TOKEN=some-random-secret
```

Требования:
- `PUBLIC_BASE_URL` должен быть **HTTPS** и доступен из интернета (Telegram не сможет ходить на `localhost`).
- Ваш reverse-proxy (nginx/caddy) должен проксировать `POST ${TELEGRAM_WEBHOOK_PATH}` в контейнер `subwatch-app:3000`.
- Если задан `TELEGRAM_SECRET_TOKEN`, сервер проверяет заголовок `X-Telegram-Bot-Api-Secret-Token`.

Быстрая проверка режима: `curl http://localhost:3000/health` (поле `telegramMode`).

## How to verify local -> git -> server

1) Локально: запушить изменения в `main`:

```bash
git push origin main
```

2) На сервере (Timeweb console/SSH): запустить деплой:

```bash
/usr/local/bin/subwatch-deploy
```

3) Проверить, что на сервере задеплоился нужный коммит:

```bash
curl -s http://127.0.0.1:3000/health
```

Поле `gitSha` должно совпасть с `git rev-parse --short HEAD` последнего коммита в `main`.

## Важные ограничения MVP

- Timezone на этом шаге упрощенно: расчеты и форматирование ориентированы на `Europe/Moscow`.
- Состояние для `✏️ Изменить дату` хранится in-memory (`Map<telegramId, subscriptionId>`). После рестарта процесса это состояние сбрасывается.
- В worker мы не создаем второй экземпляр бота: отправка идет через `TelegramService.sendMessage(...)`.
