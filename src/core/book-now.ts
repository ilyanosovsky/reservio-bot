/**
 * Бронь по запросу («📆 Бронировать» в Telegram, ручные сценарии).
 *
 * Отличие от booking-engine.bookSlotDrop: здесь НЕТ ни ожидания окна дропа, ни
 * polling, ни перебора кортов — человек уже выбрал дату/время/корт из реально
 * свободных, и мы делаем ровно одну попытку. Дроп остаётся единственным местом,
 * где идёт гонка за секунды.
 *
 * Общее с движком (и специально сохранённое): один POST на вызов, никаких
 * ретраев, идемпотентность по (profileId, date, time, court) через StateStore,
 * успех — ТОЛЬКО по bookingId от API.
 *
 * Модуль хост-агностичен: ни env, ни trigger.dev SDK, ни Telegram. Планирование
 * напоминания приходит извне (deps.scheduleReminder) — так бот и облако
 * подставляют свои реализации, а тесты не тянут SDK.
 *
 * Приватность: `reason` уходит человеку в чат, поэтому чужой текст ошибки
 * (Reservio любит цитировать заявку) проходит через scrub() — email из него
 * вырезается.
 */

import type { ReservioClient } from '../reservio/client.js';
import type { BookingCreated, ClientContact, Slot } from '../reservio/types.js';
import { courtByName } from '../reservio/types.js';
import { isAmbiguousPostFailure } from './booking-engine.js';
import type { StateStore, StoredBooking } from './state.js';
import { slotEndISO, slotStartISO, tbilisiStamp } from './scheduler.js';

export interface BookNowDeps {
  client: ReservioClient;
  state: StateStore;
  /** Планировщик напоминания за 2 часа. Его падение НЕ отменяет и не роняет бронь. */
  scheduleReminder?: (b: StoredBooking) => Promise<void>;
  now?: () => Date;
  log?: (msg: string) => void;
}

export interface BookNowProfile {
  id: string;
  contact: ClientContact;
}

export interface BookNowTarget {
  /** YYYY-MM-DD */
  date: string;
  /** HH:MM */
  time: string;
  /** Имя корта как в COURTS ('Padel Court 3'). */
  court: string;
}

export type BookNowResult = { ok: true; booking: StoredBooking } | { ok: false; reason: string };

/** Сколько чужого текста (Reservio/сеть) пускаем в reason: остальное — шум для человека. */
const DETAIL_LIMIT = 200;

function describeError(err: unknown): string {
  if (err instanceof Error) {
    const { status, code } = err as Error & { status?: number; code?: string };
    return [err.message, status === undefined ? null : `status=${status}`, code ? `code=${code}` : null]
      .filter((p): p is string => p !== null && p !== '')
      .join(' ');
  }
  return String(err);
}

/**
 * Персональные данные из чужого текста. Контакт профиля мы в reason не кладём,
 * но Reservio в ошибках цитирует заявку целиком — email оттуда вырезаем.
 * Угловых скобок в заглушке нет намеренно: этот текст бот отправляет с
 * parse_mode=HTML, и «тег» стоил бы нам всего сообщения (HTTP 400).
 */
function scrub(text: string): string {
  return text.replace(/[^\s<>@]+@[^\s<>@]+/g, '[email]');
}

function detail(err: unknown): string {
  const text = scrub(describeError(err));
  return text.length <= DETAIL_LIMIT ? text : `${text.slice(0, DETAIL_LIMIT)}…`;
}

/**
 * Бронирует конкретный слот здесь и сейчас.
 *
 * Наружу не летят исключения — только результат: вызывающий это бот, у которого
 * молчание вместо ответа хуже любой ошибки.
 *
 * Порядок проверок принципиален:
 *  1. конфиг (корт, дата/время) — до любых сетевых запросов;
 *  2. state — дубль хуже отказа, поэтому при НЕДОСТУПНОМ state POST не делаем
 *     (в дропе наоборот: там бронь важнее, но там и гонка за секунды);
 *  3. availability — «свободен» подтверждает API, а не кнопка в чате;
 *  4. POST — ровно один, без ретраев.
 */
export async function bookNow(
  profile: BookNowProfile,
  target: BookNowTarget,
  deps: BookNowDeps,
): Promise<BookNowResult> {
  const { client, state } = deps;
  const now = deps.now ?? ((): Date => new Date());
  const log = deps.log ?? ((): void => {});
  const { date, time } = target;

  // 1. Конфиг: неизвестный корт и кривая дата — ошибки ввода, сеть трогать незачем.
  let court;
  try {
    court = courtByName(target.court);
  } catch (err) {
    return { ok: false, reason: detail(err) };
  }

  let wantStart: string;
  let wantEnd: string;
  try {
    wantStart = slotStartISO(date, time);
    wantEnd = slotEndISO(date, time);
  } catch (err) {
    return { ok: false, reason: `Неверные дата/время: ${detail(err)}` };
  }

  // 2. Идемпотентность — ТОЛЬКО по этому корту: бронь того же часа на ДРУГОМ
  //    корте легитимна (клуб то отдаёт, то держит вечерние корты, см. state.ts).
  //    Недоступный state — отказ: без него нельзя утверждать, что брони ещё
  //    нет, а дубль отменять руками дороже.
  let existing: StoredBooking | null;
  try {
    existing = await state.getBooking(profile.id, date, time, court.name);
  } catch (err) {
    return {
      ok: false,
      reason: `Не удалось проверить, нет ли уже брони на ${date} ${time} — бронировать вслепую не будем: ${detail(err)}`,
    };
  }
  if (existing && existing.state !== 'canceled') {
    return {
      ok: false,
      reason:
        `На ${date} ${time} уже есть бронь на ${existing.court} (${existing.bookingId}). Сначала отмени её. ` +
        'Другой корт на это же время — можно.',
    };
  }

  // 3. Свободен ли слот на самом деле. Кнопка в чате могла устареть на минуты.
  let slots: Slot[];
  try {
    slots = await client.getAvailability(court.serviceId, date);
  } catch (err) {
    return { ok: false, reason: `Не удалось получить свободные слоты ${court.name} на ${date}: ${detail(err)}` };
  }
  if (!Array.isArray(slots)) {
    return { ok: false, reason: `Reservio вернул availability в неизвестном формате — нужна ручная проверка` };
  }
  const found = slots.find((slot) => slot?.start === wantStart);
  if (!found) {
    return { ok: false, reason: `${date} ${time} на ${court.name} уже занято (или слот ещё не открылся).` };
  }

  // 4. Единственный POST. Ретраев нет: повтор — это риск второй реальной брони.
  let created: BookingCreated;
  try {
    created = await client.createBooking({
      serviceId: court.serviceId,
      start: wantStart,
      // end из ответа API авторитетнее нашей арифметики
      end: typeof found.end === 'string' && found.end.length > 0 ? found.end : wantEnd,
      contact: profile.contact,
    });
  } catch (err) {
    if (isAmbiguousPostFailure(err)) {
      // Запрос мог дойти: бронь могла быть создана, а id/token до нас не добрались.
      return {
        ok: false,
        reason:
          `Ответ Reservio потерялся (${detail(err)}). Бронь МОГЛА быть создана — ` +
          'проверь почту и расписание клуба, прежде чем бронировать заново.',
      };
    }
    return { ok: false, reason: `Reservio отклонил бронь: ${detail(err)}` };
  }

  if (typeof created?.bookingId !== 'string' || created.bookingId.length === 0) {
    return {
      ok: false,
      reason:
        'Reservio ответил без id брони — бронь могла быть создана, но её id потерян. ' +
        'Проверь почту и расписание клуба вручную.',
    };
  }

  const token = typeof created.token === 'string' ? created.token : '';
  if (token === '') log(`bookNow: в ответе нет token — отменить бронь через API будет нельзя`);

  const booking: StoredBooking = {
    profileId: profile.id,
    date,
    time,
    court: court.name,
    bookingId: created.bookingId,
    token,
    state: typeof created.state === 'string' && created.state.length > 0 ? created.state : 'confirmed',
    createdAt: tbilisiStamp(now()),
  };

  // Бронь в Reservio уже есть — упавший state этого не отменяет. Возвращаем
  // ok:true вместе с token: в этот момент результат функции — единственный след
  // брони, и без него её нечем отменить.
  try {
    await state.saveBooking(booking);
  } catch (err) {
    log(`bookNow: ВНИМАНИЕ — бронь ${booking.bookingId} создана, но не сохранена в state: ${detail(err)}`);
  }

  // Напоминание — приятный бонус, а не часть брони: любое его падение глотаем.
  if (deps.scheduleReminder) {
    try {
      await deps.scheduleReminder(booking);
    } catch (err) {
      log(`bookNow: напоминание для ${booking.bookingId} не запланировано: ${detail(err)}`);
    }
  }

  return { ok: true, booking };
}
