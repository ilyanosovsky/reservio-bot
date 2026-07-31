/**
 * Сборка бота: auth-middleware ПЕРВЫМ, хендлеры после него.
 *
 * Отдельный модуль ради тестируемости: инвариант «чужому чату — полная тишина»
 * держится ровно на порядке этих двух вызовов, а index.ts запускает polling
 * прямо при импорте и в тестах не поднимается. Здесь порядок зафиксирован
 * кодом и проверяется в tests/bot-auth.test.ts.
 */

import type { Composer } from 'grammy';
import { authMiddleware, type AuthOptions } from './auth.js';
import type { BotContext, BotDeps } from './context.js';
import { registerHandlers } from './handlers/index.js';

export function installBot(bot: Composer<BotContext>, deps: BotDeps, opts: AuthOptions = {}): void {
  // Ни один хендлер не имеет права регистрироваться до authMiddleware: любой
  // ответ подтверждает чужому чату, что бот жив и дотягивается до него.
  bot.use(authMiddleware(deps.profiles, opts));
  registerHandlers(bot, deps);
}
