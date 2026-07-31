// Таск trigger.dev "remind" — напоминание за 2 часа до начала слота.
//
// Ставится ОТЛОЖЕННЫМ раном в момент создания брони (book-now.ts и успешный
// дроп в book-drop.ts), поэтому никакого cron здесь нет: запуск ровно один и
// ровно на свою бронь. Дубли отсекает idempotencyKey = 'remind-<bookingId>'.
//
// Главное правило: НАПОМИНАНИЕ НЕ ДОВЕРЯЕТ САМО СЕБЕ. Между планированием и
// срабатыванием проходят часы — бронь могли отменить. Поэтому run() сначала
// перечитывает state и молча выходит, если брони нет или она canceled.
//
// Приватность: chat_id профиля не попадает НИКУДА — ни в payload, ни в логи, ни
// в output рана (всё это видно на одной странице дашборда любому, у кого есть
// доступ). Адресат берётся в момент отправки из profiles.telegram_chat_id: это
// же делает отзыв доступа настоящим — очистили chat_id в БД, и запланированные
// часы назад напоминания больше никуда не уйдут. Токен брони здесь не читается
// вовсе.

import { logger, task, tasks } from '@trigger.dev/sdk';
import { sendTelegram, type TelegramTarget } from '../core/notify.js';
import { slotEndISO, slotStartISO } from '../core/scheduler.js';
import type { StateStore, StoredBooking } from '../core/state.js';
import { SupabaseStateStore } from '../core/state-supabase.js';
import { ProfilesRepo } from '../core/repos.js';

export interface RemindPayload {
  profileId: string;
  /** YYYY-MM-DD */
  date: string;
  /** HH:MM */
  time: string;
  court: string;
  /**
   * Бронь, ради которой ставили напоминание. Сверяется со state перед
   * отправкой: «отменил и перебронировал тот же слот» иначе даёт два рана
   * (ключи remind-<id> разные) и два одинаковых сообщения на одну бронь.
   */
  bookingId: string;
}

/** За сколько до начала слота напоминаем. */
export const REMIND_LEAD_MS = 2 * 60 * 60 * 1000;

export type RemindOutcome =
  /** отправлено */
  | 'sent'
  /** Telegram не принял сообщение — ран падает, чтобы сработал ретрай */
  | 'not-delivered'
  /** бронь отменена — напоминать нечего */
  | 'skipped-canceled'
  /** на слоте живёт ДРУГАЯ бронь: эта уже неактуальна (её напомнит свой ран) */
  | 'skipped-stale'
  /** брони нет в state (отменена и вычищена, либо state другой) */
  | 'skipped-missing'
  /** state не настроен: проверить актуальность брони нечем */
  | 'skipped-no-state'
  /** адресат неизвестен */
  | 'skipped-no-chat';

export interface RemindDeps {
  /** null — хранилище не настроено. */
  state: StateStore | null;
  /** null — адресата нет. */
  send: ((text: string) => Promise<boolean>) | null;
  log?: (msg: string) => void;
}

/** Экранирование для parse_mode=HTML (те же три символа, что в notify.ts). */
function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** 'HH:MM' из ISO-строки '2026-08-06T20:59:00+04:00'. */
function hm(iso: string): string {
  return iso.slice(11, 16);
}

/** Момент отправки напоминания: начало слота минус 2 часа. */
export function remindAt(date: string, time: string): Date {
  return new Date(new Date(slotStartISO(date, time)).getTime() - REMIND_LEAD_MS);
}

export function remindText(b: { date: string; time: string; court: string }): string {
  return (
    `⏰ <b>Через 2 часа:</b> ${esc(b.court)}, ${esc(b.time)}—${esc(hm(slotEndISO(b.date, b.time)))} ` +
    `(${esc(b.date)})`
  );
}

/**
 * Чистая логика напоминания: перечитать state → решить → отправить.
 * Ошибку чтения state НЕ глотает: пусть ран упадёт и ретрайнется, иначе
 * напоминание тихо потеряется.
 */
export async function runReminder(payload: RemindPayload, deps: RemindDeps): Promise<RemindOutcome> {
  const log = deps.log ?? ((): void => {});
  const { profileId, date, time } = payload;

  if (deps.state === null) {
    // Слать «вслепую» нельзя: бронь могли отменить, а напоминание об отменённой
    // брони отправит человека на корт зря.
    log('remind: state не настроен (SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY) — проверить бронь нечем, не шлём');
    return 'skipped-no-state';
  }

  const booking = await deps.state.getBooking(profileId, date, time);
  if (!booking) {
    log(`remind: брони ${profileId} ${date} ${time} нет в state — молча выходим`);
    return 'skipped-missing';
  }
  if (booking.state === 'canceled') {
    log(`remind: бронь ${booking.bookingId} отменена — напоминание не отправляем`);
    return 'skipped-canceled';
  }
  // Ключ state — (profileId, date, time), поэтому «отменил и перебронировал тот
  // же слот» перезаписывает строку: старый ран увидел бы живую чужую бронь и
  // прислал бы второй одинаковый текст. Напоминает только ран своей брони.
  if (payload.bookingId !== '' && booking.bookingId !== payload.bookingId) {
    log(`remind: на ${date} ${time} теперь другая бронь (${booking.bookingId}) — напоминание этого рана неактуально`);
    return 'skipped-stale';
  }

  if (deps.send === null) {
    log('remind: адресат неизвестен (нет chat_id и TELEGRAM_BOT_TOKEN) — напоминание некуда слать');
    return 'skipped-no-chat';
  }

  // court берём из state: он авторитетнее payload (бронь могли переставить).
  const text = remindText({ date, time, court: booking.court || payload.court });
  return (await deps.send(text)) ? 'sent' : 'not-delivered';
}

/** SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY; null — Supabase не настроен. */
function supabaseFromEnv(): { url: string; serviceKey: string } | null {
  const url = process.env.SUPABASE_URL?.trim() ?? '';
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ?? '';
  if (url === '' || serviceKey === '') return null;
  return { url, serviceKey };
}

/** SupabaseStateStore из env; null — не настроен (тогда напоминание не уходит). */
function stateFromEnv(): StateStore | null {
  const opts = supabaseFromEnv();
  return opts === null ? null : new SupabaseStateStore(opts);
}

/**
 * Адресат: chat_id читается из profiles В МОМЕНТ ОТПРАВКИ, а не берётся из
 * payload. Так он не оседает в дашборде и так же работает отзыв доступа —
 * очищенный telegram_chat_id гасит и уже запланированные напоминания.
 * Ошибку чтения НЕ глотаем: пусть ран упадёт и ретрайнется.
 */
async function targetFor(profileId: string): Promise<TelegramTarget | null> {
  const botToken = process.env.TELEGRAM_BOT_TOKEN?.trim() ?? '';
  const opts = supabaseFromEnv();
  if (botToken === '' || opts === null) return null;
  const profile = await new ProfilesRepo(opts).getById(profileId);
  const chat = profile?.telegramChatId?.trim() ?? '';
  return chat === '' ? null : { botToken, chatId: chat };
}

export const remindTask = task({
  id: 'remind',
  // Ретраи безопасны: перед каждой отправкой state перечитывается заново, а
  // успешный ран не ретраится вовсе.
  retry: { maxAttempts: 3, minTimeoutInMs: 5_000, maxTimeoutInMs: 30_000, factor: 2, randomize: true },
  run: async (payload: RemindPayload): Promise<{ outcome: RemindOutcome; profileId: string; date: string; time: string }> => {
    const target = await targetFor(payload.profileId);
    const outcome = await runReminder(payload, {
      state: stateFromEnv(),
      send: target === null ? null : (text: string): Promise<boolean> => sendTelegram(target, text),
      log: (msg: string) => logger.info(msg),
    });

    // chat_id в output не кладём: output рана виден всем, у кого есть дашборд.
    const result = { outcome, profileId: payload.profileId, date: payload.date, time: payload.time };
    if (outcome === 'not-delivered') {
      // Падаем осознанно — ретрай таска это единственный шанс доставить.
      throw new Error(`remind: Telegram не принял напоминание (${payload.date} ${payload.time})`);
    }
    return result;
  },
});

/** Узкая подпись tasks.trigger — ровно то, что нужно планированию (и подменяемо в тестах). */
export type TriggerFn = (
  id: string,
  payload: RemindPayload,
  options: { delay: Date; idempotencyKey: string },
) => Promise<unknown>;

export interface ScheduleReminderOptions {
  now?: () => Date;
  trigger?: TriggerFn;
  log?: (msg: string) => void;
}

export type ScheduleReminderOutcome = 'scheduled' | 'skipped-no-chat' | 'skipped-past';

/**
 * Ставит отложенный ран 'remind' на «начало слота минус 2 часа».
 *
 * Вызывать сразу после успешной брони. Дубль исключён idempotencyKey по
 * bookingId: сколько бы раз ни позвали, ран будет один.
 *
 * `chatId` — только признак «адресат вообще есть»: в payload он НЕ едет, сам
 * адрес таск читает из profiles в момент отправки (см. targetFor).
 *
 * Бросает наружу только отказ самого trigger.dev — вызывающие (book-now,
 * book-drop) обязаны ловить: напоминание никогда не важнее брони.
 */
export async function scheduleReminder(
  booking: Pick<StoredBooking, 'profileId' | 'date' | 'time' | 'court' | 'bookingId'>,
  chatId: string,
  opts: ScheduleReminderOptions = {},
): Promise<ScheduleReminderOutcome> {
  const log = opts.log ?? ((): void => {});
  const now = opts.now?.() ?? new Date();
  const chat = chatId.trim();
  if (chat === '') {
    log(`remind: у профиля ${booking.profileId} нет чата — напоминание не планируем`);
    return 'skipped-no-chat';
  }

  const at = remindAt(booking.date, booking.time);
  if (at.getTime() <= now.getTime()) {
    // До слота меньше двух часов: напоминание «через 2 часа» уже неправда.
    log(`remind: до ${booking.date} ${booking.time} меньше 2 часов — напоминание не планируем`);
    return 'skipped-past';
  }

  const payload: RemindPayload = {
    profileId: booking.profileId,
    date: booking.date,
    time: booking.time,
    court: booking.court,
    bookingId: booking.bookingId,
  };
  const trigger: TriggerFn =
    opts.trigger ?? ((id, p, options) => tasks.trigger<typeof remindTask>(id as 'remind', p, options));
  await trigger('remind', payload, { delay: at, idempotencyKey: `remind-${booking.bookingId}` });
  log(`remind: запланировано на ${at.toISOString()} для брони ${booking.bookingId}`);
  return 'scheduled';
}

/**
 * Готовый deps.scheduleReminder для bookNow: сам глотать ошибки не должен —
 * это делает bookNow, — но приводит подпись к (booking) => Promise<void>.
 */
export function reminderScheduler(
  chatId: string,
  opts: ScheduleReminderOptions = {},
): (booking: StoredBooking) => Promise<void> {
  return async (booking: StoredBooking): Promise<void> => {
    await scheduleReminder(booking, chatId, opts);
  };
}
