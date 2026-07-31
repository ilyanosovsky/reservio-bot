// «❌ Отменить бронь» — отмена активной брони профиля.
//
// Инварианты:
//  - отменяем только СВОИ брони: bookingId из callback_data ищется среди
//    броней профиля (findOwnBooking), а не берётся на веру;
//  - дедлайн клуба (час до начала) проверяем сами и объясняем по-человечески;
//  - без сохранённого guest-token отмена через API невозможна (PROTOCOL.md) —
//    честно говорим об этом и отправляем к письму-подтверждению;
//  - успех отмены = client.cancelBooking не бросил (он сам проверяет
//    state === 'canceled' в ответе), только после этого markCanceled в state.

import type { BotContext, BotDeps } from '../context.js';
import {
  activeBookings,
  bookingButtonLabel,
  cancelDeadlinePassed,
  formatCancelConfirm,
  formatCancelSuccess,
  formatCancelTooLate,
  formatNoToken,
  humanizeCancelError,
} from '../format.js';
import { CB_CLOSE, cbCancelConfirm, cbCancelPick } from '../parse.js';
import { InlineKeyboard } from 'grammy';
import { confirmKeyboard, edit, reply } from '../ui.js';
import { errorFields, safeErrorText } from '../errors.js';
import { findOwnBooking, logOf, nowOf } from './shared.js';

const GONE = '⚠️ Такой брони у тебя нет — открой «❌ Отменить бронь» заново.';

export async function showCancelList(ctx: BotContext, deps: BotDeps): Promise<void> {
  const rows = activeBookings(await deps.state.listBookings(ctx.state.profile.id), nowOf(deps));
  if (rows.length === 0) {
    await reply(ctx, '❌ <b>Отмена брони</b>\n\nАктивных броней нет.');
    return;
  }
  const kb = new InlineKeyboard();
  for (const b of rows) kb.text(bookingButtonLabel(b), cbCancelPick(b.bookingId)).row();
  await reply(ctx, '❌ <b>Отмена брони</b>\n\nВыбери бронь:', kb);
}

export async function confirmCancel(ctx: BotContext, deps: BotDeps, bookingId: string): Promise<void> {
  const booking = await findOwnBooking(deps, ctx.state.profile.id, bookingId);
  if (booking === null || booking.state === 'canceled') {
    await edit(ctx, GONE);
    return;
  }
  if (cancelDeadlinePassed(booking.date, booking.time, nowOf(deps))) {
    await edit(ctx, formatCancelTooLate(booking));
    return;
  }
  if (booking.token === '') {
    await edit(ctx, formatNoToken(booking));
    return;
  }
  await edit(ctx, formatCancelConfirm(booking), confirmKeyboard(cbCancelConfirm(bookingId), CB_CLOSE, '❌ Отменить'));
}

export async function doCancel(ctx: BotContext, deps: BotDeps, bookingId: string): Promise<void> {
  const booking = await findOwnBooking(deps, ctx.state.profile.id, bookingId);
  if (booking === null || booking.state === 'canceled') {
    await edit(ctx, GONE);
    return;
  }
  if (cancelDeadlinePassed(booking.date, booking.time, nowOf(deps))) {
    await edit(ctx, formatCancelTooLate(booking));
    return;
  }
  if (booking.token === '') {
    await edit(ctx, formatNoToken(booking));
    return;
  }

  try {
    await deps.client.cancelBooking(booking.bookingId, booking.token);
  } catch (err) {
    // Сырой текст Reservio в чат не пускаем: в нём может оказаться URL с token.
    logOf(deps)(`отмена ${booking.bookingId} не удалась: ${safeErrorText(err)}`);
    await edit(ctx, `❌ <b>Не отменили</b>\n\n${humanizeCancelError(errorFields(err))}`);
    return;
  }

  // Отмена в Reservio прошла — теперь state. Если тут упадёт, бронь всё равно
  // отменена: показываем успех и предупреждение, врать про «не отменили» нельзя.
  try {
    await deps.state.markCanceled(booking.bookingId);
  } catch (err) {
    logOf(deps)(`markCanceled ${booking.bookingId} упал: ${safeErrorText(err)}`);
    await edit(ctx, `${formatCancelSuccess(booking)}\n\n⚠️ Не смог обновить базу — бронь может ещё показываться в списке.`);
    return;
  }
  await edit(ctx, formatCancelSuccess(booking));
}
