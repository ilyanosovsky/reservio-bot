// «📆 Бронировать» — бронь по запросу: дата → корт → время → подтверждение →
// bookNow. Время предлагается ТОЛЬКО из реально свободных слотов, а сам POST
// делает src/core/book-now.ts (там же проверка занятости и дедупликация).
//
// Подтверждение обязательно: bookNow создаёт настоящую бронь, случайный тап по
// кнопке не должен стоить корта.
//
// Мастер без серверного состояния: дата и корт едут в callback_data, поэтому
// «Назад» — переход на шаг с меньшим числом параметров. Времена на своём шаге
// ВСЕГДА перезапрашиваются из availability: за время раздумий слот мог уйти.

import type { InlineKeyboard } from 'grammy';
import type { BotContext, BotDeps } from '../context.js';
import type { StoredBooking } from '../../core/state.js';
import { contactOf } from '../context.js';
import {
  courtByIndex,
  formatBookCourtsStep,
  formatBookDatesStep,
  formatBookNoTimes,
  formatBookTimesStep,
  formatBookingConfirm,
  formatBookingFailure,
  formatBookingSuccess,
  freeTimes,
  upcomingDates,
} from '../format.js';
import { CB_CLOSE, cbBookBackDates, cbBookConfirm, cbBookCourt, cbBookDate, cbBookTime } from '../parse.js';
import {
  UI_DAYS_AHEAD,
  backKeyboard,
  confirmKeyboard,
  courtKeyboard,
  dateKeyboard,
  edit,
  reply,
  timeKeyboard,
} from '../ui.js';
import { chatIdOf, logOf, nowOf } from './shared.js';

/** Шаг 0. Даты считаются от «сейчас» при каждом показе — в том числе на «Назад». */
function datesView(deps: BotDeps): { text: string; keyboard: InlineKeyboard } {
  const dates = upcomingDates(nowOf(deps), UI_DAYS_AHEAD);
  return { text: formatBookDatesStep(), keyboard: dateKeyboard(dates, cbBookDate) };
}

export async function showBookDates(ctx: BotContext, deps: BotDeps): Promise<void> {
  const { text, keyboard } = datesView(deps);
  await reply(ctx, text, keyboard);
}

/** «Назад» с выбора корта: то же сообщение, а не новое. */
export async function backToBookDates(ctx: BotContext, deps: BotDeps): Promise<void> {
  const { text, keyboard } = datesView(deps);
  await edit(ctx, text, keyboard);
}

export async function showBookCourts(ctx: BotContext, _deps: BotDeps, date: string): Promise<void> {
  await edit(
    ctx,
    formatBookCourtsStep(date),
    courtKeyboard((i) => cbBookCourt(date, i), cbBookBackDates()),
  );
}

export async function showBookTimes(
  ctx: BotContext,
  deps: BotDeps,
  date: string,
  courtIndex: number,
): Promise<void> {
  const court = courtByIndex(courtIndex);
  if (court === null) {
    await edit(ctx, '⚠️ Неизвестный корт — открой «📆 Бронировать» заново.');
    return;
  }
  // Назад — к выбору корта с той же датой.
  const back = cbBookDate(date);
  const times = freeTimes(await deps.client.getAvailability(court.serviceId, date));
  if (times.length === 0) {
    await edit(ctx, formatBookNoTimes(date, court.name), backKeyboard(back));
    return;
  }
  await edit(
    ctx,
    formatBookTimesStep(date, court.name),
    timeKeyboard(times, (time) => cbBookTime(date, courtIndex, time), back),
  );
}

/**
 * Экран подтверждения: текст + клавиатура, без отправки. Вынесен отдельно,
 * потому что ведут к нему ДВА пути — мастер «📆 Бронировать» (правит своё
 * сообщение) и свободный запрос (шлёт новое, handlers/free-query.ts). Экран и
 * callback-схема при этом обязаны быть одни и те же: настоящую бронь создаёт
 * только кнопка `bk~y` (doBook), и другого способа её создать в боте нет.
 *
 * null — корта с таким индексом нет (подделанная или устаревшая кнопка).
 */
export function bookingConfirmView(
  date: string,
  courtIndex: number,
  time: string,
): { text: string; keyboard: InlineKeyboard } | null {
  const court = courtByIndex(courtIndex);
  if (court === null) return null;
  return {
    text: formatBookingConfirm(date, time, court.name),
    // Назад — к выбору времени той же даты и корта: showBookTimes сходит в
    // availability заново, устаревший список времён не всплывёт.
    keyboard: confirmKeyboard(
      cbBookConfirm(date, courtIndex, time),
      CB_CLOSE,
      '✅ Бронировать',
      cbBookCourt(date, courtIndex),
    ),
  };
}

export async function confirmBook(
  ctx: BotContext,
  _deps: BotDeps,
  date: string,
  courtIndex: number,
  time: string,
): Promise<void> {
  const view = bookingConfirmView(date, courtIndex, time);
  if (view === null) {
    await edit(ctx, '⚠️ Неизвестный корт — открой «📆 Бронировать» заново.');
    return;
  }
  await edit(ctx, view.text, view.keyboard);
}

export async function doBook(
  ctx: BotContext,
  deps: BotDeps,
  date: string,
  courtIndex: number,
  time: string,
): Promise<void> {
  const court = courtByIndex(courtIndex);
  if (court === null) {
    await edit(ctx, '⚠️ Неизвестный корт — открой «📆 Бронировать» заново.');
    return;
  }
  const profile = ctx.state.profile;
  const chatId = chatIdOf(ctx);

  // Напоминание планируем на тот чат, из которого нажали кнопку. Нет
  // планировщика или chat_id — бронируем без напоминания: бронь важнее.
  const scheduleReminder =
    deps.scheduleReminder !== undefined && chatId !== undefined
      ? async (booking: StoredBooking): Promise<void> => {
          await deps.scheduleReminder?.(booking, chatId);
        }
      : undefined;

  await edit(ctx, `⏳ Бронирую ${court.name} на ${time}…`);

  const result = await deps.bookNow(
    { id: profile.id, contact: contactOf(profile) },
    { date, time, court: court.name },
    {
      client: deps.client,
      state: deps.state,
      ...(scheduleReminder === undefined ? {} : { scheduleReminder }),
    },
  );

  if (result.ok) {
    logOf(deps)(`бронь по запросу: профиль ${profile.id}, ${date} ${time}, ${court.name}`);
    await edit(ctx, formatBookingSuccess(result.booking));
    return;
  }
  await edit(ctx, formatBookingFailure(date, time, court.name, result.reason));
}
