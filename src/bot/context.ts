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
import type { BookingIntent } from '../core/intent.js';

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

/**
 * Парсер свободного текста в структуру (src/core/intent.ts) — единственное
 * место во всём боте, где вообще есть LLM. Импортируем ФОРМУ, а не модуль: тому,
 * кто её вызывает, нужна только сигнатура, а тест подменяет её без сети.
 */
export type ParseIntentFn = (
  text: string,
  ctx: { todayTbilisi: string; weekday: number; courts: string[] },
  opts: { apiKey: string; fetchFn?: typeof fetch; timeoutMs?: number },
) => Promise<BookingIntent | null>;

/** Ровно то, что нужно суточному лимиту свободных запросов. SettingsRepo подходит как есть. */
export interface SettingsLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
}

/**
 * Всё, что нужно ветке свободных запросов. Одним объектом, а не тремя полями,
 * ради единственной проверки «фича собрана или нет»: без счётчика лимита эту
 * ветку включать нельзя (лимит — единственное, что стоит между чужим текстом и
 * платным API), поэтому и парсер, и ключ живут здесь же.
 */
export interface FreeQueryDeps {
  parseIntent: ParseIntentFn;
  /** Счётчик запросов за сутки: ключ `llm_quota:{profileId}:{дата Тбилиси}`. */
  settings: SettingsLike;
  /** '' — ANTHROPIC_API_KEY не задан: модель не зовём вовсе (см. handlers/free-query.ts). */
  apiKey: string;
}

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
  /**
   * undefined — свободные запросы не собраны: бот на посторонний текст молчит,
   * ровно как до фазы 5. Собранные (даже с пустым apiKey) — см. handlers/free-query.ts.
   */
  freeQuery?: FreeQueryDeps;
  now?: () => Date;
  log?: (msg: string) => void;
}

/** Контакт для guest-брони из строки профиля. */
export function contactOf(profile: ProfileRow): ClientContact {
  return { name: profile.name, email: profile.email, phone: profile.phone };
}
