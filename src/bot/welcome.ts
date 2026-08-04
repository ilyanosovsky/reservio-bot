/**
 * Приветствие с главным меню — одно на два входа: обычный /start (хендлеры) и
 * привязку чата по ссылке-приглашению (auth.ts).
 *
 * Отдельный модуль, потому что auth.ts не имеет права зависеть от хендлеров:
 * handlers/index.ts сам импортирует из auth.ts (adminOnly), и импорт обратно
 * замкнул бы цикл. Здесь только format.ts и menu.ts.
 *
 * Почему приглашение отвечает само, а не «проваливается» в обычный хендлер
 * /start: приглашение обязано закончиться ровно одним видимым результатом.
 * Полагаться на то, что апдейт доедет до bot.command('start') (а это зависит от
 * entities в сообщении Telegram), значит рискнуть привязать чат и промолчать —
 * человек останется с ботом, который на него уже подписан, но молчит.
 */

import type { BotContext } from './context.js';
import type { ProfileRow } from '../core/repos.js';
import { formatInviteWelcome, formatWelcome } from './format.js';
import { mainMenu } from './menu.js';

/** `invited` — первое сообщение после привязки чата: текст подробнее. */
export async function sendWelcome(ctx: BotContext, profile: ProfileRow, invited = false): Promise<void> {
  const text = invited ? formatInviteWelcome(profile.label) : formatWelcome(profile.label, profile.isAdmin);
  await ctx.reply(text, {
    parse_mode: 'HTML',
    // Клавиатура зависит от профиля: «👤 Профили» есть только у админа, а
    // приглашённый игрок админом не становится никогда.
    reply_markup: mainMenu(profile.isAdmin),
  });
}
