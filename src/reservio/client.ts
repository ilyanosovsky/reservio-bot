/**
 * Клиент Reservio API v2 (JSON:API, guest-флоу без авторизации).
 * Протокол и подтверждённые грабли — docs/PROTOCOL.md.
 *
 * Инварианты:
 *  - успех POST /bookings = наличие data.id (и только оно);
 *  - успех отмены = data.attributes.state === "canceled" в ответе (HTTP 200 ничего не значит:
 *    неверный state API молча игнорирует и возвращает 200-эхо со старым состоянием);
 *  - POST не ретраится никогда (риск дубля брони).
 */

import { API_BASE, BUSINESS_ID } from './types.js';
import type { BookingCreated, ClientContact, Slot } from './types.js';

const JSON_API_MEDIA_TYPE = 'application/vnd.api+json';

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_RETRIES = 3;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;

/** Слотов на один корт/день ≤ ~15 — одной страницы хватает с запасом. */
const AVAILABILITY_PAGE_LIMIT = 50;

export interface ReservioClientOptions {
  fetchFn?: typeof fetch;
  timeoutMs?: number;
  maxRetries?: number;
  log?: (msg: string) => void;
}

export class ReservioApiError extends Error {
  status?: number;
  code?: string;

  constructor(message: string, opts: { status?: number; code?: string; cause?: unknown } = {}) {
    super(message, { cause: opts.cause });
    this.name = 'ReservioApiError';
    this.status = opts.status;
    this.code = opts.code;
  }
}

interface JsonApiError {
  code?: string;
  title?: string;
  detail?: string;
}

interface JsonApiResource {
  id?: string;
  type?: string;
  attributes?: Record<string, unknown>;
  relationships?: Record<string, unknown>;
}

interface JsonApiDoc {
  data?: JsonApiResource | JsonApiResource[] | null;
  errors?: JsonApiError[];
  meta?: Record<string, unknown>;
}

interface RawResponse {
  status: number;
  ok: boolean;
  text: string;
  retryAfter: string | null;
}

interface RequestSpec {
  method: 'GET' | 'POST' | 'PATCH';
  url: string;
  body?: unknown;
  /** false — только для POST /bookings: повтор создал бы дубль брони. */
  retry: boolean;
  label: string;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function describeErrors(errors: JsonApiError[] | undefined): { code?: string; text: string } {
  const first = errors?.[0];
  if (!first) return { text: '' };
  const parts = [first.title, first.detail].filter(Boolean);
  return { code: first.code, text: parts.join(' — ') };
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Явный оффсет обязателен: наивный datetime уедет в таймзону сервера. */
function assertExplicitOffset(field: string, value: string): void {
  if (!/T\d{2}:\d{2}(:\d{2})?([+-]\d{2}:\d{2}|Z)$/.test(value)) {
    throw new ReservioApiError(
      `${field} должен быть ISO с явным оффсетом (например 2026-08-06T20:00:00+04:00), получено: "${value}"`,
      { code: 'invalidArgument' },
    );
  }
}

export class ReservioClient {
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly log: (msg: string) => void;

  constructor(opts: ReservioClientOptions = {}) {
    this.fetchFn = opts.fetchFn ?? globalThis.fetch;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = Math.max(1, opts.maxRetries ?? DEFAULT_MAX_RETRIES);
    this.log = opts.log ?? (() => {});
  }

  /** Свободные слоты корта на дату. API отдаёт ТОЛЬКО свободные — занятых в ответе просто нет. */
  async getAvailability(serviceId: string, date: string): Promise<Slot[]> {
    const query = new URLSearchParams({
      'filter[from]': date,
      'filter[to]': date,
      'filter[serviceId]': serviceId,
      'page[limit]': String(AVAILABILITY_PAGE_LIMIT),
    });
    const doc = await this.request({
      method: 'GET',
      url: `${API_BASE}/businesses/${BUSINESS_ID}/availability/booking-slots?${query.toString()}`,
      retry: true,
      label: 'availability',
    });

    const data = doc.data;
    if (!Array.isArray(data)) {
      throw new ReservioApiError('availability: ожидался массив data[]', { code: 'unexpectedResponse' });
    }

    // Порядок API не гарантирован (ночные часы идут в конце) — сохраняем как есть,
    // сравнение всегда по точной строке start, не по индексу.
    return data.map((item): Slot => {
      const start = str(item.attributes?.start);
      const end = str(item.attributes?.end);
      if (!start || !end) {
        throw new ReservioApiError('availability: слот без start/end', { code: 'unexpectedResponse' });
      }
      return { start, end };
    });
  }

  /** Guest-бронь. Успех — только при наличии data.id. Без ретраев. */
  async createBooking(args: {
    serviceId: string;
    start: string;
    end: string;
    contact: ClientContact;
  }): Promise<BookingCreated> {
    const { serviceId, start, end, contact } = args;
    if (!serviceId) {
      throw new ReservioApiError('createBooking: пустой serviceId', { code: 'invalidArgument' });
    }
    assertExplicitOffset('start', start);
    assertExplicitOffset('end', end);
    if (!contact.name || !contact.email || !contact.phone) {
      throw new ReservioApiError('createBooking: contact.name/email/phone обязательны', {
        code: 'invalidArgument',
      });
    }

    // resource-relationship опускаем: корт определяется по serviceId (подтверждено 30.07.2026).
    const payload = {
      data: {
        type: 'booking',
        attributes: { bookedClientName: contact.name, note: '' },
        relationships: {
          event: {
            data: {
              type: 'event',
              attributes: { start, end, name: contact.name, eventType: 'appointment' },
              relationships: {
                service: { data: { type: 'service', id: serviceId } },
              },
            },
          },
          client: {
            data: {
              type: 'client',
              attributes: { name: contact.name, email: contact.email, phone: contact.phone },
            },
          },
        },
      },
    };

    const doc = await this.request({
      method: 'POST',
      url: `${API_BASE}/businesses/${BUSINESS_ID}/bookings`,
      body: payload,
      retry: false,
      label: 'createBooking',
    });

    const resource = Array.isArray(doc.data) ? doc.data[0] : doc.data;
    const bookingId = str(resource?.id);
    if (!bookingId) {
      throw new ReservioApiError('createBooking: в ответе нет data.id — бронь не подтверждена', {
        code: 'unexpectedResponse',
      });
    }

    // Бронь уже создана: даже при кривом ответе возвращаем id, иначе потеряем её насовсем.
    const token = str(resource?.attributes?.token) ?? '';
    const state = str(resource?.attributes?.state) ?? 'unknown';
    if (!token) {
      this.log('createBooking: ВНИМАНИЕ — в ответе нет token, бронь нельзя будет отменить');
    }
    this.log(`createBooking: id=${bookingId} state=${state}`);
    return { bookingId, token, state };
  }

  /** Отмена. Успех ТОЛЬКО при state === "canceled" (одна L) в ответе. */
  async cancelBooking(bookingId: string, token: string): Promise<void> {
    const doc = await this.request({
      method: 'PATCH',
      url: this.bookingUrl(bookingId, token),
      body: {
        data: { type: 'booking', id: bookingId, attributes: { state: 'canceled' } },
      },
      retry: true, // идемпотентно: повторная отмена не создаёт побочных эффектов
      label: 'cancelBooking',
    });

    const resource = Array.isArray(doc.data) ? doc.data[0] : doc.data;
    const state = str(resource?.attributes?.state);
    if (state !== 'canceled') {
      throw new ReservioApiError(
        `cancelBooking: бронь не отменена, state="${state ?? 'нет в ответе'}" (API отвечает 200-эхо на неверный state)`,
        { code: 'notCanceled' },
      );
    }
    this.log(`cancelBooking: ${bookingId} → canceled`);
  }

  async getBooking(bookingId: string, token: string): Promise<{ state: string }> {
    const doc = await this.request({
      method: 'GET',
      url: this.bookingUrl(bookingId, token),
      retry: true,
      label: 'getBooking',
    });
    const resource = Array.isArray(doc.data) ? doc.data[0] : doc.data;
    const state = str(resource?.attributes?.state);
    if (!state) {
      throw new ReservioApiError('getBooking: в ответе нет data.attributes.state', {
        code: 'unexpectedResponse',
      });
    }
    return { state };
  }

  private bookingUrl(bookingId: string, token: string): string {
    return `${API_BASE}/businesses/${BUSINESS_ID}/bookings/${encodeURIComponent(bookingId)}?token=${encodeURIComponent(token)}`;
  }

  private async request(spec: RequestSpec): Promise<JsonApiDoc> {
    const maxAttempts = spec.retry ? this.maxRetries : 1;

    for (let attempt = 1; ; attempt++) {
      let raw: RawResponse;
      try {
        raw = await this.fetchOnce(spec);
      } catch (err) {
        // сеть/таймаут
        if (attempt < maxAttempts) {
          const delay = this.backoffMs(attempt, null);
          this.log(`${spec.label}: сетевая ошибка (${errMessage(err)}), повтор через ${delay}ms`);
          await sleep(delay);
          continue;
        }
        throw new ReservioApiError(`${spec.label}: запрос не выполнен — ${errMessage(err)}`, {
          code: 'networkError',
          cause: err,
        });
      }

      const doc = parseBody(raw.text, spec.label);

      if (raw.ok) return doc;

      const { code, text } = describeErrors(doc.errors);
      if (isRetryableStatus(raw.status) && attempt < maxAttempts) {
        const delay = this.backoffMs(attempt, raw.retryAfter);
        this.log(`${spec.label}: HTTP ${raw.status}, повтор через ${delay}ms (попытка ${attempt}/${maxAttempts})`);
        await sleep(delay);
        continue;
      }

      throw new ReservioApiError(
        `${spec.label}: HTTP ${raw.status}${code ? ` ${code}` : ''}${text ? ` — ${text}` : ''}`,
        { status: raw.status, code },
      );
    }
  }

  private async fetchOnce(spec: RequestSpec): Promise<RawResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const headers: Record<string, string> = { Accept: JSON_API_MEDIA_TYPE };
    if (spec.body !== undefined) headers['Content-Type'] = JSON_API_MEDIA_TYPE;

    try {
      const res = await this.fetchFn(spec.url, {
        method: spec.method,
        headers,
        body: spec.body === undefined ? undefined : JSON.stringify(spec.body),
        signal: controller.signal,
      });
      const text = await res.text();
      return {
        status: res.status,
        ok: res.ok,
        text,
        retryAfter: res.headers.get('Retry-After'),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Экспоненциальный backoff 1s→2s→4s…; Retry-After сервера уважаем (кап 30s). */
  private backoffMs(attempt: number, retryAfter: string | null): number {
    const fromHeader = retryAfter === null ? Number.NaN : Number(retryAfter);
    if (Number.isFinite(fromHeader) && fromHeader > 0) {
      return Math.min(fromHeader * 1000, BACKOFF_MAX_MS);
    }
    return Math.min(BACKOFF_BASE_MS * 2 ** (attempt - 1), BACKOFF_MAX_MS);
  }
}

function parseBody(text: string, label: string): JsonApiDoc {
  if (text.trim() === '') return {};
  try {
    return JSON.parse(text) as JsonApiDoc;
  } catch {
    throw new ReservioApiError(`${label}: ответ не является JSON`, { code: 'unexpectedResponse' });
  }
}

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.name === 'AbortError' ? 'таймаут' : err.message;
  return String(err);
}
