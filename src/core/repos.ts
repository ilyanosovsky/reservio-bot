// Репозитории бота поверх Supabase/PostgREST: профили, правила расписания,
// скипы дней, настройки, квитанции вечерних отчётов и приглашения игроков.
// Схема — supabase/migrations/20260731110000_bot_core.sql плюс
// 20260801110000_multicourt.sql (mode/label у schedule_rules),
// 20260804140000_heartbeat.sql (drop_reports) и 20260804160000_invites.sql
// (profile_invites); тот же DDL в docs/supabase-schema.sql.
//
// Почему голый fetch, а не @supabase/supabase-js: те же соображения, что в
// state-supabase.ts — ради нескольких запросов к PostgREST тянуть SDK в core
// незачем (CLAUDE.md: «никаких лишних зависимостей в core»). Транспорт
// state-supabase.ts переиспользовать не стали намеренно: он приватный и заточен
// под одну таблицу bookings, а трогать боевой файл фазы 2 ради косметики
// дороже, чем повторить 60 строк. Стиль (заголовки, on_conflict, redact,
// таймаут, тексты ошибок) повторён один в один.
//
// Приватность: service-ключ живёт ТОЛЬКО в заголовках — никогда в URL и никогда
// в тексте ошибки (redact вырезает его из чужого текста). Модуль ничего не
// логирует: в profiles лежат email, телефон и chat_id — персональные данные, а
// в profile_invites — живые коды доступа к боту (секрет уровня guest-token).

import { randomBytes } from 'node:crypto';

import { tbilisiDateOf, tbilisiStamp } from './scheduler.js';

const DEFAULT_TIMEOUT_MS = 5_000;
/** Кусок чужого текста в ошибке обрезаем: тело ответа может быть большим. */
const ERROR_BODY_LIMIT = 300;
/** Миграция, создающая таблицы этого модуля — на неё ссылаются ошибки «нет таблицы». */
const MIGRATION_FILE = 'supabase/migrations/20260731110000_bot_core.sql';
/** Миграция мультикорта: колонки mode/label у schedule_rules. */
const MULTICOURT_MIGRATION = 'supabase/migrations/20260801110000_multicourt.sql';
/** Миграция heartbeat: таблица drop_reports (квитанции вечерних отчётов). */
const HEARTBEAT_MIGRATION = 'supabase/migrations/20260804140000_heartbeat.sql';
/** Миграция приглашений: таблица profile_invites (одноразовые коды привязки чата). */
const INVITES_MIGRATION = 'supabase/migrations/20260804160000_invites.sql';

const T_PROFILES = 'profiles';
const T_RULES = 'schedule_rules';
const T_SKIPS = 'skips';
const T_SETTINGS = 'settings';
const T_DROP_REPORTS = 'drop_reports';
const T_INVITES = 'profile_invites';

const PROFILE_COLUMNS = 'id,label,name,email,phone,telegram_chat_id,is_admin';
const RULE_COLUMNS = 'id,profile_id,times,courts,days_of_week,enabled,mode,label';
const DROP_REPORT_COLUMNS = 'profile_id,date,time,ok,telegram_ok,created_at';

/**
 * Какие миграции создают таблицу — на них ссылаются подсказки «нет таблицы» и
 * «схема разъехалась». drop_reports и profile_invites приехали отдельными
 * миграциями и своими подсказками: советовать применить bot_core тому, у кого
 * нет только квитанций (или только приглашений), значит отправить человека
 * чинить не тот файл.
 */
function migrationsFor(table: string): string {
  if (table === T_DROP_REPORTS) return HEARTBEAT_MIGRATION;
  if (table === T_INVITES) return INVITES_MIGRATION;
  return `${MIGRATION_FILE} и ${MULTICOURT_MIGRATION}`;
}

/** Режимы правила; см. ScheduleRuleRow.mode. */
const RULE_MODES = ['priority', 'all'] as const;
export type ScheduleMode = (typeof RULE_MODES)[number];

/** Ключ дедупликации скипа — тот же, что уникальный ключ в схеме. */
const SKIP_CONFLICT_TARGET = 'profile_id,date';

/**
 * Длина кода приглашения в БАЙТАХ: 16 байт crypto.randomBytes = 32 hex-символа
 * = 128 бит. Код — единственное исключение из инварианта тишины (см. InvitesRepo),
 * то есть по стойкости он должен быть паролем, а не «номером приглашения».
 */
const INVITE_CODE_BYTES = 16;

/**
 * Рамка допустимого кода на ВХОДЕ claim: то, что явно не может быть нашим кодом,
 * до Supabase не доезжает вовсе. Формат нарочно шире собственного (hex-32):
 * репозиторий отсекает мусор и мегабайтные строки из чужого `/start`, а не
 * навязывает формат ключа. Инъекции здесь и так нет — значение уезжает
 * URL-кодированным в один eq.-фильтр PostgREST.
 */
const INVITE_CODE_RE = /^[A-Za-z0-9_-]{8,128}$/;

const UPSERT_PREFER = 'resolution=merge-duplicates,return=representation';

export interface SupabaseRepoOptions {
  /** https://<project>.supabase.co — без /rest/v1, хвостовые слэши допустимы. */
  url: string;
  /** service-ключ (SUPABASE_SERVICE_ROLE_KEY). anon-ключа не хватит: гранты отозваны. */
  serviceKey: string;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

export interface ProfileRow {
  id: string;
  label: string;
  name: string;
  email: string;
  phone: string;
  /** null — профиль без доступа к боту (ему некуда слать и не от кого принимать). */
  telegramChatId: string | null;
  isAdmin: boolean;
}

export interface ScheduleRuleRow {
  id: string;
  profileId: string;
  /** ['20:00','21:00'] — каждое время это отдельный дроп и отдельная бронь. */
  times: string[];
  /** Набор кортов сценария; в режиме 'priority' порядок = приоритет. */
  courts: string[];
  /** [0..6], вс = 0; null = каждый день. */
  daysOfWeek: number[] | null;
  enabled: boolean;
  /**
   * 'priority' — первый доступный корт по приоритету и стоп (старое поведение);
   * 'all' — бронировать КАЖДЫЙ появившийся корт набора (вечерняя вахта: клуб
   * держит Court 2/3 на 20:00–22:00, в дроп выходит то один корт, то другой).
   */
  mode: ScheduleMode;
  /** Имя сценария в интерфейсе бота; '' = бот сгенерирует его сам. */
  label: string;
}

/**
 * Аргумент SchedulesRepo.upsert: без `id` — вставка нового правила (uuid выдаёт
 * БД), с `id` — обновление существующего. ScheduleRuleRow подходит сюда как есть.
 */
export type ScheduleRuleInput = Omit<ScheduleRuleRow, 'id'> & { id?: string };

/**
 * Квитанция о вечернем отчёте: «за слот (profileId, date, time) отчитались».
 * Пишет ран book-slot-drop сразу после доставки отчёта, читает heartbeat в 22:12
 * Тбилиси. Только по ней и видно, что вечер прошёл не молча: если рана не было
 * вовсе (умер воркер, не сработал планировщик), строки за слот просто нет.
 */
export interface DropReportRow {
  profileId: string;
  /** Дата игры (T+7), YYYY-MM-DD в Asia/Tbilisi. */
  date: string;
  /** Начало слота, HH:MM. */
  time: string;
  /** Исход дропа: бронь есть / брони нет. */
  ok: boolean;
  /** Отчёт реально доставлен в Telegram (а не просто сформирован). */
  telegramOk: boolean;
  /** ISO с явным +04:00 (scheduler.tbilisiStamp). */
  createdAt: string;
}

export class SupabaseRepoError extends Error {
  status?: number;
  code?: string;
  table?: string;

  constructor(message: string, opts: { status?: number; code?: string; table?: string; cause?: unknown } = {}) {
    super(message, { cause: opts.cause });
    this.name = 'SupabaseRepoError';
    this.status = opts.status;
    this.code = opts.code;
    this.table = opts.table;
  }
}

interface RequestSpec {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  query: URLSearchParams;
  body?: unknown;
  prefer?: string;
  label: string;
}

interface PostgrestError {
  code?: string;
  message?: string;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Ряд PostgREST как словарь; не-объект — сразу ошибка «схема разъехалась». */
function asRecord(row: unknown, table: string, label: string): Record<string, unknown> {
  if (typeof row !== 'object' || row === null || Array.isArray(row)) {
    throw new SupabaseRepoError(`${label}: ожидалась строка таблицы ${table}, пришло ${typeof row}`, {
      code: 'unexpectedRow',
      table,
    });
  }
  return row as Record<string, unknown>;
}

function drift(table: string, column: string, label: string, what: string): SupabaseRepoError {
  return new SupabaseRepoError(
    `${label}: в строке таблицы ${table} колонка "${column}" ${what} — схема разъехалась с ${migrationsFor(table)}`,
    { code: 'unexpectedRow', table },
  );
}

function requireString(r: Record<string, unknown>, column: string, table: string, label: string): string {
  const value = r[column];
  if (typeof value !== 'string') throw drift(table, column, label, `не строка (${typeof value})`);
  return value;
}

/** null/undefined/пустая строка -> null: «нет значения» и «пустое» здесь одно и то же. */
function nullableString(r: Record<string, unknown>, column: string, table: string, label: string): string | null {
  const value = r[column];
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw drift(table, column, label, `не строка и не null (${typeof value})`);
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Флаги читаем «наименьшими правами»: всё, что не строго true, — false.
 * Для is_admin это единственный безопасный дефолт, для enabled — единственный
 * безопасный по последствиям (мусор в колонке не должен бронировать корты).
 */
function boolFlag(r: Record<string, unknown>, column: string): boolean {
  return r[column] === true;
}

function requireStringArray(r: Record<string, unknown>, column: string, table: string, label: string): string[] {
  const value = r[column];
  if (!Array.isArray(value)) throw drift(table, column, label, 'не массив (jsonb)');
  if (value.length === 0) throw drift(table, column, label, 'пустой массив');
  for (const item of value) {
    if (typeof item !== 'string') throw drift(table, column, label, 'содержит не-строку');
  }
  return value as string[];
}

/**
 * Режим правила. Всё непонятное читаем как 'priority' — это «наименьшие права»
 * по последствиям: мусор в колонке не должен превращать сценарий в вахту,
 * которая набронирует несколько кортов на один час.
 */
function ruleMode(r: Record<string, unknown>): ScheduleMode {
  const value = r['mode'];
  return RULE_MODES.includes(value as ScheduleMode) ? (value as ScheduleMode) : 'priority';
}

function nullableDays(r: Record<string, unknown>, column: string, table: string, label: string): number[] | null {
  const value = r[column];
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value)) throw drift(table, column, label, 'не массив и не null (jsonb)');
  for (const item of value) {
    if (!Number.isInteger(item) || (item as number) < 0 || (item as number) > 6) {
      throw drift(table, column, label, 'содержит не день недели (ожидается 0–6, вс=0)');
    }
  }
  return value as number[];
}

/**
 * Общий транспорт к одной таблице PostgREST. Приватный для модуля: наружу
 * торчат только репозитории.
 */
abstract class PostgrestRepo {
  private readonly endpoint: string;
  private readonly serviceKey: string;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;

  protected constructor(
    protected readonly table: string,
    opts: SupabaseRepoOptions,
  ) {
    const url = opts.url?.trim() ?? '';
    const serviceKey = opts.serviceKey?.trim() ?? '';
    if (url === '') {
      throw new SupabaseRepoError(`Репозиторий "${table}": пустой SUPABASE_URL`, { code: 'invalidArgument', table });
    }
    if (serviceKey === '') {
      throw new SupabaseRepoError(`Репозиторий "${table}": пустой SUPABASE_SERVICE_ROLE_KEY`, {
        code: 'invalidArgument',
        table,
      });
    }
    this.endpoint = `${url.replace(/\/+$/, '')}/rest/v1/${table}`;
    this.serviceKey = serviceKey;
    this.fetchFn = opts.fetchFn ?? globalThis.fetch;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  protected async select(query: URLSearchParams, label: string): Promise<Record<string, unknown>[]> {
    const payload = await this.request({ method: 'GET', query, label });
    if (!Array.isArray(payload)) {
      throw new SupabaseRepoError(`${label}: ожидался массив строк от PostgREST`, {
        code: 'unexpectedResponse',
        table: this.table,
      });
    }
    return payload.map((row) => asRecord(row, this.table, label));
  }

  /**
   * Upsert с внешней валидацией записи: 2xx без строки в ответе успехом не
   * считаем (например, запись отфильтрована политикой).
   */
  protected async upsertRow(row: Record<string, unknown>, onConflict: string | null, label: string): Promise<void> {
    const query = new URLSearchParams();
    if (onConflict !== null) query.set('on_conflict', onConflict);
    const payload = await this.request({
      method: 'POST',
      query,
      body: row,
      prefer: onConflict === null ? 'return=representation' : UPSERT_PREFER,
      label,
    });
    if (!Array.isArray(payload) || payload.length === 0) {
      throw new SupabaseRepoError(`${label}: Supabase не вернул сохранённую строку — запись не подтверждена`, {
        code: 'notPersisted',
        table: this.table,
      });
    }
  }

  /**
   * PATCH с возвратом ИЗМЕНЁННЫХ строк (Prefer: return=representation).
   *
   * Не-массив в ответе — ошибка, а не «ноль строк»: на этом ответе стоит вывод
   * «условие не совпало», и для условных update'ов (InvitesRepo.claim) спутать
   * его с «PostgREST ответил что-то другое» значит признать код непогашенным
   * после того, как он уже сгорел.
   */
  protected async patchReturning(
    query: URLSearchParams,
    body: unknown,
    label: string,
  ): Promise<Record<string, unknown>[]> {
    const payload = await this.request({ method: 'PATCH', query, body, prefer: 'return=representation', label });
    if (!Array.isArray(payload)) {
      throw new SupabaseRepoError(`${label}: ожидался массив изменённых строк от PostgREST`, {
        code: 'unexpectedResponse',
        table: this.table,
      });
    }
    return payload.map((row) => asRecord(row, this.table, label));
  }

  /** Возвращает число изменённых строк (Prefer: return=representation). */
  protected async patchRows(query: URLSearchParams, body: unknown, label: string): Promise<number> {
    return (await this.patchReturning(query, body, label)).length;
  }

  protected async deleteRows(query: URLSearchParams, label: string): Promise<void> {
    // Ноль совпадений — не ошибка: удаление того, чего нет, идемпотентно.
    await this.request({ method: 'DELETE', query, prefer: 'return=minimal', label });
  }

  private async request(spec: RequestSpec): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let res: Response;
    let text: string;
    try {
      res = await this.fetchFn(`${this.endpoint}?${spec.query.toString()}`, {
        method: spec.method,
        headers: this.headers(spec),
        body: spec.body === undefined ? undefined : JSON.stringify(spec.body),
        signal: controller.signal,
      });
      text = await res.text();
    } catch (err) {
      const aborted = err instanceof Error && err.name === 'AbortError';
      throw new SupabaseRepoError(
        aborted
          ? `${spec.label}: Supabase не ответил за ${this.timeoutMs} мс (таймаут)`
          : `${spec.label}: запрос к Supabase не выполнен — ${this.redact(errMessage(err))}`,
        { code: aborted ? 'timeout' : 'networkError', table: this.table, cause: err },
      );
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) throw this.httpError(spec.label, res.status, text);
    if (text.trim() === '') return null; // 204 (Prefer: return=minimal)
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new SupabaseRepoError(`${spec.label}: ответ Supabase не является JSON`, {
        status: res.status,
        code: 'unexpectedResponse',
        table: this.table,
      });
    }
  }

  private headers(spec: RequestSpec): Record<string, string> {
    const headers: Record<string, string> = {
      apikey: this.serviceKey,
      Authorization: `Bearer ${this.serviceKey}`,
      Accept: 'application/json',
    };
    if (spec.body !== undefined) headers['Content-Type'] = 'application/json';
    if (spec.prefer !== undefined) headers['Prefer'] = spec.prefer;
    return headers;
  }

  /** Превращает ответ PostgREST в понятную ошибку с подсказкой, что чинить. */
  private httpError(label: string, status: number, body: string): SupabaseRepoError {
    const { code, message = '' } = this.parseError(body);

    // Таблицы/колонки нет, on_conflict не на что положить — всё это «миграция
    // не применена». Самая частая ошибка первого запуска бота.
    const schemaProblem =
      code === 'PGRST205' ||
      code === 'PGRST204' ||
      code === '42P10' ||
      code === '42703' || // undefined_column: нет mode/label — не доехала миграция мультикорта
      (status === 404 && /could not find the table/i.test(message));
    if (schemaProblem) {
      return new SupabaseRepoError(
        `Таблица "${this.table}" (или её колонки) не найдена в Supabase — применены ли миграции ` +
          `${migrationsFor(this.table)}? Без CLI: docs/supabase-schema.sql в SQL Editor. ` +
          `Если таблица есть, обнови кэш схемы: notify pgrst, 'reload schema' [${label}]`,
        { status, code, table: this.table },
      );
    }
    if (status === 401 || status === 403) {
      return new SupabaseRepoError(
        `Supabase отклонил ключ (HTTP ${status}): проверь SUPABASE_SERVICE_ROLE_KEY (нужен service-ключ, не anon) ` +
          `и SUPABASE_URL [${label}]`,
        { status, code, table: this.table },
      );
    }
    const detail = message !== '' ? message : body.trim().slice(0, ERROR_BODY_LIMIT);
    return new SupabaseRepoError(
      `${label}: Supabase вернул HTTP ${status}${code ? ` ${code}` : ''}${detail ? ` — ${this.redact(detail)}` : ''}`,
      { status, code, table: this.table },
    );
  }

  private parseError(body: string): PostgrestError {
    if (body.trim() === '') return {};
    try {
      const parsed = JSON.parse(body) as unknown;
      if (typeof parsed !== 'object' || parsed === null) return {};
      const { code, message } = parsed as PostgrestError;
      return {
        code: typeof code === 'string' ? code : undefined,
        message: typeof message === 'string' ? message : undefined,
      };
    } catch {
      return {};
    }
  }

  /** Ключ не должен утечь наружу даже эхом из чужого текста. */
  private redact(text: string): string {
    return text.split(this.serviceKey).join('***');
  }
}

/** Профили: allowlist Telegram (chat_id -> профиль) и контакт для guest-брони. */
export class ProfilesRepo extends PostgrestRepo {
  constructor(opts: SupabaseRepoOptions) {
    super(T_PROFILES, opts);
  }

  /**
   * Профиль по chat_id — единственная авторизация бота. Ничего не нашли —
   * значит чужой чат, и бот обязан промолчать (CLAUDE.md → Мультипрофили).
   */
  async getByChatId(chatId: string): Promise<ProfileRow | null> {
    const value = chatId?.trim() ?? '';
    // Пустой chat_id не бывает у настоящего апдейта Telegram, а eq. по пустой
    // строке — бессмысленный запрос: отвечаем «нет профиля» не ходя в сеть.
    if (value === '') return null;
    const query = new URLSearchParams({
      select: PROFILE_COLUMNS,
      telegram_chat_id: `eq.${value}`,
      limit: '1',
    });
    const label = 'getByChatId';
    const rows = await this.select(query, label);
    return rows.length === 0 ? null : this.toProfile(rows[0]!, label);
  }

  async getById(id: string): Promise<ProfileRow | null> {
    const query = new URLSearchParams({ select: PROFILE_COLUMNS, id: `eq.${id}`, limit: '1' });
    const label = 'getById';
    const rows = await this.select(query, label);
    return rows.length === 0 ? null : this.toProfile(rows[0]!, label);
  }

  async list(): Promise<ProfileRow[]> {
    const query = new URLSearchParams({ select: PROFILE_COLUMNS, order: 'id.asc' });
    const label = 'list';
    const rows = await this.select(query, label);
    return rows.map((row) => this.toProfile(row, label));
  }

  /**
   * Вставка или обновление по id. created_at в теле нет намеренно: PostgREST
   * обновляет только присланные колонки, поэтому дата создания переживает
   * повторный upsert, а на вставке её ставит default из миграции.
   */
  async upsert(p: ProfileRow): Promise<void> {
    const row: Record<string, unknown> = {
      id: p.id,
      label: p.label,
      name: p.name,
      email: p.email,
      phone: p.phone,
      telegram_chat_id: p.telegramChatId,
      is_admin: p.isAdmin,
    };
    try {
      await this.upsertRow(row, 'id', 'upsert');
    } catch (err) {
      // telegram_chat_id уникален: один чат = один профиль. Иначе бот не смог
      // бы решить, от чьего имени бронировать.
      if (err instanceof SupabaseRepoError && err.code === '23505') {
        throw new SupabaseRepoError(
          `upsert: этот telegram chat_id уже привязан к другому профилю — сначала освободи его (профиль ${p.id})`,
          { status: err.status, code: err.code, table: T_PROFILES, cause: err },
        );
      }
      throw err;
    }
  }

  private toProfile(row: Record<string, unknown>, label: string): ProfileRow {
    return {
      id: requireString(row, 'id', T_PROFILES, label),
      label: requireString(row, 'label', T_PROFILES, label),
      name: requireString(row, 'name', T_PROFILES, label),
      email: requireString(row, 'email', T_PROFILES, label),
      phone: requireString(row, 'phone', T_PROFILES, label),
      telegramChatId: nullableString(row, 'telegram_chat_id', T_PROFILES, label),
      isAdmin: boolFlag(row, 'is_admin'),
    };
  }
}

/** Правила расписания: времена, приоритет кортов, дни недели. */
export class SchedulesRepo extends PostgrestRepo {
  constructor(opts: SupabaseRepoOptions) {
    super(T_RULES, opts);
  }

  async listByProfile(profileId: string): Promise<ScheduleRuleRow[]> {
    const query = new URLSearchParams({
      select: RULE_COLUMNS,
      profile_id: `eq.${profileId}`,
      order: 'created_at.asc,id.asc',
    });
    const label = 'listByProfile';
    return (await this.select(query, label)).map((row) => this.toRule(row, label));
  }

  /** Все включённые правила всех профилей — вход планировщика. */
  async listEnabled(): Promise<ScheduleRuleRow[]> {
    const query = new URLSearchParams({
      select: RULE_COLUMNS,
      enabled: 'is.true',
      order: 'profile_id.asc,created_at.asc,id.asc',
    });
    const label = 'listEnabled';
    return (await this.select(query, label)).map((row) => this.toRule(row, label));
  }

  /**
   * Тумблер правила. Правило под этим id должно существовать: id прилетает из
   * inline-кнопки, и молчаливый no-op выглядел бы как «кнопка не работает».
   */
  async setEnabled(id: string, enabled: boolean): Promise<void> {
    const query = new URLSearchParams({ id: `eq.${id}` });
    const changed = await this.patchRows(query, { enabled }, 'setEnabled');
    if (changed === 0) {
      throw new SupabaseRepoError(`setEnabled: правило ${id} не найдено — возможно, оно уже удалено`, {
        code: 'notFound',
        table: T_RULES,
      });
    }
  }

  /**
   * Удаление сценария (кнопка «🗑» в «⏰ Расписание»). profile_id в фильтре —
   * защита в глубину: id приезжает из callback_data, а хендлер и без того
   * ищет правило среди своих. Уже созданные брони удаление не трогает.
   */
  async remove(id: string, profileId: string): Promise<void> {
    const query = new URLSearchParams({ id: `eq.${id}`, profile_id: `eq.${profileId}` });
    await this.deleteRows(query, 'remove');
  }

  /** Без `id` — новое правило (uuid выдаёт БД), с `id` — обновление существующего. */
  async upsert(r: ScheduleRuleInput): Promise<void> {
    const row: Record<string, unknown> = {
      profile_id: r.profileId,
      times: r.times,
      courts: r.courts,
      days_of_week: r.daysOfWeek,
      enabled: r.enabled,
      mode: r.mode,
      label: r.label,
    };
    if (r.id === undefined) {
      await this.upsertRow(row, null, 'upsert');
      return;
    }
    row['id'] = r.id;
    await this.upsertRow(row, 'id', 'upsert');
  }

  private toRule(row: Record<string, unknown>, label: string): ScheduleRuleRow {
    return {
      id: requireString(row, 'id', T_RULES, label),
      profileId: requireString(row, 'profile_id', T_RULES, label),
      times: requireStringArray(row, 'times', T_RULES, label),
      courts: requireStringArray(row, 'courts', T_RULES, label),
      daysOfWeek: nullableDays(row, 'days_of_week', T_RULES, label),
      enabled: boolFlag(row, 'enabled'),
      mode: ruleMode(row),
      // Имя сценария — косметика: пустое или неожиданное значение это ''
      // (бот сгенерирует подпись сам), ронять из-за него список правил незачем.
      label: typeof row['label'] === 'string' ? row['label'] : '',
    };
  }
}

/** Скипы: «в этот день не бронировать» — на весь день целиком. */
export class SkipsRepo extends PostgrestRepo {
  constructor(opts: SupabaseRepoOptions) {
    super(T_SKIPS, opts);
  }

  async isSkipped(profileId: string, date: string): Promise<boolean> {
    const query = new URLSearchParams({
      select: 'date',
      profile_id: `eq.${profileId}`,
      date: `eq.${date}`,
      limit: '1',
    });
    return (await this.select(query, 'isSkipped')).length > 0;
  }

  /** Повторный скип того же дня — не ошибка: кнопка в боте нажимается дважды. */
  async add(profileId: string, date: string): Promise<void> {
    await this.upsertRow({ profile_id: profileId, date }, SKIP_CONFLICT_TARGET, 'add');
  }

  async remove(profileId: string, date: string): Promise<void> {
    const query = new URLSearchParams({ profile_id: `eq.${profileId}`, date: `eq.${date}` });
    await this.deleteRows(query, 'remove');
  }

  /**
   * Скипы от сегодняшнего дня и дальше. `from` — дата отсечки (YYYY-MM-DD);
   * по умолчанию сегодня в зоне клуба, а не в таймзоне сервера.
   */
  async listUpcoming(profileId: string, from: string = tbilisiDateOf(new Date())): Promise<string[]> {
    const query = new URLSearchParams({
      select: 'date',
      profile_id: `eq.${profileId}`,
      date: `gte.${from}`,
      order: 'date.asc',
    });
    const label = 'listUpcoming';
    return (await this.select(query, label)).map((row) => requireString(row, 'date', T_SKIPS, label));
  }
}

/** Глобальные настройки бота (например, planner_enabled). */
export class SettingsRepo extends PostgrestRepo {
  constructor(opts: SupabaseRepoOptions) {
    super(T_SETTINGS, opts);
  }

  /** null — ключа нет. Значение неожиданного типа тоже читаем как «нет». */
  async get(key: string): Promise<string | null> {
    const query = new URLSearchParams({ select: 'value', key: `eq.${key}`, limit: '1' });
    const rows = await this.select(query, 'get');
    if (rows.length === 0) return null;
    const value = rows[0]!['value'];
    return typeof value === 'string' ? value : null;
  }

  async set(key: string, value: string): Promise<void> {
    await this.upsertRow({ key, value }, 'key', 'set');
  }
}

/**
 * Квитанции вечерних отчётов (таблица drop_reports, миграция heartbeat).
 *
 * Пишутся дропом, читаются heartbeat'ом. Ключ идемпотентности здесь НЕ нужен:
 * повторный ран того же слота обязан оставить вторую строку, а не переписать
 * первую — heartbeat'у важно «отчитались ли хоть раз», а истории вечеров
 * дублирующая строка не мешает.
 */
export class DropReportsRepo extends PostgrestRepo {
  constructor(opts: SupabaseRepoOptions) {
    super(T_DROP_REPORTS, opts);
  }

  /** Вставка квитанции. id и default created_at ставит БД, но stamp шлём свой. */
  async record(r: DropReportRow): Promise<void> {
    await this.upsertRow(
      {
        profile_id: r.profileId,
        date: r.date,
        time: r.time,
        ok: r.ok,
        telegram_ok: r.telegramOk,
        created_at: r.createdAt,
      },
      null,
      'record',
    );
  }

  /** Все квитанции за дату игры — ровно то, чем heartbeat сверяет план вечера. */
  async listForDate(date: string): Promise<DropReportRow[]> {
    const query = new URLSearchParams({
      select: DROP_REPORT_COLUMNS,
      date: `eq.${date}`,
      order: 'created_at.asc',
    });
    const label = 'listForDate';
    return (await this.select(query, label)).map((row) => this.toReport(row, label));
  }

  private toReport(row: Record<string, unknown>, label: string): DropReportRow {
    return {
      profileId: requireString(row, 'profile_id', T_DROP_REPORTS, label),
      date: requireString(row, 'date', T_DROP_REPORTS, label),
      time: requireString(row, 'time', T_DROP_REPORTS, label),
      // Флаги читаем «наименьшими правами»: всё, что не строго true, — false.
      // Для telegram_ok это единственный безопасный дефолт по последствиям:
      // мусор в колонке заставит heartbeat разбудить админа, а не промолчать.
      ok: boolFlag(row, 'ok'),
      telegramOk: boolFlag(row, 'telegram_ok'),
      createdAt: requireString(row, 'created_at', T_DROP_REPORTS, label),
    };
  }
}

/**
 * Приглашения игроков (таблица profile_invites, миграция 20260804160000).
 *
 * Зачем. Авторизация бота — allowlist telegram_chat_id -> профиль, чужому чату
 * бот молчит полностью. Поэтому новый игрок не может представиться боту сам:
 * его chat_id взять неоткуда, пока он боту не написал, а на его сообщение бот
 * обязан молчать. Мост — одноразовый код: админ заводит профиль мастером,
 * получает ссылку `https://t.me/<bot>?start=inv_<code>`, игрок открывает её, и
 * бот привязывает чат к профилю. Это ЕДИНСТВЕННОЕ исключение из тишины.
 *
 * Отсюда требования к коду: неугадываемый (128 бит из crypto.randomBytes) и
 * сгораемый ровно один раз (used_at). Сам код — секрет уровня guest-token: не
 * логировать, не показывать никому кроме админа, который его выдаёт.
 */
export class InvitesRepo extends PostgrestRepo {
  constructor(opts: SupabaseRepoOptions) {
    super(T_INVITES, opts);
  }

  /**
   * Выдать код для профиля. Возвращает сам код — его показывают ОДИН раз, в
   * ссылке админу; из базы он больше не читается ни одним методом.
   *
   * created_at не шлём: его ставит default миграции (как у profiles).
   */
  async create(profileId: string): Promise<string> {
    const id = profileId?.trim() ?? '';
    if (id === '') {
      throw new SupabaseRepoError('create: пустой profile_id — приглашение некому выдавать', {
        code: 'invalidArgument',
        table: T_INVITES,
      });
    }
    const code = randomBytes(INVITE_CODE_BYTES).toString('hex');
    // upsertRow с onConflict=null: код — первичный ключ и он случайный, так что
    // «слить дубликаты» здесь нечего, а вот подтверждение записи обязательно.
    // Иначе админ отправит игроку ссылку с кодом, которого в базе нет.
    await this.upsertRow({ code, profile_id: id }, null, 'create');
    return code;
  }

  /**
   * Погасить код и узнать, к какому профилю он вёл. `null` — код не подошёл;
   * «нет такого кода» и «код уже использован» снаружи НЕразличимы намеренно:
   * бот на оба случая обязан промолчать, а разное поведение подсказало бы
   * перебирающему, что он угадал живой код.
   *
   * Атомарность. Гасим ОДНИМ запросом: `PATCH ?code=eq.<code>&used_at=is.null`
   * — то есть `update ... where code = $1 and used_at is null`. Postgres
   * сериализует конкурирующие update'ы одной строки: проигравший перечитывает
   * её уже под блокировкой, видит заполненный used_at и под условие не подходит.
   * Поэтому двойной тап по ссылке (или гонка двух чатов за один код) даёт ровно
   * одну привязку — пустой ответ у второго. Связка «сначала select, потом
   * update» такой гарантии не даёт вообще.
   *
   * chatId в таблицу НЕ пишем: привязка живёт в profiles.telegram_chat_id, и
   * размазывать персональные данные по второй таблице незачем. Здесь он нужен
   * как страховка от «погасили код, а привязывать не к чему»: без адресата код
   * не тратим.
   */
  async claim(code: string, chatId: string): Promise<{ profileId: string } | null> {
    const value = code?.trim() ?? '';
    // Мусор из чужого /start до Supabase не доезжает: ответ тот же самый (null),
    // но и запроса нет.
    if (!INVITE_CODE_RE.test(value)) return null;
    if ((chatId?.trim() ?? '') === '') return null;

    const query = new URLSearchParams({
      select: 'profile_id',
      code: `eq.${value}`,
      used_at: 'is.null',
    });
    const label = 'claim';
    const rows = await this.patchReturning(query, { used_at: tbilisiStamp(new Date()) }, label);
    if (rows.length === 0) return null;
    return { profileId: requireString(rows[0]!, 'profile_id', T_INVITES, label) };
  }
}
