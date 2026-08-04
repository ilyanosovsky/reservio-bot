/**
 * Сборка бота: приглашения и auth-middleware ПЕРВЫМИ, хендлеры после них.
 *
 * Отдельный модуль ради тестируемости: инвариант «чужому чату — полная тишина»
 * держится ровно на порядке этих вызовов, а index.ts запускает polling
 * прямо при импорте и в тестах не поднимается. Здесь порядок зафиксирован
 * кодом и проверяется в tests/bot-auth.test.ts и tests/bot-invite.test.ts.
 *
 * Порядок именно такой:
 *  1. inviteMiddleware — единственное исключение из тишины. Чат, переходящий по
 *     ссылке-приглашению, профиля ещё НЕ имеет, поэтому после authMiddleware до
 *     него бы просто не дошло. Всё, что не `/start inv_<code>`, он пропускает
 *     дальше нетронутым, а любая своя ошибка у него заканчивается тишиной.
 *  2. authMiddleware — allowlist chat_id → профиль.
 *  3. хендлеры — ни один не имеет права регистрироваться раньше: любой ответ
 *     подтверждает чужому чату, что бот жив и дотягивается до него.
 */

import type { Composer } from 'grammy';
import { authMiddleware, inviteMiddleware, type AuthOptions } from './auth.js';
import type { BotContext, BotDeps } from './context.js';
import { registerHandlers } from './handlers/index.js';

export function installBot(bot: Composer<BotContext>, deps: BotDeps, opts: AuthOptions = {}): void {
  bot.use(inviteMiddleware({ invites: deps.invites, profiles: deps.profiles }, opts));
  bot.use(authMiddleware(deps.profiles, opts));
  registerHandlers(bot, deps);
}
