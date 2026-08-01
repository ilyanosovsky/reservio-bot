/**
 * CLI для ручных боевых прогонов дропа брони (фаза 2, вне cron).
 *
 * Запуск:
 *   npx tsx src/run-drop.ts --profile ilya --date 2026-08-06 --time 20:00 [--live] [--courts "Padel Court 3,Padel Court 4"] [--all]
 *
 * Без --live — DRY-RUN: движок работает по-настоящему (polling, ожидание окна,
 * идемпотентность), но вместо реального POST createBooking логируется
 * "[DRY] бронировал бы X" и возвращается синтетический BookingCreated —
 * никакой реальной брони не создаётся. DRY пишет состояние под ОТДЕЛЬНЫМ id
 * профиля (`<profile>:dry`) и в отдельный файл (state.dry.db): фиктивная бронь
 * под боевым ключом заблокировала бы настоящий --live прогон того же слота
 * (AlreadyBooked без единого POST).
 * С --live — реальная бронь (POST в Reservio API).
 *
 * State: если заданы SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY, берётся тот же
 * SupabaseStateStore, что и у облачного таска (src/trigger/book-drop.ts) —
 * иначе локальный и облачный прогоны не видят броней друг друга и спокойно
 * создают ДВА реальных бронирования на один слот. --sqlite — аварийный выход
 * на локальный файл, когда Supabase недоступен (защиты от дубля тогда нет).
 *
 * --court переопределяет набор кортов профиля на один-единственный корт,
 * --courts — на произвольный список через запятую (порядок = приоритет).
 * --all включает режим вечерней вахты: бронировать КАЖДЫЙ появившийся корт
 * набора, а не только первый (клуб держит C2/C3 на 20–22, в дроп выходит то
 * один корт, то другой — лишнее отменяется руками).
 * --force снимает проверку дня недели из правила профиля.
 */

import { readFileSync } from 'node:fs';
import { ReservioClient } from './reservio/client.js';
import type { BookingCreated, ClientContact } from './reservio/types.js';
import { loadProfiles, ruleAppliesOn, type Profile } from './core/profiles.js';
import type { StateStore } from './core/state.js';
import { SqliteStateStore } from './core/state-sqlite.js';
import { SupabaseStateStore } from './core/state-supabase.js';
import { bookSlotDrop, type DropMode, type EngineDeps, type DropReport } from './core/booking-engine.js';
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
/** Список кортов через запятую: порядок = приоритет (в режиме --all — просто набор вахты). */
const COURTS_OVERRIDE = opt('--courts');
const LIVE = flag('--live');
const FORCE = flag('--force');
/** Вечерняя вахта: бронировать каждый появившийся корт набора, а не только первый. */
const MODE: DropMode = flag('--all') ? 'all' : 'priority';
/** Аварийный выход на локальный файл, когда Supabase настроен, но недоступен. */
const FORCE_SQLITE = flag('--sqlite');

/** Боевой и репетиционный state строго разделены — см. шапку файла. */
const STATE_FILE = LIVE ? './state.db' : './state.dry.db';
/** Тот же суффикс, что у облачного таска: DRY не занимает боевой ключ слота. */
const DRY_PROFILE_SUFFIX = ':dry';
/** Дальше этого ждать окно смысла нет (см. MAX_WAIT_TO_WINDOW_MS в движке). */
const MAX_WAIT_MS = 24 * 60 * 60 * 1000;
const WEEKDAY_NAMES = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];

if (!DATE || !TIME) {
  console.error(
    'Использование: npx tsx src/run-drop.ts --profile ilya --date YYYY-MM-DD --time HH:MM ' +
      '[--live] [--court "Padel Court 3"] [--courts "Padel Court 3,Padel Court 4"] [--all] [--force] [--sqlite]',
  );
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

/**
 * Тот же выбор хранилища, что у облачного таска (src/trigger/book-drop.ts):
 * при заданных SUPABASE_* локальный прогон обязан смотреть в ТУ ЖЕ таблицу.
 * Иначе бронь, созданная раном в trigger.dev, этому прогону не видна —
 * идемпотентность рвётся, и на слот уходит второй реальный POST.
 */
async function openState(profileId: string, date: string, time: string): Promise<{ state: StateStore; where: string }> {
  const url = process.env.SUPABASE_URL?.trim() ?? '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ?? '';

  if (url === '' || key === '') {
    log(`state: ${STATE_FILE} (SUPABASE_* не заданы) — брони из trigger.dev этому прогону НЕ видны`);
    return { state: new SqliteStateStore(STATE_FILE), where: STATE_FILE };
  }
  if (FORCE_SQLITE) {
    log(
      `ВНИМАНИЕ: --sqlite при настроенном Supabase — прогон не увидит облачных броней (${STATE_FILE}). ` +
        'Убедись, что на этот слот нет рана в trigger.dev, иначе получишь дубль',
    );
    return { state: new SqliteStateStore(STATE_FILE), where: STATE_FILE };
  }

  // Таймаут короче дефолтных 5 c: движок читает state прямо перед POST, уже в
  // горячем окне — зависшее хранилище не должно стоить нам корта.
  const state = new SupabaseStateStore({ url, serviceKey: key, timeoutMs: 1_500 });
  try {
    // Пробное чтение до окна: «нет таблицы» / «не тот ключ» должны всплыть
    // сейчас, а не в секунду дропа. Читаем весь слот: пробе не нужен корт.
    await state.listBookingsForSlot(profileId, date, time);
  } catch (err) {
    throw new Error(
      `state: Supabase недоступен — ${err instanceof Error ? err.message : String(err)}. ` +
        'Почини доступ или запусти с --sqlite (тогда идемпотентность только локальная: облачные брони прогон не увидит).',
      { cause: err },
    );
  }
  log('state: Supabase (та же таблица bookings, что у trigger.dev)');
  return { state, where: 'Supabase (таблица bookings)' };
}

async function main(date: string, time: string): Promise<void> {
  console.log(`\n=== run-drop: режим ${LIVE ? 'LIVE (реальная бронь!)' : 'DRY-RUN (без реального POST)'} ===`);
  console.log(
    `    profile=${PROFILE_ID} date=${date} time=${time}` +
      `${COURT_OVERRIDE ? ` court=${COURT_OVERRIDE}` : ''}${COURTS_OVERRIDE ? ` courts=${COURTS_OVERRIDE}` : ''}` +
      ` mode=${MODE === 'all' ? 'all (бронируем все появившиеся корты)' : 'priority (первый по приоритету)'}\n`,
  );

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

  // --courts бьёт --court: список явнее одиночного корта, а молча смешивать их
  // нельзя — человек должен видеть ровно тот набор, который написал.
  const courtsOverride = COURTS_OVERRIDE
    ? COURTS_OVERRIDE.split(',')
        .map((c) => c.trim())
        .filter((c) => c !== '')
    : COURT_OVERRIDE
      ? [COURT_OVERRIDE]
      : null;
  if (COURTS_OVERRIDE && courtsOverride !== null && courtsOverride.length === 0) {
    console.error('✗ --courts пуст после разбора: ожидается список имён кортов через запятую.');
    process.exit(2);
  }
  const withCourts: Profile =
    courtsOverride === null ? profile : { ...profile, rule: { ...profile.rule, courts: courtsOverride } };
  // DRY пишет state под отдельным id — иначе фиктивная бронь заняла бы боевой
  // ключ (profile, date, time) и настоящий прогон вышел бы с AlreadyBooked.
  const effectiveProfile: Profile = LIVE
    ? withCourts
    : { ...withCourts, id: `${withCourts.id}${DRY_PROFILE_SUFFIX}` };

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

  const { state, where: stateWhere } = await openState(effectiveProfile.id, date, time);
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

  const report: DropReport = await bookSlotDrop(
    effectiveProfile,
    { date, time, courts: effectiveProfile.rule.courts, mode: MODE },
    deps,
  );

  console.log('\n--- Результат ---');
  console.log(report.ok ? '✅ УСПЕХ' : `✗ НЕУДАЧА (${report.error?.kind ?? 'unknown'})`);
  // По кортам — построчно: в режиме --all за один дроп бывает несколько броней
  // и несколько промахов сразу, из корневых полей отчёта этого не видно.
  for (const r of report.results) {
    const speed = r.msFromSeenToBooked === undefined ? '' : ` за ${r.msFromSeenToBooked} мс`;
    console.log(r.ok ? `   ✅ ${r.court}: ${r.bookingId}${speed}` : `   ✗ ${r.court}: ${r.error ?? 'брони нет'}`);
  }

  // token — guest-ключ к брони (чтение + отмена), в stdout ему не место.
  // Если он доехал до state — печатаем только факт; если нет, показываем как
  // последний след брони.
  // Ключ state включает корт, а корт брони известен только из отчёта — поэтому
  // ищем свою строку среди всех броней слота по bookingId.
  const slotRows = await state.listBookingsForSlot(effectiveProfile.id, date, time);
  const stored = slotRows.find((b) => b.bookingId === report.bookingId);
  const tokenInState = stored !== undefined && (stored.token ?? '') !== '';
  const printable: DropReport = report.token
    ? { ...report, token: tokenInState ? `<сохранён в ${stateWhere}>` : report.token }
    : report;
  if (report.token && !tokenInState) {
    console.log(`⚠️  token НЕ сохранён в ${stateWhere} — печатаем его ниже, сохрани вручную, иначе бронь не отменить`);
  }

  console.log('\nDropReport JSON:');
  console.log(JSON.stringify(printable, null, 2));

  process.exit(report.ok ? 0 : 1);
}

main(targetDate, targetTime).catch((e) => {
  console.error('FATAL:', e instanceof Error ? e.message : e);
  process.exit(1);
});
