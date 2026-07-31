// «📅 Мои брони» — активные брони профиля из общего state (той же таблицы,
// куда пишут дроп-джобы). Список Reservio гостю недоступен (403, PROTOCOL.md),
// поэтому единственный источник правды здесь — наш state.

import type { BotContext, BotDeps } from '../context.js';
import { formatBookingsList } from '../format.js';
import { reply } from '../ui.js';
import { nowOf } from './shared.js';

export async function showBookings(ctx: BotContext, deps: BotDeps): Promise<void> {
  const bookings = await deps.state.listBookings(ctx.state.profile.id);
  await reply(ctx, formatBookingsList(bookings, nowOf(deps)));
}
