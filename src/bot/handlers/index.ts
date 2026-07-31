// Регистрация хендлеров бота.
//
// Устройство: reply-кнопки ловит bot.hears, ВСЕ inline-кнопки — один
// диспетчер на 'callback_query:data'. Единая точка входа гарантирует, что
// каждый callback получит answerCallbackQuery: иначе у пользователя на кнопке
// навсегда останется крутящийся спиннер, а он читает это как «бот завис».
//
// Любое исключение в хендлере превращается в понятное сообщение (guard):
// молчаливый провал — худший баг этого проекта (CLAUDE.md).

import type { Composer } from 'grammy';
import { adminOnly } from '../auth.js';
import type { BotContext, BotDeps } from '../context.js';
import { escapeHtml, formatWelcome } from '../format.js';
import { BTN, mainMenu } from '../menu.js';
import { parseCallbackData } from '../parse.js';
import { answer, edit, reply } from '../ui.js';
import { safeErrorText } from '../errors.js';
import { commandArgs, logOf } from './shared.js';
import { showBookings } from './bookings.js';
import { showSlotCourts, showSlotDates, showSlots } from './slots.js';
import { confirmBook, doBook, showBookCourts, showBookDates, showBookTimes } from './book.js';
import { confirmCancel, doCancel, showCancelList } from './cancel.js';
import { showSkips, toggleSkip } from './skip.js';
import { showSchedule, toggleRule } from './schedule.js';
import { addProfile, addRule, showProfiles } from './profiles.js';

type Handler = (ctx: BotContext) => Promise<void>;

/**
 * Ошибка хендлера не должна оставлять человека без ответа. Текст перед отправкой
 * чистится от token/ключей (errors.ts): сетевые ошибки любят процитировать URL.
 */
function guard(deps: BotDeps, fn: Handler): Handler {
  return async (ctx: BotContext): Promise<void> => {
    try {
      await fn(ctx);
    } catch (err) {
      const detail = safeErrorText(err);
      logOf(deps)(`хендлер упал: ${detail}`);
      await answer(ctx);
      try {
        await reply(ctx, `⚠️ Не получилось: ${escapeHtml(detail)}`);
      } catch {
        // чат недоступен — сообщать больше некуда, ошибка уже в логе процесса
      }
    }
  };
}

/** Кнопки, которые сами показывают всплывающий ответ (toast) с итогом действия. */
const SELF_ANSWERING = new Set(['skip-toggle', 'rule-toggle']);

export function registerHandlers(bot: Composer<BotContext>, deps: BotDeps): void {
  const admin = adminOnly({ debug: logOf(deps) });

  const start: Handler = async (ctx) => {
    const profile = ctx.state.profile;
    await ctx.reply(formatWelcome(profile.label, profile.isAdmin), {
      parse_mode: 'HTML',
      reply_markup: mainMenu(profile.isAdmin),
    });
  };

  bot.command('start', guard(deps, start));
  bot.command('help', guard(deps, start));
  bot.command('menu', guard(deps, start));

  bot.hears(BTN.bookings, guard(deps, (ctx) => showBookings(ctx, deps)));
  bot.hears(BTN.slots, guard(deps, (ctx) => showSlotDates(ctx, deps)));
  bot.hears(BTN.book, guard(deps, (ctx) => showBookDates(ctx, deps)));
  bot.hears(BTN.cancel, guard(deps, (ctx) => showCancelList(ctx, deps)));
  bot.hears(BTN.skip, guard(deps, (ctx) => showSkips(ctx, deps)));
  bot.hears(BTN.schedule, guard(deps, (ctx) => showSchedule(ctx, deps)));

  // Админская ветка: не-админу adminOnly просто не пускает дальше — молча.
  bot.hears(BTN.profiles, admin, guard(deps, (ctx) => showProfiles(ctx, deps)));
  bot.command('add_profile', admin, guard(deps, (ctx) => addProfile(ctx, deps, commandArgs(ctx))));
  bot.command('add_rule', admin, guard(deps, (ctx) => addRule(ctx, deps, commandArgs(ctx))));

  bot.on(
    'callback_query:data',
    guard(deps, async (ctx) => {
      const raw = ctx.callbackQuery?.data ?? '';
      const cb = parseCallbackData(raw);

      if (cb === null) {
        // Чужая или устаревшая кнопка (например, из сообщения прошлой версии).
        // Спиннер гасим молча: спорить с пользователем не о чем.
        logOf(deps)('callback: неизвестные данные кнопки — гашу спиннер');
        await answer(ctx);
        return;
      }
      if (!SELF_ANSWERING.has(cb.kind)) await answer(ctx);

      switch (cb.kind) {
        case 'slots-date':
          return showSlotCourts(ctx, deps, cb.date);
        case 'slots-court':
          return showSlots(ctx, deps, cb.date, cb.courtIndex);
        case 'book-date':
          return showBookCourts(ctx, deps, cb.date);
        case 'book-court':
          return showBookTimes(ctx, deps, cb.date, cb.courtIndex);
        case 'book-time':
          return confirmBook(ctx, deps, cb.date, cb.courtIndex, cb.time);
        case 'book-confirm':
          return doBook(ctx, deps, cb.date, cb.courtIndex, cb.time);
        case 'cancel-pick':
          return confirmCancel(ctx, deps, cb.bookingId);
        case 'cancel-confirm':
          return doCancel(ctx, deps, cb.bookingId);
        case 'skip-toggle':
          return toggleSkip(ctx, deps, cb.date);
        case 'rule-toggle':
          return toggleRule(ctx, deps, cb.ruleId);
        case 'close':
          return edit(ctx, '↩️ Отменено.');
        case 'noop':
          // Кнопка «✅ Бронируем» pre-drop сообщения: подтверждать нечего,
          // сообщение планировщика намеренно оставляем нетронутым.
          return;
      }
    }),
  );
}
