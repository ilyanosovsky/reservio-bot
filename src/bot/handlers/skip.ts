// «⏭ Скип» — пропуск дня ИГРЫ. Планировщик (src/trigger/daily-planner.ts)
// смотрит skip по целевой дате T+7, и бронь-джоба перепроверяет его перед
// окном, поэтому и меню показывает даты игры: сегодняшний дроп целится в T+7,
// завтрашний — в T+8 и так далее. Пропускать вчерашние дропы бессмысленно.
//
// Формат callback_data — `skip:{date}` (контракт фазы 3): те же кнопки шлёт
// pre-drop сообщение планировщика. Поэтому перерисовываем сообщение ТОЛЬКО
// если это наше меню; в чужом сообщении ограничиваемся всплывающим ответом.
// И по той же причине тап из pre-drop сообщения только СТАВИТ скип, никогда не
// снимает (см. skipAction): «Пропустить» — не переключатель.

import type { BotContext, BotDeps } from '../context.js';
import { SKIP_MENU_TITLE, formatDateShort, formatSkipsList, skipButtonLabel, upcomingDates } from '../format.js';
import { cbSkip } from '../parse.js';
import { InlineKeyboard } from 'grammy';
import { answer, edit, reply } from '../ui.js';
import { logOf, nowOf } from './shared.js';

/** Первая дата меню — ближайший день игры: его дроп случится сегодня вечером. */
const SKIP_FIRST_OFFSET_DAYS = 7;
const SKIP_DAYS = 7;

function skipKeyboard(dates: string[], skipped: ReadonlySet<string>): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const date of dates) kb.text(skipButtonLabel(date, skipped.has(date)), cbSkip(date)).row();
  return kb;
}

async function skippedSet(deps: BotDeps, profileId: string): Promise<Set<string>> {
  return new Set(await deps.skips.listUpcoming(profileId));
}

export async function showSkips(ctx: BotContext, deps: BotDeps): Promise<void> {
  const dates = upcomingDates(nowOf(deps), SKIP_DAYS, SKIP_FIRST_OFFSET_DAYS);
  const skipped = await skippedSet(deps, ctx.state.profile.id);
  await reply(ctx, formatSkipsList(dates, skipped), skipKeyboard(dates, skipped));
}

/** Наше ли это меню: у pre-drop сообщения планировщика кнопки те же. */
function isSkipMenu(ctx: BotContext): boolean {
  const message = ctx.callbackQuery?.message;
  const text = message !== undefined && 'text' in message ? message.text : undefined;
  return typeof text === 'string' && text.includes(SKIP_MENU_TITLE);
}

/**
 * Что делает тап по кнопке `skip:{date}`.
 *
 * В НАШЕМ меню кнопка подписана «⏭/▶️» и явно выглядит переключателем — там
 * toggle уместен. В pre-drop сообщении планировщика кнопка называется
 * «⏭ Пропустить», и второй тап по ней обязан быть идемпотентным: ответ на
 * callback приходит только после двух round-trip в Supabase, человек на
 * мобильной сети легко жмёт дважды — и «отменил игру» превращалось бы в
 * «бронируем как обычно», о чём он узнал бы только вечером из отчёта.
 */
export type SkipAction = 'add' | 'remove' | 'keep';

export function skipAction(wasSkipped: boolean, fromMenu: boolean): SkipAction {
  if (!wasSkipped) return 'add';
  return fromMenu ? 'remove' : 'keep';
}

export async function toggleSkip(ctx: BotContext, deps: BotDeps, date: string): Promise<void> {
  const profileId = ctx.state.profile.id;
  const fromMenu = isSkipMenu(ctx);
  const skipped = await skippedSet(deps, profileId);
  const action = skipAction(skipped.has(date), fromMenu);

  if (action === 'remove') {
    await deps.skips.remove(profileId, date);
    skipped.delete(date);
  } else if (action === 'add') {
    await deps.skips.add(profileId, date);
    skipped.add(date);
  }
  logOf(deps)(`скип ${date} для ${profileId}: ${{ add: 'поставлен', remove: 'снят', keep: 'уже стоял' }[action]}`);

  const toast = action === 'remove' ? `Играем ${formatDateShort(date)}` : `Пропускаем ${formatDateShort(date)}`;
  await answer(ctx, toast);

  if (fromMenu) {
    const dates = upcomingDates(nowOf(deps), SKIP_DAYS, SKIP_FIRST_OFFSET_DAYS);
    await edit(ctx, formatSkipsList(dates, skipped), skipKeyboard(dates, skipped));
    return;
  }
  // Сообщение планировщика не трогаем — план вечера должен остаться в истории.
  await reply(
    ctx,
    action === 'keep'
      ? `⏭ ${formatDateShort(date)} и так пропускаем — бронировать не будем. (Снять скип: кнопка «⏭ Скип» в меню.)`
      : `⏭ Ок, ${formatDateShort(date)} пропускаем — бронировать не будем.`,
  );
}
