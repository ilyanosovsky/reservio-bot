/**
 * Точка входа Telegram-бота (grammY, long-polling).
 *
 * Запуск: `pnpm bot` (= tsx src/bot/index.ts).
 *
 * Что здесь и только здесь: чтение env, сборка боевых зависимостей и запуск
 * polling. Вся логика живёт в чистых модулях (format/parse) и тонких хендлерах,
 * которые получают зависимости параметром — ни один из них в process.env
 * не заглядывает.
 *
 * Авторизация: allowlist `telegram_chat_id → профиль` в Supabase. Чужому чату
 * бот не отвечает ничего (src/bot/auth.ts).
 *
 * Приватность: секреты берём только по именам переменных, в stdout не печатаем.
 * chat_id в логах появляется лишь при BOT_DEBUG=true.
 */

import { readFileSync } from 'node:fs';
import { Bot } from 'grammy';
import { ProfilesRepo, SchedulesRepo, SkipsRepo } from '../core/repos.js';
import { SupabaseStateStore } from '../core/state-supabase.js';
import { ReservioClient } from '../reservio/client.js';
import { bookNow } from '../core/book-now.js';
import type { BotContext, BotDeps } from './context.js';
import { installBot } from './setup.js';
import { makeReminderScheduler } from './reminder.js';
import { safeErrorText } from './errors.js';

// мини-загрузчик .env (тот же паттерн, что в src/run-drop.ts — без зависимостей)
function loadDotEnv(): void {
  try {
    const path = new URL('../../.env', import.meta.url);
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch {
    // .env отсутствует — значит переменные заданы окружением напрямую
  }
}
loadDotEnv();

function required(name: string): string {
  const value = process.env[name]?.trim() ?? '';
  if (value === '') {
    throw new Error(`Не задана обязательная переменная окружения ${name} (см. .env.example)`);
  }
  return value;
}

function log(msg: string): void {
  console.log(`[bot] ${msg}`);
}

async function main(): Promise<void> {
  const token = required('TELEGRAM_BOT_TOKEN');
  const url = required('SUPABASE_URL');
  const serviceKey = required('SUPABASE_SERVICE_ROLE_KEY');
  const debugChatIds = (process.env.BOT_DEBUG ?? '').trim() === 'true';

  const repoOpts = { url, serviceKey };
  // undefined — trigger.dev не настроен: бот работает, просто без напоминаний.
  const scheduleReminder = makeReminderScheduler(process.env, log);
  const deps: BotDeps = {
    profiles: new ProfilesRepo(repoOpts),
    schedules: new SchedulesRepo(repoOpts),
    skips: new SkipsRepo(repoOpts),
    state: new SupabaseStateStore(repoOpts),
    client: new ReservioClient({ log }),
    bookNow,
    ...(scheduleReminder === undefined ? {} : { scheduleReminder }),
    log,
  };

  const bot = new Bot<BotContext>(token);

  // Ошибка, долетевшая сюда, уже не имеет адресата: хендлеры ловят свои сами
  // (guard в handlers/index.ts). Здесь только громкий лог — процесс не роняем,
  // иначе один битый апдейт уносит бота до утра.
  bot.catch((err) => {
    console.error(`[bot] необработанная ошибка апдейта: ${safeErrorText(err.error)}`);
  });

  // Порядок «auth, потом хендлеры» живёт в installBot и проверен тестами.
  installBot(bot, deps, { debug: log, exposeChatId: debugChatIds });

  const stop = (signal: string): void => {
    log(`получен ${signal}, останавливаюсь`);
    void bot.stop();
  };
  process.once('SIGINT', () => stop('SIGINT'));
  process.once('SIGTERM', () => stop('SIGTERM'));

  await bot.start({
    onStart: (me) => log(`запущен как @${me.username}, long-polling`),
  });
}

main().catch((err) => {
  console.error(`[bot] не смог стартовать: ${safeErrorText(err)}`);
  process.exit(1);
});
