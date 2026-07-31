// «🔍 Слоты» — просмотр свободного времени: дата → корт → список свободных
// часов из availability. Ничего не бронирует.

import type { BotContext, BotDeps } from '../context.js';
import { courtByIndex, formatSlotsList, upcomingDates } from '../format.js';
import { cbSlotsCourt, cbSlotsDate } from '../parse.js';
import { UI_DAYS_AHEAD, courtKeyboard, dateKeyboard, edit, reply } from '../ui.js';
import { nowOf } from './shared.js';

export async function showSlotDates(ctx: BotContext, deps: BotDeps): Promise<void> {
  const dates = upcomingDates(nowOf(deps), UI_DAYS_AHEAD);
  await reply(ctx, '🔍 <b>Свободные слоты</b>\n\nВыбери дату:', dateKeyboard(dates, cbSlotsDate));
}

export async function showSlotCourts(ctx: BotContext, _deps: BotDeps, date: string): Promise<void> {
  await edit(ctx, '🔍 Выбери корт:', courtKeyboard((i) => cbSlotsCourt(date, i)));
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
  await edit(ctx, formatSlotsList(court.name, date, slots));
}
