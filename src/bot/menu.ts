/**
 * Главное меню бота — reply-клавиатура (постоянная, под полем ввода).
 * Тексты кнопок это одновременно и триггеры bot.hears(), поэтому живут одной
 * константой: разъехавшиеся подпись и триггер = кнопка, которая молча ничего
 * не делает.
 */

import { Keyboard } from 'grammy';

export const BTN = {
  bookings: '📅 Мои брони',
  slots: '🔍 Слоты',
  book: '📆 Бронировать',
  cancel: '❌ Отменить бронь',
  skip: '⏭ Скип',
  schedule: '⏰ Расписание',
  profiles: '👤 Профили',
} as const;

/** Кнопка «👤 Профили» есть только у админа — остальным она даже не показывается. */
export function mainMenu(isAdmin: boolean): Keyboard {
  const kb = new Keyboard()
    .text(BTN.bookings)
    .text(BTN.slots)
    .row()
    .text(BTN.book)
    .text(BTN.cancel)
    .row()
    .text(BTN.skip)
    .text(BTN.schedule);
  if (isAdmin) kb.row().text(BTN.profiles);
  return kb.resized().persistent();
}
