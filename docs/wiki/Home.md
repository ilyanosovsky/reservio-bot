# padel-bot — wiki

Автономный бот бронирования падел-кортов на **Padel Port Batumi** (Reservio API v2).

Каждый день в районе 21:0x по времени Батуми (Asia/Tbilisi, +04:00, без DST)
открывается слот на день **T+7**. Бот должен успеть забронировать
**Padel Court 3** (fallback: **Padel Court 2**) на **20:00 и 21:00** быстрее
конкурентов и отчитаться в Telegram.

**Архитектурный принцип — путь A:** детерминированный код (cron + прямые вызовы
Reservio API v2), никакого LLM и никаких browser-агентов в core-флоу. LLM
появится только в фазе 5 как парсер свободных запросов из Telegram.

## Статус

Фаза 1 (spike, подтверждение протокола) завершена 30.07.2026. Идёт фаза 2
(ветка `feat/booking-engine`): API-клиент, scheduler, state, профили и CLI
`run-drop.ts` реализованы, `core/booking-engine.ts` (`bookSlotDrop`) — в
разработке. Telegram-бот (фаза 3) ещё не начат. Ручной таск trigger.dev
подключён, но **без schedules** — боевой cron включится только в фазе 4 и
только после явного одобрения пользователя. Подробности — в `Architecture`
и `Runbook`.

Полный список фаз с критериями приёмки: [`PLAN.md`](../../PLAN.md).

## Страницы вики

- [Architecture](Architecture.md) — модули, потоки данных, почасовая дроп-модель
- [Dev-Process](Dev-Process.md) — ветки, PR, CI, ревью, мердж
- [Runbook](Runbook.md) — как гонять скрипты, читать логи, отменять брони

## Прочая документация в репозитории

- [`CLAUDE.md`](../../CLAUDE.md) — правила для агента, ключевые факты, стек
- [`PLAN.md`](../../PLAN.md) — фазы разработки и зафиксированные решения
- [`docs/PROTOCOL.md`](../PROTOCOL.md) — протокол Reservio API v2 (подтверждён живым API)

## Ключевые факты (кратко)

- API: `https://api.reservio.com/v2`, JSON:API, businessId
  `1e32bd0a-0d5c-4e30-9788-ea488e713c4d`, auth не требуется.
- Каждый корт = отдельный `service`; Court 3 = `303f3adf-8a99-4c1f-89fe-f9a9b56a620b`,
  Court 2 = `c36479d3-8201-4d80-9822-e9c08014468b` (полная таблица — в `PROTOCOL.md`).
- Слот длится 59 минут; «игра 2 часа» = два отдельных booking (20:00 и 21:00).
- Бронь — guest-флоу (`name/email/phone` в payload), без логина/OAuth.
- Успех брони = получен `booking_id`; отмена = `PATCH ... state:"canceled"`
  (ровно так, одна L) и проверка `state` в ответе, а не HTTP-кода.
