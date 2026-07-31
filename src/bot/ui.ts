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
import { BOOKABLE_COURTS, formatDateShort } from './format.js';

/** Дат в ряду: три коротких («06.08 (чт)») влезают, четыре уже режутся. */
const DATES_PER_ROW = 2;

/** Горизонт клуба: сегодня + 7 суток вперёд (T+7 — последний доступный день). */
export const UI_DAYS_AHEAD = 8;

/** Подпись возврата на шаг назад. Одна на весь бот — её ищут глазами. */
export const BACK_LABEL = '⬅️ Назад';

/**
 * Дописывает «Назад» ОТДЕЛЬНЫМ последним рядом: рядом с кнопками выбора он бы
 * ловил случайные тапы. Заодно срезает пустой хвостовой ряд, который остаётся
 * после `.row()` у grammY.
 */
function withBack(kb: InlineKeyboard, backData?: string): InlineKeyboard {
  const rows = kb.inline_keyboard;
  while (rows.length > 0 && (rows[rows.length - 1]?.length ?? 0) === 0) rows.pop();
  if (backData !== undefined) kb.row().text(BACK_LABEL, backData);
  return kb;
}

/** Экран-результат без выбора (список слотов): один только возврат на шаг назад. */
export function backKeyboard(backData: string): InlineKeyboard {
  return new InlineKeyboard().text(BACK_LABEL, backData);
}

/** Первый шаг мастера — возвращаться некуда, «Назад» здесь нет. */
export function dateKeyboard(dates: string[], encode: (date: string) => string): InlineKeyboard {
  const kb = new InlineKeyboard();
  dates.forEach((date, i) => {
    kb.text(formatDateShort(date), encode(date));
    if ((i + 1) % DATES_PER_ROW === 0) kb.row();
  });
  return withBack(kb);
}

export function courtKeyboard(encode: (courtIndex: number) => string, backData?: string): InlineKeyboard {
  const kb = new InlineKeyboard();
  BOOKABLE_COURTS.forEach((court, i) => {
    kb.text(court.name, encode(i)).row();
  });
  return withBack(kb, backData);
}

/** Времена — по три в ряд: их бывает 15 на день. */
export function timeKeyboard(
  times: string[],
  encode: (time: string) => string,
  backData?: string,
): InlineKeyboard {
  const kb = new InlineKeyboard();
  times.forEach((time, i) => {
    kb.text(time, encode(time));
    if ((i + 1) % 3 === 0) kb.row();
  });
  return withBack(kb, backData);
}

export function confirmKeyboard(
  yesData: string,
  noData: string,
  yesLabel = '✅ Да',
  backData?: string,
): InlineKeyboard {
  return withBack(new InlineKeyboard().text(yesLabel, yesData).text('↩️ Отмена', noData), backData);
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
 * «message is not modified» — Telegram отвечает так на редактирование в тот же
 * самый текст. Это норма мастера: двойной тап по «Назад» или по кнопке шага, на
 * котором уже стоишь. Экран уже такой, какой просили, — жаловаться не на что.
 */
export function isNotModifiedError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { description?: unknown; message?: unknown };
  const description = typeof e.description === 'string' ? e.description : '';
  const message = typeof e.message === 'string' ? e.message : '';
  return `${description} ${message}`.toLowerCase().includes('message is not modified');
}

/**
 * Заменяет текст сообщения, к которому прикреплена нажатая кнопка. Если Telegram
 * не дал отредактировать (сообщение старое), шлём новое — пользователь обязан
 * увидеть результат нажатия. Исключение — «текст не изменился»: новое сообщение
 * тут стало бы дублем экрана, поэтому такую ошибку глотаем молча.
 */
export async function edit(ctx: BotContext, text: string, keyboard?: InlineKeyboard): Promise<void> {
  const extra = {
    parse_mode: 'HTML' as const,
    ...(keyboard === undefined ? {} : { reply_markup: keyboard }),
  };
  try {
    await ctx.editMessageText(text, extra);
  } catch (err) {
    if (isNotModifiedError(err)) return;
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
