/**
 * CLI для ручных боевых прогонов дропа брони (фаза 2, вне cron).
 *
 * Запуск:
 *   npx tsx src/run-drop.ts --profile ilya --date 2026-08-06 --time 20:00 [--live] [--court "Padel Court 3"]
 *
 * Без --live — DRY-RUN: движок работает по-настоящему (polling, ожидание окна,
 * идемпотентность), но вместо реального POST createBooking логируется
 * "[DRY] бронировал бы X" и возвращается синтетический BookingCreated —
 * никакой реальной брони не создаётся. DRY пишет состояние в ОТДЕЛЬНЫЙ файл
 * (state.dry.db): фиктивная бронь в боевой базе заблокировала бы настоящий
 * --live прогон того же слота (AlreadyBooked без единого POST).
 * С --live — реальная бронь (POST в Reservio API) и боевой state.db.
 *
 * --court переопределяет приоритет кортов профиля на один-единственный корт.
 * --force снимает проверку дня недели из правила профиля.
 */

import { readFileSync } from 'node:fs';
import { ReservioClient } from './reservio/client.js';
import type { BookingCreated, ClientContact } from './reservio/types.js';
import { loadProfiles, ruleAppliesOn, type Profile } from './core/profiles.js';
import { SqliteStateStore } from './core/state.js';
import { bookSlotDrop, type EngineDeps, type DropReport } from './core/booking-engine.js';
import { dropDayOf, dropWatchWindow, tbilisiStamp, weekdayOf } from './core/scheduler.js';

// мини-загрузчик .env (тот же паттерн, что в spike-reservio.ts — без зависимостей)
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

// ---------- args ----------
const args = process.argv.slice(2);
const flag = (n: string) => args.includes(n);
const opt = (n: string, d?: string) => {
  const i = args.indexOf(n);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : d;
};

const PROFILE_ID = opt('--profile', 'ilya')!;
const DATE = opt('--date');
const TIME = opt('--time');
const COURT_OVERRIDE = opt('--court');
const LIVE = flag('--live');
const FORCE = flag('--force');

/** Боевой и репетиционный state строго разделены — см. шапку файла. */
const STATE_FILE = LIVE ? './state.db' : './state.dry.db';
/** Дальше этого ждать окно смысла нет (см. MAX_WAIT_TO_WINDOW_MS в движке). */
const MAX_WAIT_MS = 24 * 60 * 60 * 1000;
const WEEKDAY_NAMES = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];

if (!DATE || !TIME) {
  console.error('Использование: npx tsx src/run-drop.ts --profile ilya --date YYYY-MM-DD --time HH:MM [--live] [--court "Padel Court 3"] [--force]');
  process.exit(1);
}
// после проверки выше DATE/TIME гарантированно string; process.exit(1) имеет тип
// never, но эта narrow-типизация не переживает границу отдельной функции main(),
// поэтому передаём их туда явными параметрами
const targetDate: string = DATE;
const targetTime: string = TIME;

/** Все метки времени — в зоне клуба (+04:00), как и у движка. */
function log(msg: string): void {
  console.log(`[${tbilisiStamp(new Date())}] ${msg}`);
}

// ждём начала окна наблюдения дропа, если запущены раньше — редкий лог раз в 30с
async function waitForWindowStart(windowStart: Date): Promise<void> {
  let lastLog = 0;
  for (;;) {
    const now = Date.now();
    const left = windowStart.getTime() - now;
    if (left <= 0) return;
    if (now - lastLog >= 30_000) {
      log(`окно наблюдения ещё не началось, старт через ~${Math.round(left / 1000)}с (${tbilisiStamp(windowStart)})`);
      lastLog = now;
    }
    await new Promise((r) => setTimeout(r, Math.min(5000, left)));
  }
}

async function main(date: string, time: string): Promise<void> {
  console.log(`\n=== run-drop: режим ${LIVE ? 'LIVE (реальная бронь!)' : 'DRY-RUN (без реального POST)'} ===`);
  console.log(`    profile=${PROFILE_ID} date=${date} time=${time}${COURT_OVERRIDE ? ` court=${COURT_OVERRIDE}` : ''}`);
  console.log(`    state=${STATE_FILE}\n`);

  const profiles = loadProfiles(process.env);
  const profile = profiles.find((p) => p.id === PROFILE_ID);
  if (!profile) {
    throw new Error(`Профиль "${PROFILE_ID}" не найден. Доступные: ${profiles.map((p) => p.id).join(', ')}`);
  }

  // Правило профиля может ограничивать дни недели (напр. только вт/чт).
  if (!ruleAppliesOn(profile.rule, date)) {
    const day = WEEKDAY_NAMES[weekdayOf(date)];
    const allowed = (profile.rule.daysOfWeek ?? []).map((d) => WEEKDAY_NAMES[d]).join(', ');
    if (!FORCE) {
      console.error(`✗ ${date} — ${day}, а профиль "${profile.id}" играет только: ${allowed}. Ничего не бронируем (--force снимает проверку).`);
      process.exit(2);
    }
    log(`ВНИМАНИЕ: ${date} (${day}) вне дней профиля (${allowed}), но задан --force — продолжаем`);
  }

  const effectiveProfile: Profile = COURT_OVERRIDE
    ? { ...profile, rule: { ...profile.rule, courts: [COURT_OVERRIDE] } }
    : profile;

  // Окно дропа считается от целевой даты (T+7), а не от «сегодня»: день
  // наблюдения T = date − 7 суток. Проверяем до открытия state — чтобы
  // отменённый запуск не оставлял за собой файлов.
  const dayT = dropDayOf(date);
  const { start, deadline } = dropWatchWindow(dayT, time);
  log(`окно дропа: ${tbilisiStamp(start)} … ${tbilisiStamp(deadline)} (день наблюдения T=${dayT})`);
  if (Date.now() >= deadline.getTime()) {
    console.error(`✗ окно дропа для ${date} ${time} уже закрылось (${tbilisiStamp(deadline)}). Проверь --date/--time.`);
    process.exit(2);
  }
  if (start.getTime() - Date.now() > MAX_WAIT_MS) {
    console.error(`✗ окно дропа откроется только ${tbilisiStamp(start)} — это не ближайший дроп. Проверь --date/--time.`);
    process.exit(2);
  }

  const state = new SqliteStateStore(STATE_FILE);
  const realClient = new ReservioClient({ log });

  // DRY-RUN: подменяем createBooking заглушкой, всё остальное (polling, availability) настоящее.
  // Контакт профиля (CLIENT_*) в лог не выводим — это персональные данные.
  const client: Pick<ReservioClient, 'getAvailability' | 'createBooking' | 'cancelBooking' | 'getBooking'> = LIVE
    ? realClient
    : {
        getAvailability: realClient.getAvailability.bind(realClient),
        cancelBooking: realClient.cancelBooking.bind(realClient),
        getBooking: realClient.getBooking.bind(realClient),
        createBooking: async (bookArgs: { serviceId: string; start: string; end: string; contact: ClientContact }): Promise<BookingCreated> => {
          log(`[DRY] бронировал бы: serviceId=${bookArgs.serviceId} ${bookArgs.start} → ${bookArgs.end} (контакт профиля ${PROFILE_ID})`);
          return {
            bookingId: `dry-${Date.now()}`,
            token: 'dry-token',
            state: 'confirmed',
          };
        },
      };

  const deps: EngineDeps = {
    client: client as ReservioClient,
    state,
    log,
  };

  await waitForWindowStart(start);

  const report: DropReport = await bookSlotDrop(effectiveProfile, { date, time }, deps);

  console.log('\n--- Результат ---');
  console.log(report.ok ? '✅ УСПЕХ' : `✗ НЕУДАЧА (${report.error?.kind ?? 'unknown'})`);

  // token — guest-ключ к брони (чтение + отмена), в stdout ему не место.
  // Если он доехал до state — печатаем только факт; если нет, показываем как
  // последний след брони.
  const stored = state.getBooking(effectiveProfile.id, date, time);
  const tokenInState = stored?.bookingId === report.bookingId && (stored?.token ?? '') !== '';
  const printable: DropReport = report.token
    ? { ...report, token: tokenInState ? `<сохранён в ${STATE_FILE}>` : report.token }
    : report;
  if (report.token && !tokenInState) {
    console.log(`⚠️  token НЕ сохранён в ${STATE_FILE} — печатаем его ниже, сохрани вручную, иначе бронь не отменить`);
  }

  console.log('\nDropReport JSON:');
  console.log(JSON.stringify(printable, null, 2));

  process.exit(report.ok ? 0 : 1);
}

main(targetDate, targetTime).catch((e) => {
  console.error('FATAL:', e instanceof Error ? e.message : e);
  process.exit(1);
});
