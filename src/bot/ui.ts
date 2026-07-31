/**
 * Мелкие помощники интерфейса: сборка inline-клавиатур и безопасные обёртки
 * над ответами Telegram.
 *
 * Почему обёртки: `editMessageText` отвечает HTTP 400 на неизменившийся текст,
 * а `answerCallbackQuery` — на протухший (старше ~минуты) callback. Оба случая
 * абсолютно нормальны в жизни и не должны ронять хендлер: у пользователя иначе
 * навсегда останется крутящийся спиннер на кнопке.
 */

import { InlineKeyboard } from 'grammy';
import type { BotContext } from './context.js';
import { PADEL_COURTS, formatDateShort } from './format.js';

/** Дат в ряду: три коротких («06.08 (чт)») влезают, четыре уже режутся. */
const DATES_PER_ROW = 2;

/** Горизонт клуба: сегодня + 7 суток вперёд (T+7 — последний доступный день). */
export const UI_DAYS_AHEAD = 8;

export function dateKeyboard(dates: string[], encode: (date: string) => string): InlineKeyboard {
  const kb = new InlineKeyboard();
  dates.forEach((date, i) => {
    kb.text(formatDateShort(date), encode(date));
    if ((i + 1) % DATES_PER_ROW === 0) kb.row();
  });
  return kb;
}

export function courtKeyboard(encode: (courtIndex: number) => string): InlineKeyboard {
  const kb = new InlineKeyboard();
  PADEL_COURTS.forEach((court, i) => {
    kb.text(court.name, encode(i)).row();
  });
  return kb;
}

/** Времена — по три в ряд: их бывает 15 на день. */
export function timeKeyboard(times: string[], encode: (time: string) => string): InlineKeyboard {
  const kb = new InlineKeyboard();
  times.forEach((time, i) => {
    kb.text(time, encode(time));
    if ((i + 1) % 3 === 0) kb.row();
  });
  return kb;
}

export function confirmKeyboard(yesData: string, noData: string, yesLabel = '✅ Да'): InlineKeyboard {
  return new InlineKeyboard().text(yesLabel, yesData).text('↩️ Отмена', noData);
}

/** Гасит спиннер на кнопке. Никогда не бросает: протухший callback — норма. */
export async function answer(ctx: BotContext, text?: string): Promise<void> {
  try {
    await ctx.answerCallbackQuery(text === undefined ? undefined : { text });
  } catch {
    // callback устарел или уже отвечен — сообщать об этом некому и незачем
  }
}

/**
 * Заменяет текст сообщения, к которому прикреплена нажатая кнопка. Если Telegram
 * не дал отредактировать (сообщение старое, текст не изменился), шлём новое —
 * пользователь обязан увидеть результат нажатия.
 */
export async function edit(ctx: BotContext, text: string, keyboard?: InlineKeyboard): Promise<void> {
  const extra = {
    parse_mode: 'HTML' as const,
    ...(keyboard === undefined ? {} : { reply_markup: keyboard }),
  };
  try {
    await ctx.editMessageText(text, extra);
  } catch {
    try {
      await ctx.reply(text, extra);
    } catch {
      // чат недоступен (бот заблокирован) — дальше делать нечего
    }
  }
}

/** Ответ на обычное сообщение. HTML включён везде, тексты уже экранированы в format.ts. */
export async function reply(ctx: BotContext, text: string, keyboard?: InlineKeyboard): Promise<void> {
  await ctx.reply(text, {
    parse_mode: 'HTML',
    ...(keyboard === undefined ? {} : { reply_markup: keyboard }),
  });
}
