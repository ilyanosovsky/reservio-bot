import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReservioApiError, ReservioClient } from '../src/reservio/client.js';
import { API_BASE, BUSINESS_ID, COURTS, courtByName } from '../src/reservio/types.js';

const COURT3 = courtByName('Padel Court 3');
const DATE = '2026-08-06';
const START = '2026-08-06T20:00:00+04:00';
const END = '2026-08-06T20:59:00+04:00';
const CONTACT = { name: 'Test Guest', email: 'guest@example.com', phone: '+995500000000' };
const BOOKING_ID = 'b1f9a0e2-0000-4000-8000-000000000001';
const TOKEN = 'guest-token-abc';

function jsonRes(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/vnd.api+json', ...headers },
  });
}

/** Мок fetch: отдаёт заготовленные ответы по очереди. */
function fetchStub(...responses: Array<Response | (() => Response)>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let i = 0;
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = responses[Math.min(i, responses.length - 1)];
    i += 1;
    return typeof next === 'function' ? next() : next;
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const slotsDoc = (starts: string[]) => ({
  meta: { total: starts.length },
  data: starts.map((start, idx) => ({
    type: 'timeSlot',
    id: `slot-${idx}`,
    attributes: { createdAt: '2026-07-30T10:58:50+04:00', start, end: start.replace(':00:00+', ':59:00+') },
    relationships: { resource: { data: { id: COURT3.resourceId } } },
  })),
});

/** id: null — смоделировать ответ без data.id. */
const bookingDoc = (attrs: Record<string, unknown>, id: string | null = BOOKING_ID) => ({
  data: { type: 'booking', ...(id === null ? {} : { id }), attributes: attrs },
});

/** Прокручивает фейковые таймеры, пока промис не завершится (для backoff-пауз). */
async function withFakeTimers<T>(run: () => Promise<T>): Promise<T> {
  vi.useFakeTimers();
  try {
    const p = run();
    await vi.advanceTimersByTimeAsync(60_000);
    return await p;
  } finally {
    vi.useRealTimers();
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe('types', () => {
  it('COURTS содержит все 6 кортов, courtByName находит по имени и падает на неизвестном', () => {
    expect(COURTS).toHaveLength(6);
    expect(new Set(COURTS.map((c) => c.serviceId)).size).toBe(6);
    expect(courtByName('Padel Court 2').serviceId).toBe('c36479d3-8201-4d80-9822-e9c08014468b');
    expect(courtByName('  padel court 3 ').serviceId).toBe(COURT3.serviceId);
    expect(() => courtByName('Court 42')).toThrow(/Неизвестный корт/);
  });
});

describe('getAvailability', () => {
  it('строит URL и query по протоколу, без Authorization', async () => {
    const { fn, calls } = fetchStub(jsonRes(slotsDoc([])));
    await new ReservioClient({ fetchFn: fn }).getAvailability(COURT3.serviceId, DATE);

    expect(calls).toHaveLength(1);
    const url = new URL(calls[0]!.url);
    expect(`${url.origin}${url.pathname}`).toBe(
      `${API_BASE}/businesses/${BUSINESS_ID}/availability/booking-slots`,
    );
    expect(url.searchParams.get('filter[from]')).toBe(DATE);
    expect(url.searchParams.get('filter[to]')).toBe(DATE);
    expect(url.searchParams.get('filter[serviceId]')).toBe(COURT3.serviceId);
    expect(url.searchParams.get('page[limit]')).toBe('50');

    const init = calls[0]!.init;
    expect(init.method).toBe('GET');
    const headers = init.headers as Record<string, string>;
    expect(headers.Accept).toBe('application/vnd.api+json');
    expect(headers.Authorization).toBeUndefined();
    expect(headers['Content-Type']).toBeUndefined();
    expect(init.body).toBeUndefined();
  });

  it('парсит слоты в {start,end}, сохраняя порядок API', async () => {
    const { fn } = fetchStub(jsonRes(slotsDoc([START, '2026-08-06T01:00:00+04:00'])));
    const slots = await new ReservioClient({ fetchFn: fn }).getAvailability(COURT3.serviceId, DATE);

    expect(slots).toEqual([
      { start: START, end: END },
      { start: '2026-08-06T01:00:00+04:00', end: '2026-08-06T01:59:00+04:00' },
    ]);
  });

  it('пустой data[] — это норма до дропа, а не ошибка', async () => {
    const { fn } = fetchStub(jsonRes({ meta: { total: 0 }, data: [] }));
    await expect(new ReservioClient({ fetchFn: fn }).getAvailability(COURT3.serviceId, DATE)).resolves.toEqual([]);
  });

  it('неожиданный формат ответа — ReservioApiError', async () => {
    const noData = fetchStub(jsonRes({ meta: { total: 1 } }));
    await expect(
      new ReservioClient({ fetchFn: noData.fn }).getAvailability(COURT3.serviceId, DATE),
    ).rejects.toBeInstanceOf(ReservioApiError);

    const noStart = fetchStub(jsonRes({ data: [{ type: 'timeSlot', id: 'x', attributes: {} }] }));
    await expect(
      new ReservioClient({ fetchFn: noStart.fn }).getAvailability(COURT3.serviceId, DATE),
    ).rejects.toThrow(/слот без start\/end/);
  });

  it('4xx — ReservioApiError со status и code из JSON:API', async () => {
    const { fn } = fetchStub(jsonRes({ errors: [{ code: 'entityNotFound', title: 'Not found' }] }, 404));
    const err = await new ReservioClient({ fetchFn: fn })
      .getAvailability(COURT3.serviceId, DATE)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ReservioApiError);
    expect((err as ReservioApiError).status).toBe(404);
    expect((err as ReservioApiError).code).toBe('entityNotFound');
  });
});

describe('createBooking', () => {
  it('шлёт JSON:API payload ровно по PROTOCOL.md и возвращает id/token/state', async () => {
    const { fn, calls } = fetchStub(
      jsonRes(bookingDoc({ token: TOKEN, state: 'confirmed', via: 'application' }), 201),
    );
    const created = await new ReservioClient({ fetchFn: fn }).createBooking({
      serviceId: COURT3.serviceId,
      start: START,
      end: END,
      contact: CONTACT,
    });

    expect(created).toEqual({ bookingId: BOOKING_ID, token: TOKEN, state: 'confirmed' });

    const { url, init } = calls[0]!;
    expect(url).toBe(`${API_BASE}/businesses/${BUSINESS_ID}/bookings`);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/vnd.api+json');
    expect(JSON.parse(String(init.body))).toEqual({
      data: {
        type: 'booking',
        attributes: { bookedClientName: CONTACT.name, note: '' },
        relationships: {
          event: {
            data: {
              type: 'event',
              attributes: { start: START, end: END, name: CONTACT.name, eventType: 'appointment' },
              relationships: {
                service: { data: { type: 'service', id: COURT3.serviceId } },
              },
            },
          },
          client: {
            data: {
              type: 'client',
              attributes: { name: CONTACT.name, email: CONTACT.email, phone: CONTACT.phone },
            },
          },
        },
      },
    });
  });

  it('2xx без data.id — провал, а не «кажется, сработало»', async () => {
    const { fn } = fetchStub(jsonRes(bookingDoc({ state: 'confirmed' }, null)));
    await expect(
      new ReservioClient({ fetchFn: fn }).createBooking({
        serviceId: COURT3.serviceId,
        start: START,
        end: END,
        contact: CONTACT,
      }),
    ).rejects.toThrow(/нет data\.id/);
  });

  it('4xx (слот занят) — ReservioApiError со статусом', async () => {
    const { fn } = fetchStub(jsonRes({ errors: [{ code: 'slotNotAvailable', title: 'Taken' }] }, 422));
    const err = await new ReservioClient({ fetchFn: fn })
      .createBooking({ serviceId: COURT3.serviceId, start: START, end: END, contact: CONTACT })
      .catch((e: unknown) => e);

    expect((err as ReservioApiError).status).toBe(422);
    expect((err as ReservioApiError).code).toBe('slotNotAvailable');
  });

  it('id есть, token нет — бронь всё равно возвращается (иначе потеряем её)', async () => {
    const { fn } = fetchStub(jsonRes(bookingDoc({ state: 'confirmed' })));
    const logs: string[] = [];
    const created = await new ReservioClient({ fetchFn: fn, log: (m) => logs.push(m) }).createBooking({
      serviceId: COURT3.serviceId,
      start: START,
      end: END,
      contact: CONTACT,
    });

    expect(created.bookingId).toBe(BOOKING_ID);
    expect(created.token).toBe('');
    expect(logs.join('\n')).toMatch(/нет token/);
  });

  it('datetime без явного оффсета отвергается до запроса', async () => {
    const { fn, calls } = fetchStub(jsonRes(bookingDoc({ token: TOKEN, state: 'confirmed' })));
    await expect(
      new ReservioClient({ fetchFn: fn }).createBooking({
        serviceId: COURT3.serviceId,
        start: '2026-08-06T20:00:00',
        end: END,
        contact: CONTACT,
      }),
    ).rejects.toThrow(/явным оффсетом/);
    expect(calls).toHaveLength(0);
  });
});

describe('cancelBooking', () => {
  it('PATCH на /bookings/{id}?token= с body state="canceled"', async () => {
    const { fn, calls } = fetchStub(jsonRes(bookingDoc({ state: 'canceled' })));
    await new ReservioClient({ fetchFn: fn }).cancelBooking(BOOKING_ID, TOKEN);

    const { url, init } = calls[0]!;
    const parsed = new URL(url);
    expect(`${parsed.origin}${parsed.pathname}`).toBe(
      `${API_BASE}/businesses/${BUSINESS_ID}/bookings/${BOOKING_ID}`,
    );
    expect(parsed.searchParams.get('token')).toBe(TOKEN);
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(String(init.body))).toEqual({
      data: { type: 'booking', id: BOOKING_ID, attributes: { state: 'canceled' } },
    });
  });

  it('200-эхо со старым state ("confirmed") — это ПРОВАЛ отмены', async () => {
    const { fn } = fetchStub(jsonRes(bookingDoc({ state: 'confirmed' })));
    const err = await new ReservioClient({ fetchFn: fn })
      .cancelBooking(BOOKING_ID, TOKEN)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ReservioApiError);
    expect((err as ReservioApiError).code).toBe('notCanceled');
  });

  it('state отсутствует в ответе — тоже провал', async () => {
    const { fn } = fetchStub(jsonRes({ data: { type: 'booking', id: BOOKING_ID, attributes: {} } }));
    await expect(new ReservioClient({ fetchFn: fn }).cancelBooking(BOOKING_ID, TOKEN)).rejects.toBeInstanceOf(
      ReservioApiError,
    );
  });
});

describe('getBooking', () => {
  it('GET с token в query, возвращает state', async () => {
    const { fn, calls } = fetchStub(jsonRes(bookingDoc({ state: 'confirmed' })));
    const res = await new ReservioClient({ fetchFn: fn }).getBooking(BOOKING_ID, TOKEN);

    expect(res).toEqual({ state: 'confirmed' });
    expect(calls[0]!.init.method).toBe('GET');
    expect(new URL(calls[0]!.url).searchParams.get('token')).toBe(TOKEN);
  });
});

describe('ретраи и таймаут', () => {
  it('GET: 429 → backoff → 200', async () => {
    const { fn, calls } = fetchStub(
      () => jsonRes({ errors: [{ code: 'tooManyRequests' }] }, 429),
      () => jsonRes(slotsDoc([START])),
    );
    const client = new ReservioClient({ fetchFn: fn });

    const slots = await withFakeTimers(() => client.getAvailability(COURT3.serviceId, DATE));

    expect(slots).toEqual([{ start: START, end: END }]);
    expect(calls).toHaveLength(2);
  });

  it('GET: 5xx исчерпывает maxRetries попыток и падает', async () => {
    const { fn, calls } = fetchStub(() => jsonRes({ errors: [{ code: 'internalError' }] }, 503));
    const client = new ReservioClient({ fetchFn: fn, maxRetries: 3 });

    const err = await withFakeTimers(() =>
      client.getAvailability(COURT3.serviceId, DATE).catch((e: unknown) => e),
    );

    expect(err).toBeInstanceOf(ReservioApiError);
    expect((err as ReservioApiError).status).toBe(503);
    expect(calls).toHaveLength(3);
  });

  it('GET: сетевая ошибка ретраится', async () => {
    let n = 0;
    const fn = vi.fn(async () => {
      n += 1;
      if (n === 1) throw new TypeError('fetch failed');
      return jsonRes(slotsDoc([]));
    }) as unknown as typeof fetch;
    const client = new ReservioClient({ fetchFn: fn });

    await expect(withFakeTimers(() => client.getAvailability(COURT3.serviceId, DATE))).resolves.toEqual([]);
    expect(n).toBe(2);
  });

  it('POST createBooking при 429 НЕ ретраится (риск дубля)', async () => {
    const { fn, calls } = fetchStub(() => jsonRes({ errors: [{ code: 'tooManyRequests' }] }, 429));
    const client = new ReservioClient({ fetchFn: fn });

    const err = await withFakeTimers(() =>
      client
        .createBooking({ serviceId: COURT3.serviceId, start: START, end: END, contact: CONTACT })
        .catch((e: unknown) => e),
    );

    expect((err as ReservioApiError).status).toBe(429);
    expect(calls).toHaveLength(1);
  });

  it('POST createBooking при сетевой ошибке НЕ ретраится', async () => {
    let n = 0;
    const fn = vi.fn(async () => {
      n += 1;
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;

    await expect(
      new ReservioClient({ fetchFn: fn }).createBooking({
        serviceId: COURT3.serviceId,
        start: START,
        end: END,
        contact: CONTACT,
      }),
    ).rejects.toBeInstanceOf(ReservioApiError);
    expect(n).toBe(1);
  });

  it('запрос обрывается по таймауту 5s (дефолт)', async () => {
    vi.useFakeTimers();
    let aborted = false;
    const fn = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            aborted = true;
            reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
          });
        }),
    ) as unknown as typeof fetch;

    const client = new ReservioClient({ fetchFn: fn, maxRetries: 1 });
    const p = client.getAvailability(COURT3.serviceId, DATE).catch((e: unknown) => e);

    await vi.advanceTimersByTimeAsync(4_999);
    expect(aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(2);
    const err = await p;
    expect(aborted).toBe(true);
    expect(err).toBeInstanceOf(ReservioApiError);
    expect((err as ReservioApiError).code).toBe('networkError');
    expect((err as ReservioApiError).message).toMatch(/таймаут/);
  });

  it('Retry-After с сервера уважается вместо базового backoff', async () => {
    const { fn, calls } = fetchStub(
      () => jsonRes({ errors: [{ code: 'tooManyRequests' }] }, 429, { 'Retry-After': '3' }),
      () => jsonRes(slotsDoc([])),
    );
    const client = new ReservioClient({ fetchFn: fn });

    vi.useFakeTimers();
    const p = client.getAvailability(COURT3.serviceId, DATE);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(calls).toHaveLength(1); // базовой 1s паузы не хватило — ждём 3s
    await vi.advanceTimersByTimeAsync(1_500);
    await expect(p).resolves.toEqual([]);
    expect(calls).toHaveLength(2);
    vi.useRealTimers();
  });
});
