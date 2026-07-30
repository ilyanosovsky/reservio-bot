# reservio-bot

Автономный бот бронирования падел-кортов на Padel Port Batumi (Reservio API v2).

Слоты клуба открываются почасово (rolling T+7): слот на час `H` дня T+7
появляется примерно в `(H-1):58:50` дня T. Бот ловит нужные дропы и бронирует
корты быстрее конкурентов, поддерживает несколько профилей (у каждого свой
контакт, времена и приоритет кортов) и управляется через Telegram.

## Документация

- [CLAUDE.md](CLAUDE.md) — архитектура, правила, процесс разработки
- [PLAN.md](PLAN.md) — фазы разработки с критериями приёмки
- [docs/PROTOCOL.md](docs/PROTOCOL.md) — извлечённый и живо подтверждённый протокол Reservio API v2

## Быстрый старт (dev)

```bash
pnpm install
cp .env.example .env   # заполнить CLIENT_* и ключи
pnpm test              # vitest
```

Спайк-скрипты фазы 1 (безопасны без флагов):

```bash
npx tsx spike-reservio.ts                  # слоты Court 3 на завтра
npx tsx spike-reservio.ts --book           # РЕАЛЬНАЯ бронь — только осознанно
npx tsx spike-reservio.ts --cancel <bookingId> --token <token>
```

## Процесс

Только PR из feature-веток; `main` protected. Каждый PR ревьюит charliecreates,
его комментарии отрабатываются и явно резолвятся. Мерджит владелец репо, когда
всё зелёное (CI + ревью). Тесты — vitest. Стек: TypeScript, Node 20+, pnpm,
trigger.dev (cron), grammY (Telegram), SQLite (state, за абстракцией StateStore).
