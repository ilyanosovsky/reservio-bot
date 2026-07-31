/**
 * Планирование напоминания «⏰ через 2 часа» для брони, созданной из чата.
 *
 * Само напоминание отправляет таск trigger.dev `remind` (src/trigger/remind.ts):
 * он перед отправкой перечитывает state и молчит, если бронь отменена. Здесь
 * только постановка отложенного рана.
 *
 * Идемпотентность держится на `idempotencyKey = remind-{bookingId}`: повторная
 * бронь того же слота (или повторный тап) не породит второе напоминание.
 *
 * Провал планирования НИКОГДА не отменяет бронь — вызов обёрнут в try/catch
 * и здесь, и в book-now.
 */

import type { Task } from '@trigger.dev/sdk';
import type { StoredBooking } from '../core/state.js';
import type { ScheduleReminderFn } from './context.js';
import { slotStartISO } from '../core/scheduler.js';
import { safeErrorText } from './errors.js';

/** Напоминаем за 2 часа до начала слота. */
const REMIND_LEAD_MS = 2 * 60 * 60 * 1000;

/**
 * Зеркало RemindPayload из src/trigger/remind.ts (модуль не импортируем: он
 * тянет SDK). chat_id в payload НЕТ намеренно — адресата таск читает из
 * profiles в момент отправки, а payload виден в дашборде trigger.dev.
 */
export interface RemindPayload {
  profileId: string;
  date: string;
  time: string;
  court: string;
  bookingId: string;
}

/** Форма таска нужна только для типизации tasks.trigger — сам модуль не импортируем. */
type RemindTask = Task<'remind', RemindPayload, void>;

type Env = Record<string, string | undefined>;

/** SDK читает TRIGGER_SECRET_KEY; в проекте ключи разложены по средам. */
function secretKeyOf(env: Env): string | undefined {
  for (const name of ['TRIGGER_SECRET_KEY', 'TRIGGER_SECRET_KEY_PROD', 'TRIGGER_SECRET_KEY_DEV']) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

/**
 * Возвращает планировщик напоминаний или undefined, если trigger.dev не
 * настроен. undefined — не ошибка: бот полностью работоспособен без
 * напоминаний, и это лучше, чем падать на каждой брони.
 */
export function makeReminderScheduler(
  env: Env,
  log: (msg: string) => void = () => {},
): ScheduleReminderFn | undefined {
  const secretKey = secretKeyOf(env);
  if (secretKey === undefined) {
    log('напоминания выключены: не задан TRIGGER_SECRET_KEY(_PROD/_DEV)');
    return undefined;
  }
  // SDK берёт ключ из process.env — кладём туда тот, что нашли (не перетирая явный).
  if ((process.env.TRIGGER_SECRET_KEY ?? '').trim() === '') process.env.TRIGGER_SECRET_KEY = secretKey;

  // chatId остаётся в подписи как признак «адресат есть»: сам адрес таск
  // возьмёт из profiles, когда придёт время слать.
  return async (booking: StoredBooking, chatId: string): Promise<void> => {
    const startMs = new Date(slotStartISO(booking.date, booking.time)).getTime();
    const at = new Date(startMs - REMIND_LEAD_MS);
    if (!Number.isFinite(at.getTime()) || at.getTime() <= Date.now()) {
      log(`напоминание не ставим: до ${booking.date} ${booking.time} осталось меньше 2 часов`);
      return;
    }

    if (chatId.trim() === '') {
      log(`напоминание не ставим: у профиля ${booking.profileId} нет чата`);
      return;
    }

    const payload: RemindPayload = {
      profileId: booking.profileId,
      date: booking.date,
      time: booking.time,
      court: booking.court,
      bookingId: booking.bookingId,
    };

    try {
      // Динамический импорт: SDK нужен только в момент постановки рана, а
      // long-polling процесс не должен тянуть его на старте.
      const { tasks } = await import('@trigger.dev/sdk');
      await tasks.trigger<RemindTask>('remind', payload, {
        delay: at,
        idempotencyKey: `remind-${booking.bookingId}`,
      });
      log(`напоминание поставлено на ${at.toISOString()} (бронь ${booking.bookingId})`);
    } catch (err) {
      // Бронь уже создана — её судьбу это не меняет.
      log(`не смог поставить напоминание для ${booking.bookingId}: ${safeErrorText(err)}`);
    }
  };
}
