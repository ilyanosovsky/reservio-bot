// Тесты SupabaseStateStore. Никаких сетевых запросов: fetch всегда замокан,
// к реальному Supabase тесты не ходят (и не должны — ключ в CI отсутствует).
// Проверяем ровно то, что нельзя проверить типами: форму запроса к PostgREST
// (эндпоинт, фильтры eq., on_conflict, Prefer), маппинг snake_case <-> camelCase,
// понятные ошибки и то, что service-ключ не утекает наружу.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { SupabaseStateError, SupabaseStateStore } from '../src/core/state-supabase.js';
import type { StoredBooking } from '../src/core/state.js';

const URL_BASE = 'https://kbwmrqoxjlydmwyxirqm.supabase.co';
const KEY = 'sb_secret_TESTKEY_do_not_leak';

function booking(overrides: Partial<StoredBooking> = {}): StoredBooking {
  return {
    profileId: 'ilya',
    date: '2026-08-06',
    time: '20:00',
    court: 'Padel Court 3',
    bookingId: 'booking-1',
    token: 'token-1',
    state: 'confirmed',
    createdAt: '2026-07-30T19:58:51+04:00',
    ...overrides,
  };
}

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    profile_id: 'ilya',
    date: '2026-08-06',
    time: '20:00',
    court: 'Padel Court 3',
    booking_id: 'booking-1',
    token: 'token-1',
    state: 'confirmed',
    created_at: '2026-07-30T19:58:51+04:00',
    ...overrides,
  };
}

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
  params: URLSearchParams;
}

/** Мок fetch: отдаёт заготовленные ответы по очереди, пишет все вызовы. */
function fetchStub(...responses: Array<Response | (() => Response)>) {
  const calls: Call[] = [];
  let i = 0;
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const href = String(url);
    calls.push({
      url: href,
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
      params: new URL(href).searchParams,
    });
    const next = responses[Math.min(i, responses.length - 1)];
    i += 1;
    return typeof next === 'function' ? next() : next;
  }) as unknown as typeof fetch;
  return { fn, calls };
}

function makeStore(fn: typeof fetch, url = URL_BASE): SupabaseStateStore {
  return new SupabaseStateStore({ url, serviceKey: KEY, fetchFn: fn });
}

/** Ошибка отвергнутого промиса; успешное завершение — сам провал теста. */
function rejection(p: Promise<unknown>): Promise<Error> {
  return p.then(
    () => {
      throw new Error('ожидалась ошибка, но промис завершился успешно');
    },
    (err: unknown) => (err instanceof Error ? err : new Error(String(err))),
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('SupabaseStateStore: конструктор', () => {
  it('пустой url — понятная ошибка про SUPABASE_URL', () => {
    expect(() => new SupabaseStateStore({ url: '  ', serviceKey: KEY })).toThrow(/SUPABASE_URL/);
  });

  it('пустой ключ — понятная ошибка про SUPABASE_SERVICE_ROLE_KEY', () => {
    expect(() => new SupabaseStateStore({ url: URL_BASE, serviceKey: '' })).toThrow(
      /SUPABASE_SERVICE_ROLE_KEY/,
    );
  });

  it('хвостовой слэш в url не ломает эндпоинт', async () => {
    const { fn, calls } = fetchStub(jsonRes([]));
    await makeStore(fn, `${URL_BASE}/`).getBooking('ilya', '2026-08-06', '20:00');
    expect(calls[0]!.url.startsWith(`${URL_BASE}/rest/v1/bookings?`)).toBe(true);
  });
});

describe('SupabaseStateStore.getBooking', () => {
  it('шлёт GET с eq.-фильтрами по ключу слота и limit=1', async () => {
    const { fn, calls } = fetchStub(jsonRes([row()]));
    await makeStore(fn).getBooking('ilya', '2026-08-06', '20:00');

    const call = calls[0]!;
    expect(call.method).toBe('GET');
    expect(call.url.split('?')[0]).toBe(`${URL_BASE}/rest/v1/bookings`);
    expect(call.params.get('profile_id')).toBe('eq.ilya');
    expect(call.params.get('date')).toBe('eq.2026-08-06');
    expect(call.params.get('time')).toBe('eq.20:00');
    expect(call.params.get('limit')).toBe('1');
    expect(call.params.get('select')).toBe(
      'profile_id,date,time,court,booking_id,token,state,created_at',
    );
    expect(call.body).toBeUndefined();
  });

  it('шлёт apikey и Authorization: Bearer с service-ключом', async () => {
    const { fn, calls } = fetchStub(jsonRes([]));
    await makeStore(fn).getBooking('ilya', '2026-08-06', '20:00');

    expect(calls[0]!.headers['apikey']).toBe(KEY);
    expect(calls[0]!.headers['Authorization']).toBe(`Bearer ${KEY}`);
  });

  it('маппит snake_case-строку в StoredBooking без потерь', async () => {
    const { fn } = fetchStub(jsonRes([row()]));
    const got = await makeStore(fn).getBooking('ilya', '2026-08-06', '20:00');

    expect(got).toEqual(booking());
    // Оффсет +04:00 обязан пережить roundtrip — на нём держится всё расписание.
    expect(got?.createdAt).toBe('2026-07-30T19:58:51+04:00');
  });

  it('пустой массив -> null (слот не забронирован)', async () => {
    const { fn } = fetchStub(jsonRes([]));
    expect(await makeStore(fn).getBooking('ilya', '2026-08-06', '20:00')).toBeNull();
  });

  it('строка без token читается с пустым token, а не падает', async () => {
    const { fn } = fetchStub(jsonRes([row({ token: null })]));
    const got = await makeStore(fn).getBooking('ilya', '2026-08-06', '20:00');
    expect(got?.token).toBe('');
  });

  it('битая колонка -> ошибка про разъехавшуюся схему', async () => {
    const { fn } = fetchStub(jsonRes([row({ booking_id: 42 })]));
    await expect(makeStore(fn).getBooking('ilya', '2026-08-06', '20:00')).rejects.toThrow(
      /booking_id/,
    );
  });

  it('ответ не массив -> понятная ошибка, а не молчаливый null', async () => {
    const { fn } = fetchStub(jsonRes({ unexpected: true }));
    await expect(makeStore(fn).getBooking('ilya', '2026-08-06', '20:00')).rejects.toThrow(
      /массив строк/,
    );
  });
});

describe('SupabaseStateStore.saveBooking', () => {
  it('upsert: POST с on_conflict по ключу слота и Prefer merge-duplicates+representation', async () => {
    const { fn, calls } = fetchStub(jsonRes([row()], 201));
    await makeStore(fn).saveBooking(booking());

    const call = calls[0]!;
    expect(call.method).toBe('POST');
    expect(call.params.get('on_conflict')).toBe('profile_id,date,time');
    expect(call.headers['Prefer']).toContain('resolution=merge-duplicates');
    expect(call.headers['Prefer']).toContain('return=representation');
    expect(call.headers['Content-Type']).toBe('application/json');
  });

  it('тело — snake_case, без camelCase-ключей', async () => {
    const { fn, calls } = fetchStub(jsonRes([row()], 201));
    await makeStore(fn).saveBooking(booking());

    expect(calls[0]!.body).toEqual(row());
    expect(Object.keys(calls[0]!.body as object)).not.toContain('profileId');
    expect(Object.keys(calls[0]!.body as object)).not.toContain('bookingId');
  });

  it('2xx без строки в ответе — не считается успехом', async () => {
    const { fn } = fetchStub(jsonRes([], 201));
    await expect(makeStore(fn).saveBooking(booking())).rejects.toThrow(/не подтверждена/);
  });
});

describe('SupabaseStateStore.listBookings', () => {
  it('без фильтра: без profile_id, с сортировкой по дате и времени', async () => {
    const { fn, calls } = fetchStub(jsonRes([row(), row({ profile_id: 'nina', time: '21:00' })]));
    const all = await makeStore(fn).listBookings();

    expect(calls[0]!.params.has('profile_id')).toBe(false);
    expect(calls[0]!.params.get('order')).toBe('date.asc,time.asc');
    expect(all).toHaveLength(2);
    expect(all[1]!.profileId).toBe('nina');
  });

  it('с фильтром: profile_id=eq.<id>', async () => {
    const { fn, calls } = fetchStub(jsonRes([row()]));
    await makeStore(fn).listBookings('ilya');
    expect(calls[0]!.params.get('profile_id')).toBe('eq.ilya');
  });

  it('пустая таблица -> пустой массив', async () => {
    const { fn } = fetchStub(jsonRes([]));
    expect(await makeStore(fn).listBookings('someone-else')).toEqual([]);
  });
});

describe('SupabaseStateStore.markCanceled', () => {
  it('PATCH по booking_id со state=canceled (одна L)', async () => {
    const { fn, calls } = fetchStub(new Response(null, { status: 204 }));
    await makeStore(fn).markCanceled('booking-1');

    const call = calls[0]!;
    expect(call.method).toBe('PATCH');
    expect(call.params.get('booking_id')).toBe('eq.booking-1');
    expect(call.body).toEqual({ state: 'canceled' });
  });

  it('несуществующий bookingId ничего не ломает', async () => {
    const { fn } = fetchStub(jsonRes([]));
    await expect(makeStore(fn).markCanceled('nope')).resolves.toBeUndefined();
  });
});

describe('SupabaseStateStore: ошибки', () => {
  it('нет таблицы (PGRST205) -> ошибка со ссылкой на docs/supabase-schema.sql', async () => {
    const { fn } = fetchStub(
      jsonRes(
        {
          code: 'PGRST205',
          details: null,
          hint: null,
          message: "Could not find the table 'public.bookings' in the schema cache",
        },
        404,
      ),
    );
    await expect(makeStore(fn).getBooking('ilya', '2026-08-06', '20:00')).rejects.toThrow(
      /docs\/supabase-schema\.sql/,
    );
  });

  it('404 без кода, но с текстом про таблицу — тоже про schema.sql', async () => {
    const { fn } = fetchStub(jsonRes({ message: 'Could not find the table public.bookings' }, 404));
    await expect(makeStore(fn).saveBooking(booking())).rejects.toThrow(/docs\/supabase-schema\.sql/);
  });

  it('401 -> ошибка про SUPABASE_SERVICE_ROLE_KEY, без самого ключа в тексте', async () => {
    const { fn } = fetchStub(jsonRes({ message: 'Invalid API key' }, 401));
    const err = await rejection(makeStore(fn).getBooking('ilya', '2026-08-06', '20:00'));

    expect(err).toBeInstanceOf(SupabaseStateError);
    expect(err.message).toMatch(/SUPABASE_SERVICE_ROLE_KEY/);
    expect((err as SupabaseStateError).status).toBe(401);
    expect(err.message).not.toContain(KEY);
  });

  it('403 обрабатывается как проблема ключа', async () => {
    const { fn } = fetchStub(jsonRes({ message: 'permission denied for table bookings' }, 403));
    await expect(makeStore(fn).listBookings()).rejects.toThrow(/SUPABASE_SERVICE_ROLE_KEY/);
  });

  it('прочий HTTP-фейл: статус и текст PostgREST видны в сообщении', async () => {
    const { fn } = fetchStub(jsonRes({ code: '23505', message: 'duplicate key value' }, 409));
    await expect(makeStore(fn).saveBooking(booking())).rejects.toThrow(
      /HTTP 409 23505 — duplicate key value/,
    );
  });

  it('ключ вырезается, даже если сервер вернул его эхом', async () => {
    const { fn } = fetchStub(new Response(`boom ${KEY} boom`, { status: 500 }));
    const err = await rejection(makeStore(fn).listBookings());

    expect(err.message).not.toContain(KEY);
    expect(err.message).toContain('***');
  });

  it('ключ никогда не попадает в URL — только в заголовки', async () => {
    const { fn, calls } = fetchStub(jsonRes([row()], 201), jsonRes([row()]));
    const store = makeStore(fn);
    await store.saveBooking(booking());
    await store.getBooking('ilya', '2026-08-06', '20:00');

    expect(calls).toHaveLength(2);
    for (const call of calls) expect(call.url).not.toContain(KEY);
  });

  it('сетевая ошибка -> понятный throw без утечки ключа', async () => {
    const fn = vi.fn(async () => {
      throw new TypeError(`fetch failed for key ${KEY}`);
    }) as unknown as typeof fetch;

    const err = await rejection(makeStore(fn).listBookings());

    expect(err.message).toMatch(/не выполнен/);
    expect(err.message).not.toContain(KEY);
  });

  it('таймаут 5 с: запрос прерывается и падает понятной ошибкой', async () => {
    // fetch зависает и отвечает только на abort — так ведёт себя настоящий fetch.
    const fn = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted.', 'AbortError'));
          });
        }),
    ) as unknown as typeof fetch;

    vi.useFakeTimers();
    const store = makeStore(fn);
    const pending = store.getBooking('ilya', '2026-08-06', '20:00');
    const assertion = expect(pending).rejects.toThrow(/таймаут/);

    await vi.advanceTimersByTimeAsync(5_000);
    await assertion;
  });

  it('до истечения таймаута запрос не прерывается', async () => {
    let aborted = false;
    const fn = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((resolve) => {
          init?.signal?.addEventListener('abort', () => {
            aborted = true;
          });
          setTimeout(() => resolve(jsonRes([row()])), 4_000);
        }),
    ) as unknown as typeof fetch;

    vi.useFakeTimers();
    const pending = makeStore(fn).getBooking('ilya', '2026-08-06', '20:00');
    await vi.advanceTimersByTimeAsync(4_000);

    expect(await pending).toEqual(booking());
    expect(aborted).toBe(false);
  });
});
