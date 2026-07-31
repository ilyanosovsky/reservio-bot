// Конфиг trigger.dev: проект proj_fxjnzqesxsicrpeuepzv. Таски подхватываются
// из ./src/trigger по `dirs` (см. ниже): book-drop, remind, drop-observe,
// daily-planner.
//
// ВАЖНО про cron. Единственный таск с расписанием — daily-planner
// (`schedules.task`, cron '30 16 * * *' = 20:30 Тбилиси). Деплой РЕГИСТРИРУЕТ
// это расписание, и крон начнёт тикать — но забронировать он ничего не может:
// run() первым делом читает settings.planner_enabled из Supabase и при любом
// значении, кроме точно 'true', молча выходит. То есть запрет CLAUDE.md
// («никаких автоматических бронирований по cron до фазы 4») держится не
// отсутствием крона, а флагом в БД, который выставляется руками по явному
// одобрению пользователя (docs/wiki/Runbook.md → «Планировщик»).
//
// Остальные таски запускаются только вручную: дашборд, CLI,
// mcp__trigger__trigger_task — в том числе отложенно (`delay`), см.
// docs/wiki/Runbook.md → «Вечерний облачный прогон».
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@trigger.dev/sdk';
import { syncEnvVars } from '@trigger.dev/build/extensions/core';

/**
 * Единственные переменные, которые деплой уносит в облако. Список закрытый:
 * всё остальное из .env (TRIGGER_SECRET_KEY_*, ANTHROPIC_API_KEY, локальные
 * эксперименты) остаётся на машине.
 *
 * Следствие: в облаке существует только профиль по умолчанию (`ilya`).
 * Дополнительные профили читаются из PROFILE_<K>_* (см. src/core/profiles.ts),
 * этих имён здесь нет — добавлять их в список осознанно, вместе с профилем.
 */
const CLOUD_ENV_ALLOWLIST = [
  'CLIENT_NAME',
  'CLIENT_EMAIL',
  'CLIENT_PHONE',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_CHAT_ID',
] as const;

/**
 * Эти значения пишутся в дашборд trigger.dev «вслепую» (isSecret) и потом не
 * показываются: персональные данные профиля и токены. SUPABASE_URL —
 * публичный адрес проекта, его оставляем читаемым, чтобы глазами сверять
 * окружение.
 */
const SECRET_ENV_KEYS = new Set<string>([
  'CLIENT_NAME',
  'CLIENT_EMAIL',
  'CLIENT_PHONE',
  'SUPABASE_SERVICE_ROLE_KEY',
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_CHAT_ID',
]);

/** Мини-парсер .env (тот же паттерн, что в spike-reservio.ts; dotenv не тянем). */
function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split('\n')) {
    // строки-комментарии (#...) и пустые под регулярку не подходят
    const m = raw.replace(/\r$/, '').match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    out[m[1]!] = m[2]!.trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

/**
 * .env лежит рядом с этим конфигом, но деплой могут запустить из другого cwd —
 * поэтому пробуем оба пути. Файла нет (CI) — не беда: значения возьмутся из
 * process.env.
 */
function readDotEnv(): Record<string, string> {
  const candidates = [join(process.cwd(), '.env')];
  try {
    candidates.push(fileURLToPath(new URL('.env', import.meta.url)));
  } catch {
    // конфиг загружен не из file://-URL — остаётся вариант с cwd
  }
  for (const path of candidates) {
    try {
      return parseDotEnv(readFileSync(path, 'utf8'));
    } catch {
      // нет файла или нет доступа — пробуем следующего кандидата
    }
  }
  return {};
}

export default defineConfig({
  project: 'proj_fxjnzqesxsicrpeuepzv',
  runtime: 'node',
  dirs: ['./src/trigger'],
  retries: {
    // ретраи всего run() выключены и на уровне дефолта, и явно на таске
    // (src/trigger/book-drop.ts): повтор при live:true рискует второй реальной
    // бронью, а идемпотентность держится на state, который в деградированном
    // режиме (Supabase недоступен) не переживает ран.
    enabledInDev: false,
    default: {
      maxAttempts: 1,
      minTimeoutInMs: 1000,
      maxTimeoutInMs: 10000,
      factor: 2,
      randomize: true,
    },
  },
  // окно наблюдения дропа ≤ 5 мин (dropWatchWindow) + запас на бронь/логи
  maxDuration: 600,
  build: {
    // better-sqlite3 — нативный модуль, в бандл его тянуть нельзя. В облаке он
    // и не нужен (там state = Supabase/Memory, sqlite живёт только в
    // src/core/state-sqlite.ts для локального run-drop.ts) — это страховка на
    // случай случайного импорта из src/trigger/*.
    external: ['better-sqlite3'],
    extensions: [
      // Секреты в облако едут только отсюда: перед каждым деплоем читаем
      // локальный .env и синхронизируем ровно CLOUD_ENV_ALLOWLIST.
      // Значения НЕ логируются никогда — только имена того, чего не хватает.
      syncEnvVars(() => {
        const dotEnv = readDotEnv();
        const missing: string[] = [];
        const vars = CLOUD_ENV_ALLOWLIST.flatMap((name) => {
          const value = (dotEnv[name] ?? process.env[name] ?? '').trim();
          if (value === '') {
            missing.push(name);
            return [];
          }
          return [{ name, value, isSecret: SECRET_ENV_KEYS.has(name) }];
        });
        if (missing.length > 0) {
          console.warn(`syncEnvVars: не заданы ${missing.join(', ')} — в облако эти переменные не поедут`);
        }
        return vars;
      }),
    ],
  },
});
