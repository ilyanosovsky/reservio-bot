// «📆 Бронировать» — бронь по запросу: дата → корт → время → подтверждение →
// bookNow. Время предлагается ТОЛЬКО из реально свободных слотов, а сам POST
// делает src/core/book-now.ts (там же проверка занятости и дедупликация).
//
// Подтверждение обязательно: bookNow создаёт настоящую бронь, случайный тап по
// кнопке не должен стоить корта.

import type { BotContext, BotDeps } from '../context.js';
import type { StoredBooking } from '../../core/state.js';
import { contactOf } from '../context.js';
import {
  courtByIndex,
  formatBookingConfirm,
  formatBookingFailure,
  formatBookingSuccess,
  freeTimes,
  upcomingDates,
} from '../format.js';
import { CB_CLOSE, cbBookConfirm, cbBookCourt, cbBookDate, cbBookTime } from '../parse.js';
import { UI_DAYS_AHEAD, confirmKeyboard, courtKeyboard, dateKeyboard, edit, reply, timeKeyboard } from '../ui.js';
import { chatIdOf, logOf, nowOf } from './shared.js';

export async function showBookDates(ctx: BotContext, deps: BotDeps): Promise<void> {
  const dates = upcomingDates(nowOf(deps), UI_DAYS_AHEAD);
  await reply(ctx, '📆 <b>Бронирование</b>\n\nВыбери дату:', dateKeyboard(dates, cbBookDate));
}

export async function showBookCourts(ctx: BotContext, _deps: BotDeps, date: string): Promise<void> {
  await edit(ctx, '📆 Выбери корт:', courtKeyboard((i) => cbBookCourt(date, i)));
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
  const times = freeTimes(await deps.client.getAvailability(court.serviceId, date));
  if (times.length === 0) {
    await edit(ctx, `📆 <b>${court.name}</b>\n\nСвободных слотов на эту дату нет.`);
    return;
  }
  await edit(
    ctx,
    `📆 <b>${court.name}</b>\n\nВыбери время:`,
    timeKeyboard(times, (time) => cbBookTime(date, courtIndex, time)),
  );
}

export async function confirmBook(
  ctx: BotContext,
  _deps: BotDeps,
  date: string,
  courtIndex: number,
  time: string,
): Promise<void> {
  const court = courtByIndex(courtIndex);
  if (court === null) {
    await edit(ctx, '⚠️ Неизвестный корт — открой «📆 Бронировать» заново.');
    return;
  }
  await edit(
    ctx,
    formatBookingConfirm(date, time, court.name),
    confirmKeyboard(cbBookConfirm(date, courtIndex, time), CB_CLOSE, '✅ Бронировать'),
  );
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
