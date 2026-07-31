/**
 * Идемпотентный сид Supabase: профиль по умолчанию ('ilya') и его дефолтное
 * правило расписания. Запускается руками, обычно один раз при заводке бота.
 *
 *   npx tsx scripts/seed-profiles.ts
 *
 * Что делает:
 *   1. upsert профиля 'ilya' из env (CLIENT_NAME/CLIENT_EMAIL/CLIENT_PHONE,
 *      TELEGRAM_CHAT_ID), is_admin = true — это владелец бота;
 *   2. если у профиля ещё НЕТ ни одного правила — заводит дефолтное
 *      (20:00 + 21:00, Padel Court 3 -> Padel Court 2, все дни, enabled).
 *
 * Идемпотентность: повторный запуск обновит контакт профиля из env и НЕ тронет
 * правила — иначе сид затирал бы то, что пользователь настроил в боте.
 * Остальные профили сидом не заводятся: для них есть /add_profile в боте.
 *
 * Приватность: контакт (name/email/phone) и chat_id в консоль не печатаются —
 * это персональные данные, а вывод скрипта попадает в чужие терминалы и логи.
 */

import { readFileSync } from 'node:fs';
import { loadProfiles } from '../src/core/profiles.js';
import { ProfilesRepo, SchedulesRepo, type SupabaseRepoOptions } from '../src/core/repos.js';

// мини-загрузчик .env (тот же паттерн, что в src/run-drop.ts — без зависимостей)
function loadDotEnv(): void {
  try {
    const path = new URL('../.env', import.meta.url);
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch {
    // .env отсутствует — ок, значит переменные заданы окружением напрямую
  }
}
loadDotEnv();

/** id профиля владельца — тот же, что дефолтный в src/core/profiles.ts. */
const PROFILE_ID = 'ilya';
/** Подпись в интерфейсе бота; PROFILE_ILYA_LABEL перебивает. */
const DEFAULT_LABEL = 'Илья';

async function main(): Promise<void> {
  const url = process.env.SUPABASE_URL?.trim() ?? '';
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ?? '';
  if (url === '' || serviceKey === '') {
    throw new Error(
      'Нужны SUPABASE_URL и SUPABASE_SERVICE_ROLE_KEY (см. .env.example): сид пишет прямо в Supabase',
    );
  }

  // Валидация контакта (обязательность полей, формат email) уже есть в loadProfiles —
  // не дублируем её здесь, чтобы сид и боевой флоу не разъехались.
  const profile = loadProfiles(process.env).find((p) => p.id === PROFILE_ID);
  if (!profile) {
    throw new Error(`Профиль "${PROFILE_ID}" не собрался из env — проверь CLIENT_NAME/CLIENT_EMAIL/CLIENT_PHONE`);
  }
  const label = (process.env.PROFILE_ILYA_LABEL ?? '').trim() || DEFAULT_LABEL;

  const opts: SupabaseRepoOptions = { url, serviceKey };
  const profiles = new ProfilesRepo(opts);
  const schedules = new SchedulesRepo(opts);

  await profiles.upsert({
    id: profile.id,
    label,
    name: profile.contact.name,
    email: profile.contact.email,
    phone: profile.contact.phone,
    telegramChatId: profile.telegramChatId ?? null,
    // Владелец бота — единственный админ по умолчанию: остальные профили
    // заводятся через /add_profile и админами не становятся.
    isAdmin: true,
  });

  // Внешняя валидация записи: верим не отсутствию ошибки, а прочитанной строке.
  const saved = await profiles.getById(profile.id);
  if (!saved) throw new Error(`Профиль ${profile.id} не читается обратно из Supabase — запись не подтверждена`);
  console.log(`✓ профиль ${saved.id} (${saved.label}) сохранён${saved.isAdmin ? ', админ' : ''}`);
  console.log(
    saved.telegramChatId === null
      ? '  ⚠️ telegram_chat_id не задан — бот не узнает этот профиль и будет молчать. Добавь TELEGRAM_CHAT_ID в .env и перезапусти сид.'
      : '  telegram_chat_id привязан (значение не печатаем)',
  );
  // TELEGRAM_CHAT_ID с фазы 2 — адрес ИСХОДЯЩИХ отчётов, и там вполне может
  // стоять группа. Как удостоверение личности такой id не годится: под ним
  // пишет любой участник. Бот входящее из групп игнорирует (src/bot/auth.ts),
  // но человек должен понимать, почему его команды остаются без ответа.
  if (saved.telegramChatId !== null && saved.telegramChatId.startsWith('-')) {
    console.log(
      '  ⚠️ это chat_id ГРУППЫ (начинается с «-»): отчёты и напоминания в неё уходить будут, ' +
        'но команды бота из группы не принимаются — управлять ботом можно только из личного чата. ' +
        'Для управления впиши в TELEGRAM_CHAT_ID свой личный chat_id и перезапусти сид.',
    );
  }
  console.log('  контакт взят из env (name/email/phone не печатаем: персональные данные)');

  const existing = await schedules.listByProfile(profile.id);
  if (existing.length > 0) {
    console.log(`✓ правила уже есть (${existing.length}) — сид их не трогает, меняй через бота (⏰ Расписание)`);
    return;
  }

  const days = profile.rule.daysOfWeek ?? null;
  await schedules.upsert({
    profileId: profile.id,
    times: profile.rule.times,
    courts: profile.rule.courts,
    daysOfWeek: days,
    enabled: true,
  });
  const created = await schedules.listByProfile(profile.id);
  if (created.length === 0) throw new Error('Правило не читается обратно из Supabase — запись не подтверждена');
  console.log(
    `✓ правило создано: ${profile.rule.times.join(' + ')} · ${profile.rule.courts.join(' → ')} · ` +
      `дни: ${days === null ? 'все' : days.join(',')}`,
  );
}

main().catch((e: unknown) => {
  console.error('FATAL:', e instanceof Error ? e.message : e);
  process.exit(1);
});
