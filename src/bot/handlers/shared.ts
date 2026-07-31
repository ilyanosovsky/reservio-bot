// Общие мелочи хендлеров. Ничего доменного: только «сейчас», лог и поиск
// брони профиля по id.

import type { BotContext, BotDeps } from '../context.js';
import type { StoredBooking } from '../../core/state.js';

export function nowOf(deps: BotDeps): Date {
  return deps.now?.() ?? new Date();
}

export function logOf(deps: BotDeps): (msg: string) => void {
  return deps.log ?? ((): void => {});
}

/**
 * Аргументы команды: всё, что после `/add_profile`. У bot.command ctx.match —
 * строка, но базовый тип Context допускает и RegExpMatchArray (bot.hears),
 * поэтому сужаем явно, а не приведением.
 */
export function commandArgs(ctx: BotContext): string {
  return typeof ctx.match === 'string' ? ctx.match : '';
}

/** chat_id текущего апдейта (у callback_query chat приходит из message). */
export function chatIdOf(ctx: BotContext): string | undefined {
  const id = ctx.chat?.id ?? ctx.from?.id;
  return id === undefined ? undefined : String(id);
}

/**
 * Бронь профиля по bookingId. Ищем ТОЛЬКО среди броней самого профиля: иначе
 * подделанная callback_data позволила бы отменить чужую бронь.
 */
export async function findOwnBooking(
  deps: BotDeps,
  profileId: string,
  bookingId: string,
): Promise<StoredBooking | null> {
  const all = await deps.state.listBookings(profileId);
  return all.find((b) => b.bookingId === bookingId) ?? null;
}
