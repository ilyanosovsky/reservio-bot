// «🔍 Слоты» — просмотр свободного времени: дата → корт → список свободных
// часов из availability. Ничего не бронирует.
//
// Мастер без серверного состояния: весь контекст (дата, корт) едет в
// callback_data, поэтому «Назад» — это просто переход на шаг с меньшим числом
// параметров. Все шаги, кроме первого, перерисовывают ТО ЖЕ сообщение.

import type { InlineKeyboard } from 'grammy';
import type { BotContext, BotDeps } from '../context.js';
import {
  courtByIndex,
  formatSlotsCourtsStep,
  formatSlotsDatesStep,
  formatSlotsList,
  upcomingDates,
} from '../format.js';
import { cbSlotsBackDates, cbSlotsCourt, cbSlotsDate } from '../parse.js';
import { UI_DAYS_AHEAD, backKeyboard, courtKeyboard, dateKeyboard, edit, reply } from '../ui.js';
import { nowOf } from './shared.js';

/** Шаг 0. Даты считаются от «сейчас» при каждом показе — в том числе на «Назад». */
function datesView(deps: BotDeps): { text: string; keyboard: InlineKeyboard } {
  const dates = upcomingDates(nowOf(deps), UI_DAYS_AHEAD);
  return { text: formatSlotsDatesStep(), keyboard: dateKeyboard(dates, cbSlotsDate) };
}

export async function showSlotDates(ctx: BotContext, deps: BotDeps): Promise<void> {
  const { text, keyboard } = datesView(deps);
  await reply(ctx, text, keyboard);
}

/** «Назад» с выбора корта: то же сообщение, а не новое. */
export async function backToSlotDates(ctx: BotContext, deps: BotDeps): Promise<void> {
  const { text, keyboard } = datesView(deps);
  await edit(ctx, text, keyboard);
}

export async function showSlotCourts(ctx: BotContext, _deps: BotDeps, date: string): Promise<void> {
  await edit(
    ctx,
    formatSlotsCourtsStep(date),
    courtKeyboard((i) => cbSlotsCourt(date, i), cbSlotsBackDates()),
  );
}

export async function showSlots(
  ctx: BotContext,
  deps: BotDeps,
  date: string,
  courtIndex: number,
): Promise<void> {
  const court = courtByIndex(courtIndex);
  if (court === null) {
    await edit(ctx, '⚠️ Неизвестный корт — открой «🔍 Слоты» заново.');
    return;
  }
  const slots = await deps.client.getAvailability(court.serviceId, date);
  // Назад — к выбору корта с той же датой (кодировщик шага даты и есть этот шаг).
  await edit(ctx, formatSlotsList(court.name, date, slots), backKeyboard(cbSlotsDate(date)));
}
