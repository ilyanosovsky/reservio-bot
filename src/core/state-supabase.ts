// SupabaseStateStore — общий state в облаке: trigger.dev-воркеры и Telegram-бот
// смотрят в одну таблицу (better-sqlite3 на воркерах недоступен, MemoryStateStore
// не переживает run). Схема таблицы — docs/supabase-schema.sql.
//
// Почему чистый fetch, а не @supabase/supabase-js: нужны четыре запроса к
// PostgREST, ради них тянуть SDK в core-зависимости незачем (CLAUDE.md: «никаких
// лишних зависимостей в core»).
//
// Приватность: service-ключ живёт ТОЛЬКО в заголовках — никогда в URL, в тексте
// ошибок и в логах (redact вырезает его из всего, что уходит наружу). Класс
// вообще ничего не логирует: booking-token в этих строках дороже брони.

import type { StateStore, StoredBooking } from './state.js';

const DEFAULT_TIMEOUT_MS = 5_000;
const TABLE = 'bookings';
const COLUMNS = 'profile_id,date,time,court,booking_id,token,state,created_at';
/** Ключ дедупликации слота — тот же, что уникальный индекс в схеме. */
const CONFLICT_TARGET = 'profile_id,date,time';
/** Кусок чужого текста в ошибке обрезаем: тело ответа может быть большим. */
const ERROR_BODY_LIMIT = 300;

export interface SupabaseStateStoreOptions {
  /** https://<project>.supabase.co — без /rest/v1, хвостовые слэши допустимы. */
  url: string;
  /** service-ключ (SUPABASE_SERVICE_ROLE_KEY). anon-ключа не хватит. */
  serviceKey: string;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

export class SupabaseStateError extends Error {
  status?: number;
  code?: string;

  constructor(message: string, opts: { status?: number; code?: string; cause?: unknown } = {}) {
    super(message, { cause: opts.cause });
    this.name = 'SupabaseStateError';
    this.status = opts.status;
    this.code = opts.code;
  }
}

/** Строка таблицы: snake_case, как в PostgREST. */
interface BookingRow {
  profile_id: string;
  date: string;
  time: string;
  court: string;
  booking_id: string;
  token: string;
  state: string;
  created_at: string;
}

interface RequestSpec {
  method: 'GET' | 'POST' | 'PATCH';
  query: URLSearchParams;
  body?: unknown;
  prefer?: string;
  label: string;
}

interface PostgrestError {
  code?: string;
  message?: string;
  hint?: string;
}

function toRow(b: StoredBooking): BookingRow {
  return {
    profile_id: b.profileId,
    date: b.date,
    time: b.time,
    court: b.court,
    booking_id: b.bookingId,
    token: b.token,
    state: b.state,
    created_at: b.createdAt,
  };
}

function requireString(value: unknown, column: string, label: string): string {
  if (typeof value !== 'string') {
    throw new SupabaseStateError(
      `${label}: в строке таблицы ${TABLE} колонка "${column}" не строка (${typeof value}) — схема разъехалась с docs/supabase-schema.sql`,
      { code: 'unexpectedRow' },
    );
  }
  return value;
}

function fromRow(row: unknown, label: string): StoredBooking {
  if (typeof row !== 'object' || row === null) {
    throw new SupabaseStateError(`${label}: ожидалась строка таблицы ${TABLE}, пришло ${typeof row}`, {
      code: 'unexpectedRow',
    });
  }
  const r = row as Partial<BookingRow>;
  return {
    profileId: requireString(r.profile_id, 'profile_id', label),
    date: requireString(r.date, 'date', label),
    time: requireString(r.time, 'time', label),
    court: requireString(r.court, 'court', label),
    bookingId: requireString(r.booking_id, 'booking_id', label),
    // token — единственная терпимая колонка: бронь без token бесполезно ронять
    // на чтении, движок и так умеет жить с пустым токеном (только отменить нельзя).
    token: typeof r.token === 'string' ? r.token : '',
    state: requireString(r.state, 'state', label),
    createdAt: requireString(r.created_at, 'created_at', label),
  };
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class SupabaseStateStore implements StateStore {
  private readonly endpoint: string;
  private readonly serviceKey: string;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: SupabaseStateStoreOptions) {
    const url = opts.url?.trim() ?? '';
    const serviceKey = opts.serviceKey?.trim() ?? '';
    if (url === '') {
      throw new SupabaseStateError('SupabaseStateStore: пустой SUPABASE_URL', { code: 'invalidArgument' });
    }
    if (serviceKey === '') {
      throw new SupabaseStateError('SupabaseStateStore: пустой SUPABASE_SERVICE_ROLE_KEY', {
        code: 'invalidArgument',
      });
    }
    this.endpoint = `${url.replace(/\/+$/, '')}/rest/v1/${TABLE}`;
    this.serviceKey = serviceKey;
    this.fetchFn = opts.fetchFn ?? globalThis.fetch;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async getBooking(profileId: string, date: string, time: string): Promise<StoredBooking | null> {
    const query = new URLSearchParams({
      select: COLUMNS,
      profile_id: `eq.${profileId}`,
      date: `eq.${date}`,
      time: `eq.${time}`,
      limit: '1',
    });
    const label = 'getBooking';
    const rows = this.expectRows(await this.request({ method: 'GET', query, label }), label);
    return rows.length === 0 ? null : fromRow(rows[0], label);
  }

  async saveBooking(b: StoredBooking): Promise<void> {
    // upsert по уникальному индексу слота: повторная бронь того же слота
    // перезаписывает строку, а не плодит дубль (семантика INSERT OR REPLACE).
    const query = new URLSearchParams({ on_conflict: CONFLICT_TARGET });
    const label = 'saveBooking';
    const rows = this.expectRows(
      await this.request({
        method: 'POST',
        query,
        body: toRow(b),
        // return=representation — внешняя валидация записи: 2xx без строки в
        // ответе (например, upsert отфильтрован политикой) успехом не считаем.
        prefer: 'resolution=merge-duplicates,return=representation',
        label,
      }),
      label,
    );
    if (rows.length === 0) {
      throw new SupabaseStateError(
        'saveBooking: Supabase не вернул сохранённую строку — запись не подтверждена',
        { code: 'notPersisted' },
      );
    }
  }

  async listBookings(profileId?: string): Promise<StoredBooking[]> {
    const query = new URLSearchParams({ select: COLUMNS, order: 'date.asc,time.asc' });
    if (profileId !== undefined) query.set('profile_id', `eq.${profileId}`);
    const label = 'listBookings';
    const rows = this.expectRows(await this.request({ method: 'GET', query, label }), label);
    return rows.map((row) => fromRow(row, label));
  }

  async markCanceled(bookingId: string): Promise<void> {
    // Ноль совпадений — не ошибка: тот же контракт, что у SQLite/Memory.
    const query = new URLSearchParams({ booking_id: `eq.${bookingId}` });
    await this.request({
      method: 'PATCH',
      query,
      body: { state: 'canceled' },
      prefer: 'return=minimal',
      label: 'markCanceled',
    });
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
      throw new SupabaseStateError(
        aborted
          ? `${spec.label}: Supabase не ответил за ${this.timeoutMs} мс (таймаут)`
          : `${spec.label}: запрос к Supabase не выполнен — ${this.redact(errMessage(err))}`,
        { code: aborted ? 'timeout' : 'networkError', cause: err },
      );
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) throw this.httpError(spec.label, res.status, text);
    if (text.trim() === '') return null; // 204 (Prefer: return=minimal)
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new SupabaseStateError(`${spec.label}: ответ Supabase не является JSON`, {
        status: res.status,
        code: 'unexpectedResponse',
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
  private httpError(label: string, status: number, body: string): SupabaseStateError {
    const parsed = this.parseError(body);
    const code = parsed.code;
    const message = parsed.message ?? '';

    // Таблицы нет / PostgREST её не видит — самая частая ошибка первого запуска.
    if (code === 'PGRST205' || (status === 404 && /could not find the table/i.test(message))) {
      return new SupabaseStateError(
        `Таблица "${TABLE}" не найдена в Supabase — выполни DDL из docs/supabase-schema.sql в SQL Editor ` +
          `(если таблица есть, обнови кэш схемы: notify pgrst, 'reload schema') [${label}]`,
        { status, code },
      );
    }
    if (status === 401 || status === 403) {
      return new SupabaseStateError(
        `Supabase отклонил ключ (HTTP ${status}): проверь SUPABASE_SERVICE_ROLE_KEY (нужен service-ключ, не anon) ` +
          `и SUPABASE_URL [${label}]`,
        { status, code },
      );
    }
    const detail = message !== '' ? message : body.trim().slice(0, ERROR_BODY_LIMIT);
    return new SupabaseStateError(
      `${label}: Supabase вернул HTTP ${status}${code ? ` ${code}` : ''}${detail ? ` — ${this.redact(detail)}` : ''}`,
      { status, code },
    );
  }

  private parseError(body: string): PostgrestError {
    if (body.trim() === '') return {};
    try {
      const parsed = JSON.parse(body) as unknown;
      if (typeof parsed !== 'object' || parsed === null) return {};
      const { code, message, hint } = parsed as PostgrestError;
      return {
        code: typeof code === 'string' ? code : undefined,
        message: typeof message === 'string' ? message : undefined,
        hint: typeof hint === 'string' ? hint : undefined,
      };
    } catch {
      return {};
    }
  }

  private expectRows(payload: unknown, label: string): unknown[] {
    if (!Array.isArray(payload)) {
      throw new SupabaseStateError(`${label}: ожидался массив строк от PostgREST`, {
        code: 'unexpectedResponse',
      });
    }
    return payload;
  }

  /** Ключ не должен утечь наружу даже эхом из чужого текста. */
  private redact(text: string): string {
    return text.split(this.serviceKey).join('***');
  }
}
