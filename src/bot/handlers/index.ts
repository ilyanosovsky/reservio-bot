// Регистрация хендлеров бота.
//
// Устройство: reply-кнопки ловит bot.hears, ВСЕ inline-кнопки — один
// диспетчер на 'callback_query:data'. Единая точка входа гарантирует, что
// каждый callback получит answerCallbackQuery: иначе у пользователя на кнопке
// навсегда останется крутящийся спиннер, а он читает это как «бот завис».
//
// Порядок разбора ТЕКСТА (важен, проверяется тестами):
//  1. гейт мастера профиля — активный черновик съедает свободный текст;
//  2. команды и кнопки меню — они всегда значат ровно себя;
//  3. свободный запрос (handlers/free-query.ts) — ПОСЛЕДНИМ, как фолбэк.
// Иначе нажатие «⏰ Расписание» уезжало бы в платный API вместо расписания.
//
// Любое исключение в хендлере превращается в понятное сообщение (guard):
// молчаливый провал — худший баг этого проекта (CLAUDE.md).

import type { Composer, NextFunction } from 'grammy';
import { adminOnly } from '../auth.js';
import type { BotContext, BotDeps } from '../context.js';
import { escapeHtml } from '../format.js';
import { BTN } from '../menu.js';
import { parseCallbackData } from '../parse.js';
import { answer, edit, reply } from '../ui.js';
import { safeErrorText } from '../errors.js';
import { sendWelcome } from '../welcome.js';
import { ProfileDraftStore } from '../wizard-state.js';
import { commandArgs, logOf } from './shared.js';
import { showBookings } from './bookings.js';
import { handleFreeQuery } from './free-query.js';
import { backToSlotDates, showSlotCourts, showSlotDates, showSlots } from './slots.js';
import { backToBookDates, confirmBook, doBook, showBookCourts, showBookDates, showBookTimes } from './book.js';
import { confirmCancel, doCancel, showCancelList } from './cancel.js';
import { showSkips, toggleSkip } from './skip.js';
import {
  askDeleteRule,
  deleteRule,
  editRule,
  ruleWizardStep,
  showRulesList,
  showSchedule,
  toggleRule,
} from './schedule.js';
import {
  addProfile,
  addRule,
  cancelNothing,
  cancelProfileWizard,
  createProfileFromDraft,
  profileWizardGate,
  reissueInvite,
  showProfiles,
  startProfileWizard,
} from './profiles.js';

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
const SELF_ANSWERING = new Set(['skip-toggle', 'rule-toggle', 'rule-wizard', 'rule-delete']);

/** Право на админскую кнопку. Отказ — молча, как и везде в админской ветке. */
function isAdmin(ctx: BotContext, deps: BotDeps): boolean {
  if (ctx.state.profile.isAdmin === true) return true;
  logOf(deps)(`callback: админская кнопка от не-админа (профиль ${ctx.state.profile.id}) — молчим`);
  return false;
}

export function registerHandlers(bot: Composer<BotContext>, deps: BotDeps): void {
  const admin = adminOnly({ debug: logOf(deps) });
  // Черновики мастера профиля — один экземпляр на бота (в тестах свой на каждую
  // сборку: глобальный синглтон протекал бы между сценариями).
  const drafts = new ProfileDraftStore();

  const start: Handler = async (ctx) => sendWelcome(ctx, ctx.state.profile);

  // Гейт мастера стоит ПЕРЕД командами и кнопками: пока у админа висит
  // черновик, его свободный текст — это ответ на шаг, а не мимо пролетевшее
  // сообщение. Кнопки меню и команды гейт пропускает дальше (сбросив черновик),
  // поэтому «⏰ Расписание» из середины мастера работает как обычно.
  bot.on('message:text', async (ctx: BotContext, next: NextFunction) => {
    let eaten = false;
    try {
      eaten = await profileWizardGate(ctx, deps, drafts, ctx.message?.text ?? '');
    } catch (err) {
      // Мастер упал — сообщение съеденным не считаем, но и молчать нельзя.
      const detail = safeErrorText(err);
      logOf(deps)(`мастер профиля упал: ${detail}`);
      try {
        await reply(ctx, `⚠️ Не получилось: ${escapeHtml(detail)}`);
      } catch {
        // чат недоступен — ошибка уже в логе процесса
      }
      return;
    }
    if (!eaten) await next();
  });

  bot.command('start', guard(deps, start));
  bot.command('help', guard(deps, start));
  bot.command('menu', guard(deps, start));
  // Активный черновик /cancel съедает в гейте выше; сюда команда доходит,
  // только когда отменять нечего.
  bot.command('cancel', admin, guard(deps, cancelNothing));

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
        case 'slots-back-dates':
          return backToSlotDates(ctx, deps);
        case 'book-back-dates':
          return backToBookDates(ctx, deps);
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
        case 'rules-list':
          return showRulesList(ctx, deps);
        case 'rule-edit':
          return editRule(ctx, deps, cb.ruleId);
        case 'rule-delete-ask':
          return askDeleteRule(ctx, deps, cb.ruleId);
        case 'rule-delete':
          return deleteRule(ctx, deps, cb.ruleId);
        case 'rule-wizard':
          return ruleWizardStep(ctx, deps, cb.step, cb.draft);
        // Мастер профиля — админский. adminOnly навешивается на bot.hears и
        // bot.command, а диспетчер callback'ов один на всех, поэтому право
        // проверяем прямо здесь: не-админ получает ту же тишину, что и всегда
        // (спиннер ему уже погасили выше).
        case 'profile-new':
          if (!isAdmin(ctx, deps)) return;
          return startProfileWizard(ctx, deps, drafts);
        case 'profile-create':
          if (!isAdmin(ctx, deps)) return;
          return createProfileFromDraft(ctx, deps, drafts);
        case 'profile-cancel':
          if (!isAdmin(ctx, deps)) return;
          return cancelProfileWizard(ctx, deps, drafts);
        case 'profile-invite':
          if (!isAdmin(ctx, deps)) return;
          return reissueInvite(ctx, deps, cb.profileId);
        case 'close':
          return edit(ctx, '↩️ Отменено.');
        case 'noop':
          // Кнопка «✅ Бронируем» pre-drop сообщения: подтверждать нечего,
          // сообщение планировщика намеренно оставляем нетронутым.
          return;
        default: {
          // Недостижимо: тип never заставляет TypeScript отбить любой kind без
          // case выше. Ветка нужна именно поэтому — потерянный при рефакторинге
          // case иначе стал бы молча мёртвой кнопкой (спиннер погас, экран тот
          // же, в логе пусто), а это худший баг проекта (CLAUDE.md).
          const unhandled: never = cb;
          logOf(deps)(`callback: kind без обработчика — ${JSON.stringify(unhandled)}`);
          return;
        }
      }
    }),
  );

  // Свободный запрос — ПОСЛЕДНИЙ обработчик текста и единственный фолбэк.
  // Сюда доходит только то, что не съели мастер, команды и кнопки меню выше
  // (у grammY хендлер без next() обрывает цепочку). Кнопки этой ветки ведут в
  // уже зарегистрированный диспетчер callback'ов — своих kind у неё нет.
  bot.on('message:text', guard(deps, (ctx) => handleFreeQuery(ctx, deps)));
}
