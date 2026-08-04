/**
 * Тип контекста бота и его зависимости.
 *
 * `ctx.state.profile` кладёт auth-middleware (src/bot/auth.ts) — до него ни один
 * хендлер не выполняется, поэтому поле объявлено обязательным (тот же приём,
 * что у session-флейвора grammY).
 *
 * Зависимости приходят снаружи (index.ts собирает боевые, тесты — фейковые):
 * ни один хендлер не читает process.env и не создаёт клиентов сам.
 */

import type { Context } from 'grammy';
import type { InvitesRepo, ProfileRow, ProfilesRepo, SchedulesRepo, SkipsRepo } from '../core/repos.js';
import type { ReservioClient } from '../reservio/client.js';
import type { ClientContact } from '../reservio/types.js';
import type { StateStore, StoredBooking } from '../core/state.js';

export interface BotState {
  profile: ProfileRow;
}

export type BotContext = Context & { state: BotState };

/**
 * Структурная копия контракта src/core/book-now.ts. Импортируем не сам модуль,
 * а форму: хендлерам нужна только сигнатура, а подмена в тестах становится
 * тривиальной.
 */
export interface BookNowDepsLike {
  client: ReservioClient;
  state: StateStore;
  scheduleReminder?: (b: StoredBooking) => Promise<void>;
}

export type BookNowResult = { ok: true; booking: StoredBooking } | { ok: false; reason: string };

export type BookNowFn = (
  profile: { id: string; contact: ClientContact },
  target: { date: string; time: string; court: string },
  deps: BookNowDepsLike,
) => Promise<BookNowResult>;

/**
 * Планировщик напоминания. chatId передаётся отдельным аргументом (а не берётся
 * из профиля внутри), чтобы хендлер отвечал за адресата явно: у книги-по-запросу
 * это всегда чат того, кто нажал кнопку.
 */
export type ScheduleReminderFn = (booking: StoredBooking, chatId: string) => Promise<void>;

export interface BotDeps {
  profiles: ProfilesRepo;
  schedules: SchedulesRepo;
  skips: SkipsRepo;
  /** Одноразовые коды привязки чата к профилю (мастер «➕ Добавить профиль»). */
  invites: InvitesRepo;
  client: ReservioClient;
  state: StateStore;
  bookNow: BookNowFn;
  /** undefined — напоминания не планируются (нет ключа trigger.dev); бронь это не ломает. */
  scheduleReminder?: ScheduleReminderFn;
  now?: () => Date;
  log?: (msg: string) => void;
}

/** Контакт для guest-брони из строки профиля. */
export function contactOf(profile: ProfileRow): ClientContact {
  return { name: profile.name, email: profile.email, phone: profile.phone };
}
