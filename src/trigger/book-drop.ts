// Таск trigger.dev "book-slot-drop" — ТОЛЬКО ручной запуск (дашборд / CLI /
// mcp__trigger__trigger_task, в т.ч. отложенный через `delay`). НИКАКОГО
// schedules/cron: автоматическое расписание запрещено до фазы 4 и явного
// одобрения пользователя (CLAUDE.md → «Пока идёт разработка (фазы 0–3) —
// никаких автоматических бронирований по cron»).
//
// State в облаке: файловый better-sqlite3 воркерам недоступен, поэтому здесь
// SupabaseStateStore (PostgREST) — общее хранилище для всех ранов, из него и
// берётся идемпотентность между запусками. Если Supabase не настроен или
// недоступен, таск НЕ падает: он деградирует до MemoryStateStore и явно
// сообщает об этом в Telegram. Бронь важнее персистентности; защита от дубля
// в этот момент держится только на concurrencyLimit 1 и отключённых ретраях.
//
// Инвариант наблюдаемости (CLAUDE.md): каждый ран отправляет РОВНО ОДНО
// сообщение в Telegram — успех, неудача, скип или крах самого рана. Молчаливый
// провал — худший баг этого проекта.
//
// Квитанция вечера: сразу после отправки (или провала отправки) отчёта ран
// пишет строку в drop_reports — «за слот отчитались, доставлено: да/нет».
// Изнутри рана дыру «рана не было вовсе» не закрыть: если воркер умер или
// планировщик не сработал, сообщать об этом некому. Сверяет квитанции с планом
// вечера отдельный таск heartbeat (22:12 Тбилиси). Запись best-effort: её сбой
// логируется, но не роняет ран и ничего не меняет в поведении Telegram —
// потерянная квитанция стоит ложной тревоги heartbeat'а, а упавший из-за неё
// ран стоил бы брони.
//
// Профиль (контакт, приоритет кортов, чат для отчёта) берётся из Supabase —
// таблицы profiles/schedule_rules, то есть ровно оттуда, куда пишет админ
// (/add_profile, /add_rule) и откуда читает планировщик. ENV-профиль
// (src/core/profiles.ts) остаётся запасным путём: ручные прогоны без Supabase и
// подстраховка, если БД недоступна. Два источника правды для одного и того же
// факта — это разъезд: профиль, заведённый в боте, не бронировался бы вовсе, а
// отчёт о нём уходил бы владельцу.
//
// Перед окном ран ещё раз проверяет скип на этот день (таблица skips): между
// планированием и дропом человек мог нажать «⏭ Пропустить» в боте. Проверок
// две — на старте рана и повторно за несколько секунд до окна: ран стартует
// примерно за две минуты, и всё это время кнопка «Пропустить» у человека на
// экране. Скип — не ошибка: уходит отдельное сообщение «пропущено по команде»,
// брони нет.
// После успешной LIVE-брони ставится отложенный ран 'remind' (src/trigger/
// remind.ts) на «начало слота минус 2 часа».
//
// Приватность: контакт профиля (CLIENT_*), guest-token и значения секретов в
// логи/output/Telegram не попадают — output рана виден всем, у кого есть
// доступ к дашборду. Token живёт в state и в письме-подтверждении.
// Единственное исключение: если state деградировал, token не сохранён НИГДЕ
// (память умрёт вместе с раном) — тогда он остаётся в output рана, иначе бронь
// нечем отменить. В Telegram token не уходит никогда.

import { task, logger } from '@trigger.dev/sdk';
import { ReservioClient } from '../reservio/client.js';
import type { BookingCreated, ClientContact } from '../reservio/types.js';
import { loadProfiles, ruleAppliesOn, type Profile } from '../core/profiles.js';
import { MemoryStateStore, type StateStore, type StoredBooking } from '../core/state.js';
import { SupabaseStateStore } from '../core/state-supabase.js';
import { formatDropReport, sendTelegram, telegramFromEnv, type TelegramTarget } from '../core/notify.js';
import { bookSlotDrop, type EngineDeps, type DropCourtResult, type DropMode, type DropReport } from '../core/booking-engine.js';
import { dropDayOf, dropWatchWindow, tbilisiStamp } from '../core/scheduler.js';
import { DropReportsRepo, ProfilesRepo, SchedulesRepo, SkipsRepo, type SupabaseRepoOptions } from '../core/repos.js';
import { scheduleReminder } from './remind.js';

export interface BookSlotDropPayload {
  profileId: string;
  date: string; // YYYY-MM-DD
  time: string; // HH:MM
  live: boolean; // false = DRY-RUN (без реального POST), true = реальная бронь
  /** true — игнорировать ограничение rule.daysOfWeek профиля. */
  force?: boolean;
  /**
   * Набор кортов на этот дроп. Не задан — берётся из schedule_rule профиля
   * (так шлёт планировщик и так работают все старые раны).
   */
  courts?: string[];
  /**
   * 'priority' — первый доступный корт по приоритету (старое поведение);
   * 'all' — бронировать КАЖДЫЙ появившийся корт набора (вечерняя вахта).
   * Не задан — режим из schedule_rule профиля, иначе 'priority'.
   */
  mode?: DropMode;
}

/**
 * DRY пишет state под ОТДЕЛЬНЫМ id профиля. Фиктивная бронь `dry-...` под
 * боевым ключом (profile_id, date, time) заблокировала бы настоящий прогон
 * того же слота (AlreadyBooked без единого POST) — та же причина, по которой
 * run-drop.ts разводит state.db и state.dry.db.
 */
const DRY_PROFILE_SUFFIX = ':dry';

/**
 * Имена env, значения которых нельзя выпускать в лог/Telegram/output ни при
 * каких ошибках. Кроме секретов сюда входит контакт профиля: чужой текст
 * (Reservio, валидация профилей) любит цитировать email/телефон, а это
 * персональные данные.
 */
const SECRET_ENV_NAMES = [
  'SUPABASE_SERVICE_ROLE_KEY',
  'TELEGRAM_BOT_TOKEN',
  'CLIENT_NAME',
  'CLIENT_EMAIL',
  'CLIENT_PHONE',
];

/** Обе переменные нужны вместе: без любой из них отчёт уходить некуда. */
const TELEGRAM_ENV_NAMES = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'] as const;

/** Держать в синхроне с maxDuration в trigger.config.ts. */
const MAX_RUN_MS = 600_000;
/**
 * Сколько ран может провести в ожидании окна. Из maxDuration вычтено окно
 * наблюдения (5 мин) и запас на холодный старт воркера и логи.
 */
const MAX_WAIT_TO_WINDOW_MS = 4 * 60_000;
/** Рекомендуемый запас между стартом рана и открытием окна (H:58:30 → H:56:00). */
const RECOMMENDED_HEAD_START_MS = 150_000;

/**
 * Таймаут запросов к Supabase в дропе (вместо дефолтных 5 с). Движок проверяет
 * state прямо перед POST, уже в горячем окне; keep-alive к этому моменту давно
 * закрыт, так что запрос платит DNS+TCP+TLS. Полутора секунд с запасом хватает
 * на холодное соединение, но зависший Supabase больше этого времени в гонке за
 * корт не украдёт: по таймауту стор деградирует на память, и POST уходит.
 */
const DROP_STATE_TIMEOUT_MS = 1_500;

/**
 * Таймаут проверки скипа. Она делается ДО окна дропа, спешить некуда, но и
 * висеть в ожидании Supabase нельзя: за окном стоит бронь.
 */
const SKIP_CHECK_TIMEOUT_MS = 3_000;

/**
 * За сколько до окна делается ПОВТОРНАЯ проверка скипа. Запас покрывает сам
 * запрос (таймаут SKIP_CHECK_TIMEOUT_MS) — то есть в худшем случае мы вернёмся
 * к окну ровно к его открытию, а не позже.
 */
const SKIP_RECHECK_LEAD_MS = 4_000;

/**
 * Попытки доставки отчёта. Единственное сообщение за ран не должно теряться
 * из-за транзиентного 429/502 Telegram: два одинаковых отчёта (если ответ на
 * успешную отправку потерялся) несравнимо лучше молчания.
 */
const DELIVER_ATTEMPTS = 3;
const DELIVER_PAUSE_MS = 1_500;

/**
 * token — единственный ключ к брони: в output рана его быть не должно, пока он
 * лежит в state. Исключение (state деградировал) разбирается в run().
 */
function redactToken(report: DropReport): DropReport {
  if (!report.token) return report;
  return { ...report, token: '<скрыт: см. state/письмо-подтверждение>' };
}

function describeError(err: unknown): string {
  if (err instanceof Error) {
    const { status, code } = err as Error & { status?: number; code?: string };
    return [err.message, status === undefined ? null : `status=${status}`, code ? `code=${code}` : null]
      .filter((p): p is string => p !== null && p !== '')
      .join(' ');
  }
  return String(err);
}

/**
 * Чужой текст ошибки может содержать URL с токеном или процитированный контакт
 * профиля — вырезаем значения. Заглушка в квадратных скобках, а не в угловых:
 * этот же текст уходит в Telegram с parse_mode=HTML (уже после экранирования),
 * и «тег» `<CLIENT_EMAIL>` стоил бы нам всего сообщения — HTTP 400.
 */
function redactSecrets(text: string): string {
  let out = text;
  for (const name of SECRET_ENV_NAMES) {
    const value = process.env[name];
    // короткие значения не режем: слишком велик шанс задеть обычный текст
    if (value !== undefined && value.length >= 8) out = out.split(value).join(`[${name}]`);
  }
  return out;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Supabase с посадкой на память. Любой отказ хранилища (нет таблицы, не тот
 * ключ, сеть) переводит стор в память НАВСЕГДА в рамках рана и запоминает
 * причину — дроп при этом продолжается. Обратно не поднимаемся: поведение
 * должно быть предсказуемым, а не «то в базу, то мимо».
 */
export class ResilientStateStore implements StateStore {
  private readonly memory = new MemoryStateStore();
  private reason: string | null = null;

  constructor(
    private readonly primary: StateStore,
    private readonly onDegrade: (reason: string) => void,
  ) {}

  /** null — Supabase жив; строка — причина, по которой ран доживает на памяти. */
  get warning(): string | null {
    return this.reason;
  }

  private async call<T>(op: string, fn: (store: StateStore) => Promise<T>): Promise<T> {
    if (this.reason === null) {
      try {
        return await fn(this.primary);
      } catch (err) {
        this.reason =
          `Supabase-state недоступен (${op}: ${redactSecrets(describeError(err))}) — ран доработал на памяти, ` +
          'идемпотентность между ранами НЕ гарантирована';
        this.onDegrade(this.reason);
      }
    }
    return fn(this.memory);
  }

  getBooking(profileId: string, date: string, time: string, court: string): Promise<StoredBooking | null> {
    return this.call('getBooking', (s) => s.getBooking(profileId, date, time, court));
  }

  listBookingsForSlot(profileId: string, date: string, time: string): Promise<StoredBooking[]> {
    return this.call('listBookingsForSlot', (s) => s.listBookingsForSlot(profileId, date, time));
  }

  saveBooking(b: StoredBooking): Promise<void> {
    return this.call('saveBooking', (s) => s.saveBooking(b));
  }

  listBookings(profileId?: string): Promise<StoredBooking[]> {
    return this.call('listBookings', (s) => s.listBookings(profileId));
  }

  markCanceled(bookingId: string): Promise<void> {
    return this.call('markCanceled', (s) => s.markCanceled(bookingId));
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Отправка отчёта не имеет права уронить ран — но её провал должен быть
 * громким. Транзиентные отказы Telegram (429 flood, 502, таймаут) переживаем
 * ретраями: после брони у рана остаются сотни секунд бюджета maxDuration, а
 * ноль сообщений за вечер — это молчаливый провал.
 *
 * Возвращает, доставлено ли сообщение: этот флаг уезжает в квитанцию вечера
 * (drop_reports.telegram_ok), по которой heartbeat отличает «отчёта не было» от
 * «отчёт был, но до человека не доехал». Ненастроенный Telegram (target=null) —
 * тоже «не доставлено»: молчание по причине забытой переменной остаётся
 * молчанием.
 */
async function deliver(target: TelegramTarget | null, text: string): Promise<boolean> {
  if (target === null) return false;
  for (let attempt = 1; attempt <= DELIVER_ATTEMPTS; attempt += 1) {
    try {
      if (await sendTelegram(target, text)) return true;
      logger.warn(`Telegram: отчёт не ушёл (попытка ${attempt}/${DELIVER_ATTEMPTS})`);
    } catch (err) {
      logger.error(`Telegram: отправка упала (попытка ${attempt}/${DELIVER_ATTEMPTS}): ${redactSecrets(describeError(err))}`);
    }
    if (attempt < DELIVER_ATTEMPTS) await sleep(DELIVER_PAUSE_MS);
  }
  logger.error(
    `Telegram: отчёт НЕ доставлен за ${DELIVER_ATTEMPTS} попытки — результат дропа остался только в логах этого рана`,
  );
  return false;
}

/** Запасной текст на случай, если сам форматтер отчёта сломался. Без token и контактов. */
function fallbackReportText(report: DropReport, why: string): string {
  const head = report.ok ? '✅ Бронь есть' : `❌ Бронь не удалась (${escapeHtml(report.error?.kind ?? 'unknown')})`;
  return [
    head,
    `${escapeHtml(report.profileId)} · ${escapeHtml(report.date)} ${escapeHtml(report.time)}` +
      (report.court ? ` · ${escapeHtml(report.court)}` : ''),
    report.bookingId ? `id ${escapeHtml(report.bookingId)}` : '',
    `(отчёт не отформатировался: ${escapeHtml(why)})`,
  ]
    .filter((line) => line !== '')
    .join('\n');
}

/**
 * Все брони, реально созданные ЭТИМ раном (в режиме 'all' их бывает несколько).
 *
 * Корневые court/bookingId отчёта — это лишь ПЕРВАЯ из них, поэтому источник
 * правды здесь results. Фолбэк на корень оставлен для отчётов, собранных без
 * results (старый формат, ручная сборка): пропустить напоминание по существующей
 * брони хуже, чем лишний раз перестраховаться.
 */
function successfulBookings(report: DropReport): Array<{ court: string; bookingId: string }> {
  const fromResults = (report.results ?? [])
    .filter((r) => r.ok && (r.bookingId ?? '') !== '' && (r.court ?? '') !== '')
    .map((r) => ({ court: r.court, bookingId: r.bookingId! }));
  if (fromResults.length > 0) return fromResults;
  const court = report.court ?? '';
  const bookingId = report.bookingId ?? '';
  return report.ok && court !== '' && bookingId !== '' ? [{ court, bookingId }] : [];
}

/** '743 мс' / '1.2 с' — человеку важен порядок величины, а не точность до миллисекунды. */
function formatSpeed(ms: number): string {
  return ms < 1000 ? `${ms} мс` : `${(ms / 1000).toFixed(1)} с`;
}

/** Кусок чужого текста в сводке: длинная ошибка Reservio не должна вытеснить остальные корты. */
const COURT_ERROR_LIMIT = 120;

/**
 * Сводка по набору кортов: «✅ Padel Court 3 (743 мс), Padel Court 4 (1.2 с) ·
 * ❌ Padel Court 1 — слот не появился». Нужна вечерней вахте (mode 'all'), где
 * за один дроп бывает несколько броней и несколько промахов сразу — из
 * корневых полей отчёта этого не видно.
 *
 * Для одного корта не выводится: строка «Корт: …» в отчёте уже всё сказала.
 */
function courtsSummary(report: DropReport): string | null {
  const results: DropCourtResult[] = report.results ?? [];
  if (results.length < 2) return null;
  const booked = results
    .filter((r) => r.ok)
    .map((r) => escapeHtml(r.court) + (r.msFromSeenToBooked === undefined ? '' : ` (${formatSpeed(r.msFromSeenToBooked)})`));
  const missed = results
    .filter((r) => !r.ok)
    .map((r) => `${escapeHtml(r.court)} — ${escapeHtml(clampCourtError(r.error))}`);
  const parts: string[] = [];
  if (booked.length > 0) parts.push(`✅ ${booked.join(', ')}`);
  if (missed.length > 0) parts.push(`❌ ${missed.join('; ')}`);
  return parts.length === 0 ? null : `Корты: ${parts.join(' · ')}`;
}

function clampCourtError(error: string | undefined): string {
  const text = error ?? 'брони нет';
  return text.length <= COURT_ERROR_LIMIT ? text : `${text.slice(0, COURT_ERROR_LIMIT)}…`;
}

/**
 * Предупреждение о неоднозначном отказе POST — бронь на этих кортах МОГЛА быть
 * создана, а id/token до нас не доехали.
 *
 * Отдельной строкой (⚠️), а не только внутри сводки по кортам: в режиме 'all'
 * успех на соседнем корте делает отчёт зелёным (formatDropReport печатает
 * «Причина/Детали» только при ok=false), а строка корта в сводке обрезается по
 * COURT_ERROR_LIMIT — то есть самое важное («сходи проверь») до человека не
 * доезжало бы вовсе. Фантомную бронь надо успеть отменить за час до слота.
 */
function ambiguousWarning(report: DropReport): string | undefined {
  const courts = (report.results ?? []).filter((r) => r.ambiguous === true).map((r) => r.court);
  if (courts.length === 0) return undefined;
  return (
    `POST по ${courts.join(', ')} завершился неоднозначно — бронь МОГЛА быть создана на сервере, ` +
    'id/token потеряны: проверь почту профиля и клуб вручную (лишнее отменяется не позже чем за час до слота)'
  );
}

/**
 * Вставляет сводку по кортам в готовый текст отчёта — перед строкой
 * предупреждений (⚠️), чтобы предупреждения оставались последними: их читают
 * последними и по ним принимают решения.
 */
function withCourtsSummary(text: string, report: DropReport): string {
  const summary = courtsSummary(report);
  if (summary === null) return text;
  const lines = text.split('\n');
  const warningAt = lines.findIndex((line) => line.startsWith('⚠️'));
  if (warningAt < 0) return [...lines, summary].join('\n');
  lines.splice(warningAt, 0, summary);
  return lines.join('\n');
}

/**
 * Скип: единственное сообщение за такой ран. Отдельный текст, а не
 * formatDropReport, потому что «пропущено по команде» — это не ошибка дропа:
 * расширять DropErrorKind ради него значило бы менять контракт ядра фазы 2
 * (движок, notify, их тесты), а маркер ❌ у осознанного пропуска ещё и врал бы.
 */
function skippedText(payload: BookSlotDropPayload): string {
  return [
    '⏭ <b>Пропущено по команде</b>',
    `${escapeHtml(payload.profileId)} · ${escapeHtml(payload.date)} ${escapeHtml(payload.time)} · ` +
      (payload.live ? 'LIVE' : 'DRY'),
    'На этот день стоит скип — бронь не делали.',
  ].join('\n');
}

/** Имена кортов из payload: мусор (не массив, пустые строки) отбрасываем целиком. */
function normalizeCourts(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  const courts = raw.filter((c): c is string => typeof c === 'string').map((c) => c.trim()).filter((c) => c !== '');
  return courts.length === 0 ? null : courts;
}

/** Режим из payload/БД. Всё, что не 'all'/'priority', — как будто не задано. */
function normalizeMode(raw: unknown): DropMode | null {
  return raw === 'all' || raw === 'priority' ? raw : null;
}

/**
 * Профиль для дропа: контакт, набор кортов, режим, чат.
 *
 * Источник правды — Supabase (profiles + schedule_rules): туда пишет админ из
 * бота, оттуда планировщик берёт правила и туда же смотрит бот, когда решает,
 * кому что показывать. ENV-профиль остаётся запасным: он нужен ручным прогонам
 * без Supabase и спасает, если БД отвалилась ровно перед дропом.
 * Явный `courtsOverride` из payload бьёт оба источника: ручной ран «поймай мне
 * вот эти корты» не должен зависеть от того, что записано в правиле.
 *
 * Возвращает предупреждения, которые обязаны попасть в единственное сообщение
 * вечера: «профиль взят из ENV, потому что БД молчит» — это ровно тот случай,
 * когда бронь может уйти не с тем набором кортов.
 */
async function resolveProfile(args: {
  profileId: string;
  time: string;
  supabase: SupabaseRepoOptions | null;
  envProfile: Profile | null;
  envProblem: string | null;
  /** Набор кортов из payload; null — берём из правила/ENV. */
  courtsOverride: string[] | null;
}): Promise<{ profile: Profile; mode: DropMode | null; warnings: string[] }> {
  const { profileId, time, supabase, envProfile, envProblem, courtsOverride } = args;
  const warnings: string[] = [];

  let dbProfile = null as Awaited<ReturnType<ProfilesRepo['getById']>>;
  let dbCourts: string[] | null = null;
  let dbDays: number[] | null = null;
  let dbMode: DropMode | null = null;
  if (supabase !== null) {
    try {
      dbProfile = await new ProfilesRepo(supabase).getById(profileId);
      if (dbProfile !== null) {
        const rules = await new SchedulesRepo(supabase).listByProfile(profileId);
        // Правило этого времени авторитетнее прочих; если такого нет — берём
        // любое включённое (набор кортов у профиля обычно один на все часы).
        const rule = rules.find((r) => r.enabled && r.times.includes(time)) ?? rules.find((r) => r.enabled) ?? null;
        dbCourts = rule?.courts ?? null;
        dbDays = rule?.daysOfWeek ?? null;
        // mode валидируем и здесь (репозиторий это уже делает): мусор в колонке
        // не должен включать вахту по всем кортам там, где её не просили.
        dbMode = normalizeMode(rule?.mode);
      }
    } catch (err) {
      warnings.push(`профиль из Supabase не прочитан (${redactSecrets(describeError(err))}) — работаем по ENV-профилю`);
      logger.warn(warnings[warnings.length - 1]!);
    }
  }

  if (dbProfile === null) {
    if (envProfile === null) {
      throw new Error(
        `Профиль "${profileId}" не найден ни в Supabase (таблица profiles), ни в ENV` +
          (envProblem === null ? '' : ` (${envProblem})`) +
          '. Заведи его через /add_profile в боте или добавь PROFILE_<K>_* в переменные окружения.',
      );
    }
    logger.info(`профиль "${profileId}" взят из ENV (в Supabase его нет или БД не отвечает)`);
    const profile: Profile =
      courtsOverride === null ? envProfile : { ...envProfile, rule: { ...envProfile.rule, courts: courtsOverride } };
    return { profile, mode: null, warnings };
  }

  // Корты: payload → правило из БД → ENV-профиль. Без кортов бронировать нечем.
  const courts = courtsOverride ?? dbCourts ?? envProfile?.rule.courts ?? null;
  if (courts === null) {
    throw new Error(
      `У профиля "${profileId}" в Supabase нет ни одного включённого правила с кортами, а ENV-профиля нет — ` +
        'бронировать нечем. Добавь сценарий: «⏰ Расписание» в боте (или /add_rule).',
    );
  }
  if (courtsOverride === null && dbCourts === null) {
    warnings.push('корты взяты из ENV: включённого правила в Supabase нет');
  }

  const chatId = dbProfile.telegramChatId ?? envProfile?.telegramChatId;
  const profile: Profile = {
    id: dbProfile.id,
    label: dbProfile.label,
    contact: { name: dbProfile.name, email: dbProfile.email, phone: dbProfile.phone },
    ...(chatId === undefined || chatId === null ? {} : { telegramChatId: chatId }),
    rule: {
      times: [time],
      courts,
      ...(dbCourts !== null && dbDays !== null ? { daysOfWeek: dbDays } : {}),
      ...(dbCourts === null && envProfile?.rule.daysOfWeek !== undefined
        ? { daysOfWeek: envProfile.rule.daysOfWeek }
        : {}),
    },
  };
  logger.info(`профиль "${profileId}" взят из Supabase, корты: ${courts.join(', ')}`);
  return { profile, mode: dbMode, warnings };
}

/** Ран упал ДО отчёта: сообщение собираем из payload, других данных нет. */
function crashText(payload: BookSlotDropPayload, detail: string): string {
  return [
    '❌ <b>Дроп сорвался</b>',
    `${escapeHtml(payload.profileId)} · ${escapeHtml(payload.date)} ${escapeHtml(payload.time)} · ` +
      (payload.live ? 'LIVE' : 'DRY'),
    `Ран упал до отчёта: ${escapeHtml(detail)}`,
    'Слот, скорее всего, НЕ забронирован — смотри ран в trigger.dev.',
  ].join('\n');
}

export const bookSlotDropTask = task({
  id: 'book-slot-drop',
  // не ретраить: повторный run() при live:true рискует создать вторую реальную
  // бронь на тот же слот — состояние может не пережить ран (деградация в память)
  retry: { maxAttempts: 1 },
  // и по той же причине — никаких параллельных run'ов этого таска
  queue: { concurrencyLimit: 1 },
  run: async (payload: BookSlotDropPayload): Promise<DropReport> => {
    const { profileId, date, time, live } = payload;

    // Адресат отчёта нужен и в крах-ветке, поэтому вычисляем его первым делом
    // и не даём упасть даже здесь.
    let target: TelegramTarget | null = null;
    try {
      target = telegramFromEnv(process.env);
    } catch (err) {
      logger.error(`Telegram: настройки не разобрались: ${redactSecrets(describeError(err))}`);
    }
    if (target === null) {
      // Настроена ровно половина — это почти наверняка забытая переменная, а не
      // осознанное «Telegram выключен». Инвариант «одно сообщение за ран» при
      // этом молча перестаёт работать, а отправить предупреждение некуда:
      // остаётся сделать его максимально заметным в логах рана.
      const missing = TELEGRAM_ENV_NAMES.filter((name) => (process.env[name] ?? '').trim() === '');
      if (missing.length < TELEGRAM_ENV_NAMES.length) {
        logger.error(
          `Telegram настроен наполовину: не задано ${missing.join(', ')} — отчёт о дропе НЕ уйдёт никуда. ` +
            'Добавь переменную в trigger.dev (или в .env и передеплой) — иначе результат вечера виден только здесь.',
        );
      } else {
        logger.warn('Telegram не настроен (TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID) — отчёт останется только в логах рана');
      }
    }
    /** Ровно одно сообщение за ран: взведён — крах-ветка молчит. */
    let reported = false;
    /**
     * Куда писать квитанцию вечера; null — Supabase не настроен (тогда её
     * некуда писать, и heartbeat увидит слот без отчёта). Объявлено ДО try,
     * потому что квитанцию пишет и крах-ветка.
     */
    let receiptTarget: SupabaseRepoOptions | null = null;

    /**
     * Квитанция «за этот слот отчитались» — best-effort. Ни один её отказ не
     * имеет права уронить ран или изменить то, что уже ушло в Telegram: цена
     * потерянной квитанции — ложная тревога heartbeat'а, цена упавшего рана —
     * бронь. DRY пишет под id с суффиксом ':dry' (как и state, см.
     * DRY_PROFILE_SUFFIX): репетиция не должна выдавать себя за боевой отчёт и
     * прятать от heartbeat'а молчание настоящего дропа.
     */
    const recordReceipt = async (ok: boolean, telegramOk: boolean): Promise<void> => {
      if (receiptTarget === null) {
        logger.warn(
          'квитанция вечера не записана: SUPABASE_* не заданы — heartbeat не отличит этот слот от несостоявшегося рана',
        );
        return;
      }
      try {
        await new DropReportsRepo(receiptTarget).record({
          profileId: live ? profileId : `${profileId}${DRY_PROFILE_SUFFIX}`,
          date,
          time,
          ok,
          telegramOk,
          createdAt: tbilisiStamp(new Date()),
        });
      } catch (err) {
        logger.error(
          `квитанция вечера не записана (${redactSecrets(describeError(err))}) — heartbeat может поднять ложную ` +
            `тревогу по ${date} ${time}; на бронь и отчёт это не влияет`,
        );
      }
    };

    try {
      logger.info('book-slot-drop: старт', { profileId, date, time, live });

      const supabaseUrl = process.env.SUPABASE_URL?.trim() ?? '';
      const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ?? '';
      const supabaseOpts: SupabaseRepoOptions | null =
        supabaseUrl !== '' && supabaseKey !== ''
          ? { url: supabaseUrl, serviceKey: supabaseKey, timeoutMs: SKIP_CHECK_TIMEOUT_MS }
          : null;
      // С этого момента крах-ветка тоже умеет оставить квитанцию.
      receiptTarget = supabaseOpts;

      // ENV-профиль собираем «мягко»: для профиля, живущего только в Supabase
      // (заведён через /add_profile), отсутствие CLIENT_*/PROFILE_<K>_* — не
      // повод падать.
      let envProfile: Profile | null = null;
      let envProblem: string | null = null;
      try {
        const profiles = loadProfiles(process.env);
        envProfile = profiles.find((p) => p.id === profileId) ?? null;
        if (envProfile === null) envProblem = `в ENV есть только: ${profiles.map((p) => p.id).join(', ')}`;
      } catch (err) {
        envProblem = `ENV-профили не собрались: ${redactSecrets(describeError(err))}`;
      }

      const resolved = await resolveProfile({
        profileId,
        time,
        supabase: supabaseOpts,
        envProfile,
        envProblem,
        courtsOverride: normalizeCourts(payload.courts),
      });
      const profile = resolved.profile;
      const profileWarning = resolved.warnings.length === 0 ? undefined : resolved.warnings.join(' · ');
      // Режим: payload → правило профиля → 'priority'. Явный payload нужен
      // ручным прогонам вахты, правило — плановым (его ставит мастер расписаний).
      const mode: DropMode = normalizeMode(payload.mode) ?? resolved.mode ?? 'priority';
      logger.info(
        `book-slot-drop: набор кортов ${profile.rule.courts.join(', ')}, режим ${mode === 'all' ? 'все появившиеся' : 'первый по приоритету'}`,
      );
      // У профиля может быть свой чат (мультипрофиль) — с этого момента отчёт
      // и крах-сообщение уходят именно туда. Глобального TELEGRAM_CHAT_ID при
      // этом может не быть вовсе (у каждого профиля свой чат): бот-токена и
      // chat_id профиля достаточно, иначе профиль остался бы без единого
      // сообщения за вечер.
      if (profile.telegramChatId !== undefined) {
        const botToken = process.env.TELEGRAM_BOT_TOKEN?.trim() ?? '';
        if (target !== null) {
          target = { ...target, chatId: profile.telegramChatId };
        } else if (botToken !== '') {
          target = { botToken, chatId: profile.telegramChatId };
          logger.info(`Telegram: адресат взят из профиля "${profileId}" (глобальный TELEGRAM_CHAT_ID не задан)`);
        }
      }

      // Правило профиля может ограничивать дни недели — молча бронировать
      // «лишний» день нельзя, поэтому громкий отказ, а не тихий пропуск.
      if (!payload.force && !ruleAppliesOn(profile.rule, date)) {
        throw new Error(
          `Дата ${date} вне дней недели профиля "${profileId}" (daysOfWeek=${(profile.rule.daysOfWeek ?? []).join(',')}). ` +
            'Передай force:true, если бронь всё равно нужна.',
        );
      }

      // ---- скип на этот день ----
      // Вторая линия обороны: планировщик уже проверял скип, когда ставил ран,
      // но между планированием и дропом человек мог нажать «⏭ Пропустить».
      // Проверяем ДО ожидания окна — ран не должен зря держать очередь — и
      // ПОВТОРНО перед самым окном (см. ниже): между этими двумя моментами
      // проходит около двух минут, и всё это время кнопка «Пропустить» жива.
      // Скип живёт под настоящим id профиля: DRY-суффикс тут ни при чём,
      // «сегодня не играем» одинаково верно и для репетиции.
      const skips = supabaseOpts === null ? null : new SkipsRepo(supabaseOpts);
      let skipWarning: string | undefined;

      /** Единственное сообщение такого рана: осознанный пропуск, а не ошибка. */
      const reportSkipped = async (when: string): Promise<DropReport> => {
        logger.info(`book-slot-drop: ${date} пропущен по команде профиля "${profileId}" (${when}) — брони не будет`);
        reported = true;
        // ok=false: брони по итогам этого рана нет. Скип — не провал, и
        // heartbeat его различает сам (он видит тот же skip в таблице skips и
        // отчёта по такому слоту не ждёт); квитанция здесь на случай, если скип
        // поставили уже ПОСЛЕ планирования вечера.
        await recordReceipt(false, await deliver(target, skippedText(payload)));
        return {
          ok: false,
          profileId,
          date,
          time,
          // Ни один корт не трогали — по кортам сообщать нечего.
          results: [],
          timeline: [{ at: tbilisiStamp(new Date()), event: `пропущено по команде (скип на этот день, ${when})` }],
        };
      };

      /** true — скип стоит. Отказ проверки не отменяет дроп, но запоминается. */
      const checkSkipped = async (): Promise<boolean> => {
        if (skips === null) return false;
        try {
          return await skips.isSkipped(profileId, date);
        } catch (err) {
          // Проверку скипа сорвала сеть/схема. Отменять из-за этого дроп нельзя
          // (пропущенный корт не вернуть), но и молчать про это нельзя: скип
          // мог быть, и тогда бронь окажется лишней — её видно в отчёте.
          skipWarning = `скип не проверен (${redactSecrets(describeError(err))}) — если день был помечен «пропустить», бронь всё равно могла уйти`;
          logger.warn(skipWarning);
          return false;
        }
      };

      if (skips === null) logger.info('скипы не проверяются: SUPABASE_* не заданы');
      if (await checkSkipped()) return reportSkipped('старт рана');

      // Ран, поставленный сильно раньше окна, был бы убит по maxDuration прямо
      // во сне — без отчёта и без брони, то есть молчаливым провалом. Лучше
      // громко отказаться сейчас. (Уже закрытое окно обрабатывает движок: он
      // вернёт нормальный DropReport с Timeout, и отчёт уйдёт как обычно.)
      const watch = dropWatchWindow(dropDayOf(date), time);
      const waitMs = watch.start.getTime() - Date.now();
      if (waitMs > MAX_WAIT_TO_WINDOW_MS) {
        const advice = tbilisiStamp(new Date(watch.start.getTime() - RECOMMENDED_HEAD_START_MS));
        throw new Error(
          `Ран стартовал слишком рано: окно дропа откроется в ${tbilisiStamp(watch.start)}, ждать ` +
            `${Math.round(waitMs / 60_000)} мин, а maxDuration таска — ${MAX_RUN_MS / 1000} c. ` +
            `Ставь ран с delay на ${advice} (см. Runbook → «Вечерний облачный прогон»).`,
        );
      }

      // DRY не должен занимать боевой ключ идемпотентности — см. DRY_PROFILE_SUFFIX.
      const engineProfile: Profile = live ? profile : { ...profile, id: `${profile.id}${DRY_PROFILE_SUFFIX}` };

      // ---- выбор хранилища ----
      let memoryWarning: string | undefined;
      let resilient: ResilientStateStore | null = null;
      let state: StateStore;
      if (supabaseUrl !== '' && supabaseKey !== '') {
        resilient = new ResilientStateStore(
          new SupabaseStateStore({ url: supabaseUrl, serviceKey: supabaseKey, timeoutMs: DROP_STATE_TIMEOUT_MS }),
          (reason) => logger.error(reason),
        );
        state = resilient;
        // Первое обращение делаем сами и заранее: «нет таблицы» или «не тот
        // ключ» должны всплыть до окна дропа, а не в секунду POST. Читаем весь
        // слот: пробе не нужен конкретный корт.
        await state.listBookingsForSlot(engineProfile.id, date, time);
        if (resilient.warning === null) logger.info('state: Supabase доступен');
      } else {
        state = new MemoryStateStore();
        memoryWarning = 'state НЕ персистентен (Memory)';
        logger.warn(
          `${memoryWarning}: SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY не заданы — повторный ран на тот же слот может создать дубль брони`,
        );
      }

      const realClient = new ReservioClient({ log: (msg) => logger.info(msg) });

      // DRY-RUN: тот же движок (polling, окно, идемпотентность), но createBooking
      // подменён заглушкой — реального POST в Reservio API не происходит
      const client: Pick<ReservioClient, 'getAvailability' | 'createBooking' | 'cancelBooking' | 'getBooking'> = live
        ? realClient
        : {
            getAvailability: realClient.getAvailability.bind(realClient),
            cancelBooking: realClient.cancelBooking.bind(realClient),
            getBooking: realClient.getBooking.bind(realClient),
            createBooking: async (bookArgs: {
              serviceId: string;
              start: string;
              end: string;
              contact: ClientContact;
            }): Promise<BookingCreated> => {
              // contact НЕ логируем: имя/email/телефон — персональные данные.
              logger.info('[DRY] бронировал бы', {
                serviceId: bookArgs.serviceId,
                start: bookArgs.start,
                end: bookArgs.end,
                profileId: engineProfile.id,
              });
              return { bookingId: `dry-${Date.now()}`, token: 'dry-token', state: 'confirmed' };
            },
          };

      const deps: EngineDeps = {
        client: client as ReservioClient,
        state,
        log: (msg: string) => logger.info(msg),
      };

      // ---- скип, часть вторая ----
      // Ран стартует примерно за две минуты до окна: за это время человек
      // вполне может нажать «⏭ Пропустить» в pre-drop сообщении и получить
      // «бронировать не будем». Спим почти до окна и перечитываем skips —
      // иначе обещание было бы ложью, а корт оплаченным.
      const untilRecheck = watch.start.getTime() - SKIP_RECHECK_LEAD_MS - Date.now();
      if (skips !== null && untilRecheck > 0) {
        logger.info(`ждём ${Math.round(untilRecheck / 1000)} c и перепроверяем скип перед окном ${tbilisiStamp(watch.start)}`);
        await sleep(untilRecheck);
        if (await checkSkipped()) return reportSkipped('перед окном');
      }

      const report = await bookSlotDrop(engineProfile, { date, time, courts: engineProfile.rule.courts, mode }, deps);
      logger.info('book-slot-drop: финиш', {
        ok: report.ok,
        court: report.court,
        courts: (report.results ?? []).map((r) => `${r.court}:${r.ok ? 'ok' : 'нет'}`).join(' '),
        error: report.error,
      });

      // Предупреждение о state актуально уже после дропа: деградация могла
      // случиться и в середине polling.
      const stateWarning = resilient?.warning ?? memoryWarning;
      if (stateWarning !== undefined) logger.warn(`state: ${stateWarning}`);

      // Бронь есть, а state деградировал → saveBooking ушёл в память, которая
      // умрёт вместе с раном: token не сохранён НИГДЕ. Без него бронь не
      // прочитать и не отменить (PROTOCOL.md), поэтому в этом — и только в
      // этом — случае он остаётся в output рана. В Telegram его по-прежнему
      // нет, но там появляется строка о том, где искать управление бронью.
      // Только для LIVE: в DRY token синтетический, спасать нечего.
      const tokenLost = live && report.ok && stateWarning !== undefined && (report.token ?? '') !== '';
      if (report.ok && live) {
        logger.warn(
          tokenLost
            ? 'token брони НЕ сохранён в state (хранилище деградировало) — он остался только в output этого рана и в письме-подтверждении'
            : 'token брони не выводится в логи/output — он лежит в state и в письме-подтверждении',
        );
      }
      const stateLine =
        stateWarning !== undefined && tokenLost
          ? `${stateWarning} · token брони НЕ сохранён — отменять бронь только по ссылке из письма-подтверждения (сам token есть в output рана)`
          : stateWarning;
      // Предупреждений может быть несколько (неоднозначный POST, state,
      // непроверенный скип, откуда взялся профиль) — все должны попасть в
      // единственное сообщение вечера. Неоднозначный POST идёт первым: он
      // единственный требует немедленного действия человека.
      const warnings = [ambiguousWarning(report), stateLine, skipWarning, profileWarning].filter(
        (w): w is string => w !== undefined && w !== '',
      );
      const messageWarning = warnings.length === 0 ? undefined : warnings.join(' · ');

      let text: string;
      try {
        text = withCourtsSummary(
          formatDropReport(report, messageWarning === undefined ? {} : { stateWarning: messageWarning }),
          report,
        );
      } catch (err) {
        // Форматтер не имеет права стоить нам единственного сообщения за ран.
        text = fallbackReportText(report, redactSecrets(describeError(err)));
      }
      reported = true;
      // Чужой текст в detail мог процитировать контакт профиля — режем его и здесь.
      const telegramOk = await deliver(target, redactSecrets(text));
      // Квитанция — сразу после доставки и ДО напоминаний: она про инвариант
      // вечера, а напоминание про удобство.
      await recordReceipt(report.ok, telegramOk);

      // Напоминание за 2 часа ставим ПОСЛЕ отчёта: отчёт — инвариант вечера, а
      // напоминание приятный бонус, который не имеет права его задерживать или
      // ронять ран. Только LIVE: в DRY бронь синтетическая, напоминать не о чем.
      // В режиме 'all' броней за ран бывает несколько — напоминание ставится по
      // КАЖДОЙ: у них разные корты, а idempotencyKey напоминания идёт по
      // bookingId, так что дублей это не создаёт.
      if (live && report.ok) {
        for (const booked of successfulBookings(report)) {
          try {
            const outcome = await scheduleReminder(
              { profileId, date, time, court: booked.court, bookingId: booked.bookingId },
              target?.chatId ?? '',
              { log: (msg) => logger.info(msg) },
            );
            logger.info(`remind (${booked.court}): ${outcome}`);
          } catch (err) {
            logger.error(
              `remind (${booked.court}): напоминание не запланировано (бронь это не отменяет): ${redactSecrets(describeError(err))}`,
            );
          }
        }
      }

      return tokenLost ? report : redactToken(report);
    } catch (err) {
      const detail = redactSecrets(describeError(err));
      logger.error(`book-slot-drop: ран упал: ${detail}`);
      if (!reported) {
        reported = true;
        // Ран упал, но человек об этом узнал — квитанция обязана это
        // зафиксировать, иначе heartbeat разбудит админов второй раз тем же.
        await recordReceipt(false, await deliver(target, crashText(payload, detail)));
      }
      // Ран обязан упасть, но исходное сообщение могло содержать секрет или
      // контакт профиля — в дашборде оно осело бы навсегда. Подменяем ошибку
      // ТОЛЬКО когда redact реально что-то вырезал: иначе стек ценнее.
      if (err instanceof Error && detail !== describeError(err)) {
        const safe = new Error(detail, { cause: err });
        safe.name = err.name;
        throw safe;
      }
      throw err;
    }
  },
});
