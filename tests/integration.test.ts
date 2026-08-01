/**
 * Сквозной тест стыков между модулями.
 *
 * Все остальные наборы тестов проверяют модуль в изоляции: у booking-engine
 * фейковый клиент, у клиента фейковый fetch. Здесь наоборот — настоящие
 * profiles + scheduler + client + state + engine, а подменён ТОЛЬКО fetch.
 * Такой тест ловит расхождения контрактов, которые модульные тесты пропускают
 * по построению: например, если бы scheduler отдавал строку старта в формате,
 * отличном от того, что клиент вычитывает из ответа availability, engine
 * никогда бы не увидел слот — и все модульные тесты остались бы зелёными.
 */

import { describe, expect, it } from 'vitest';
import { bookSlotDrop } from '../src/core/booking-engine.js';
import { loadProfiles } from '../src/core/profiles.js';
import { MemoryStateStore } from '../src/core/state.js';
import { ReservioClient } from '../src/reservio/client.js';
import { slotEndISO, slotStartISO, tbilisiDateOf, targetDate } from '../src/core/scheduler.js';
import { courtByName, BUSINESS_ID } from '../src/reservio/types.js';

const C3 = courtByName('Padel Court 3');
const C2 = courtByName('Padel Court 2');

// День T = 30.07.2026, цель T+7 = 06.08.2026. Момент внутри окна дропа 20:00
// (20:58:30…21:03:30 дня T — дроп в том же часе, что и слот).
const IN_WINDOW_20 = '2026-07-30T20:58:40+04:00';
const DATE = '2026-08-06';

// Тестовые контакты — не реальные CLIENT_* (те живут только в env).
const ENV: Record<string, string | undefined> = {
  CLIENT_NAME: 'Test Player',
  CLIENT_EMAIL: 'player@example.test',
  CLIENT_PHONE: '+995555000000',
};

interface FetchCall {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => JSON.stringify(body),
    headers: { get: () => null },
  } as unknown as Response;
}

/** Ответ availability ровно в форме JSON:API из docs/PROTOCOL.md. */
function availabilityBody(slots: Array<{ start: string; end: string }>, resourceId: string) {
  return {
    meta: { total: slots.length },
    data: slots.map((s, i) => ({
      type: 'timeSlot',
      id: `slot-${i}`,
      attributes: { createdAt: '2026-07-30T16:58:50+00:00', start: s.start, end: s.end },
      relationships: { resource: { data: { type: 'resource', id: resourceId } } },
    })),
  };
}

function bookingBody(id: string, token: string, state = 'confirmed') {
  return {
    data: { type: 'booking', id, attributes: { token, state, via: 'application' } },
  };
}

/**
 * Фейковый fetch, маршрутизирующий по URL как настоящий API.
 * `openOn` — набор serviceId, у которых целевой слот уже дропнулся.
 */
function makeFetch(opts: {
  openOn: (serviceId: string, poll: number) => boolean;
  onBook?: (serviceId: string) => Response;
}) {
  const calls: FetchCall[] = [];
  const polls = new Map<string, number>();

  const fetchFn = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ method, url, headers: (init?.headers ?? {}) as Record<string, string>, body });

    if (url.includes('/availability/booking-slots')) {
      const serviceId = new URL(url).searchParams.get('filter[serviceId]') ?? '';
      const poll = (polls.get(serviceId) ?? 0) + 1;
      polls.set(serviceId, poll);
      const resourceId = serviceId === C3.serviceId ? C3.resourceId : C2.resourceId;
      // Слот 19:00 всегда занят посторонним — проверяем, что engine не хватает чужой слот.
      const slots = [{ start: `${DATE}T19:00:00+04:00`, end: `${DATE}T19:59:00+04:00` }];
      if (opts.openOn(serviceId, poll)) {
        slots.push({ start: slotStartISO(DATE, '20:00'), end: slotEndISO(DATE, '20:00') });
      }
      return jsonResponse(200, availabilityBody(slots, resourceId));
    }

    if (method === 'POST' && url.endsWith('/bookings')) {
      const serviceId = body?.data?.relationships?.event?.data?.relationships?.service?.data?.id ?? '';
      return opts.onBook ? opts.onBook(serviceId) : jsonResponse(201, bookingBody('bk-real-1', 'tok-real-1'));
    }

    if (method === 'PATCH' && url.includes('/bookings/')) {
      return jsonResponse(200, bookingBody('bk-real-1', 'tok-real-1', 'canceled'));
    }

    throw new Error(`неожиданный запрос в тесте: ${method} ${url}`);
  };

  return { fetchFn: fetchFn as unknown as typeof fetch, calls };
}

function makeClock(startISO: string) {
  let t = Date.parse(startISO);
  return {
    now: (): Date => new Date(t),
    sleep: async (ms: number): Promise<void> => {
      t += ms;
    },
  };
}

describe('сквозной стык profiles → scheduler → engine → client → state', () => {
  it('реальная сборка бронирует Court 3 и сохраняет token в state', async () => {
    const [profile] = loadProfiles(ENV);
    const clock = makeClock(IN_WINDOW_20);
    // Слот появляется на втором опросе Court 3 — как при настоящем дропе.
    const { fetchFn, calls } = makeFetch({ openOn: (sid, poll) => sid === C3.serviceId && poll >= 2 });
    const client = new ReservioClient({ fetchFn });
    const state = new MemoryStateStore();

    const report = await bookSlotDrop(
      profile!,
      { date: DATE, time: '20:00', courts: profile!.rule.courts },
      { client, state, now: clock.now, sleep: clock.sleep },
    );

    expect(report.ok).toBe(true);
    expect(report.court).toBe('Padel Court 3');
    expect(report.bookingId).toBe('bk-real-1');
    expect(report.token).toBe('tok-real-1');

    // Стык scheduler ↔ client: строка старта, которую построил scheduler,
    // должна дословно совпасть с тем, что клиент вычитал из ответа API.
    const post = calls.find((c) => c.method === 'POST')!;
    expect(post.body).toMatchObject({
      data: {
        type: 'booking',
        attributes: { bookedClientName: 'Test Player' },
        relationships: {
          event: {
            data: {
              attributes: {
                start: '2026-08-06T20:00:00+04:00',
                end: '2026-08-06T20:59:00+04:00',
                eventType: 'appointment',
              },
              relationships: { service: { data: { id: C3.serviceId } } },
            },
          },
          client: { data: { attributes: { email: 'player@example.test' } } },
        },
      },
    });

    // Стык client ↔ протокол: URL и заголовки JSON:API.
    const avail = calls.find((c) => c.url.includes('/availability/'))!;
    expect(avail.url).toContain(`/businesses/${BUSINESS_ID}/availability/booking-slots`);
    expect(avail.url).toContain(`filter%5Bfrom%5D=${DATE}`);
    expect(post.headers['Content-Type']).toBe('application/vnd.api+json');
    expect('Authorization' in post.headers).toBe(false);

    // Стык engine ↔ state: token обязан долететь до хранилища.
    const saved = await state.getBooking('ilya', DATE, '20:00', 'Padel Court 3');
    expect(saved).toMatchObject({
      profileId: 'ilya',
      court: 'Padel Court 3',
      bookingId: 'bk-real-1',
      token: 'tok-real-1',
      state: 'confirmed',
    });
  });

  it('повторный запуск на тот же слот не делает ни одного POST (идемпотентность)', async () => {
    const [profile] = loadProfiles(ENV);
    const state = new MemoryStateStore();

    const first = makeFetch({ openOn: (sid) => sid === C3.serviceId });
    const r1 = await bookSlotDrop(
      profile!,
      { date: DATE, time: '20:00', courts: profile!.rule.courts },
      { client: new ReservioClient({ fetchFn: first.fetchFn }), state, ...makeClock(IN_WINDOW_20) },
    );
    expect(r1.ok).toBe(true);

    // Второй прогон с тем же (уже наполненным) state — как повторный запуск джобы.
    const second = makeFetch({ openOn: () => true });
    const r2 = await bookSlotDrop(
      profile!,
      { date: DATE, time: '20:00', courts: profile!.rule.courts },
      { client: new ReservioClient({ fetchFn: second.fetchFn }), state, ...makeClock(IN_WINDOW_20) },
    );

    expect(r2.ok).toBe(false);
    expect(r2.error?.kind).toBe('AlreadyBooked');
    expect(second.calls).toHaveLength(0); // ни одного запроса вообще
  });

  it('режим all: два корта одного часа — две реальные брони и две строки в state', async () => {
    // Требование владельца: несколько броней на один (date, time) на РАЗНЫХ
    // кортах — легитимный вечерний пак, а не дубль. Проверяем весь стык:
    // движок → клиент → state с ключом (профиль, дата, время, корт).
    const [profile] = loadProfiles(ENV);
    const state = new MemoryStateStore();
    let seq = 0;
    const { fetchFn, calls } = makeFetch({
      openOn: () => true,
      onBook: () => {
        seq += 1;
        return jsonResponse(201, bookingBody(`bk-${seq}`, `tok-${seq}`));
      },
    });

    const report = await bookSlotDrop(
      profile!,
      { date: DATE, time: '20:00', courts: ['Padel Court 3', 'Padel Court 2'], mode: 'all' },
      { client: new ReservioClient({ fetchFn }), state, ...makeClock(IN_WINDOW_20) },
    );

    expect(report.ok).toBe(true);
    expect(report.results.map((r) => [r.court, r.ok])).toEqual([
      ['Padel Court 3', true],
      ['Padel Court 2', true],
    ]);
    const posts = calls.filter((c) => c.method === 'POST');
    expect(posts).toHaveLength(2);
    expect(
      posts.map((p) => (p.body as { data: { relationships: { event: { data: { relationships: { service: { data: { id: string } } } } } } } }).data.relationships.event.data.relationships.service.data.id),
    ).toEqual([C3.serviceId, C2.serviceId]);

    const stored = await state.listBookingsForSlot('ilya', DATE, '20:00');
    expect(stored.map((b) => b.court).sort()).toEqual(['Padel Court 2', 'Padel Court 3']);
    // У каждой брони свой token — без него её не отменить.
    expect(new Set(stored.map((b) => b.token)).size).toBe(2);

    // Повторный ран того же набора не делает ни одного POST: оба корта заняты нами.
    const again = makeFetch({ openOn: () => true });
    const r2 = await bookSlotDrop(
      profile!,
      { date: DATE, time: '20:00', courts: ['Padel Court 3', 'Padel Court 2'], mode: 'all' },
      { client: new ReservioClient({ fetchFn: again.fetchFn }), state, ...makeClock(IN_WINDOW_20) },
    );
    expect(r2.error?.kind).toBe('AlreadyBooked');
    expect(again.calls).toHaveLength(0);
  });

  it('Court 3 занят → падает на Court 2 по приоритету профиля', async () => {
    const [profile] = loadProfiles(ENV);
    const state = new MemoryStateStore();
    const { fetchFn, calls } = makeFetch({ openOn: (sid) => sid === C2.serviceId });

    const report = await bookSlotDrop(
      profile!,
      { date: DATE, time: '20:00', courts: profile!.rule.courts },
      { client: new ReservioClient({ fetchFn }), state, ...makeClock(IN_WINDOW_20) },
    );

    expect(report.ok).toBe(true);
    expect(report.court).toBe('Padel Court 2');
    const post = calls.find((c) => c.method === 'POST')!;
    expect(post.body).toMatchObject({
      data: { relationships: { event: { data: { relationships: { service: { data: { id: C2.serviceId } } } } } } },
    });
  });

  it('слот перехвачен между availability и POST → SlotTaken, в state пусто', async () => {
    const [profile] = loadProfiles(ENV);
    const state = new MemoryStateStore();
    // Слот виден на обоих кортах, но POST отвечает 409 — классическая гонка.
    const { fetchFn } = makeFetch({
      openOn: () => true,
      onBook: () => jsonResponse(409, { errors: [{ code: 'slotNotAvailable', title: 'Slot already booked' }] }),
    });

    const report = await bookSlotDrop(
      profile!,
      { date: DATE, time: '20:00', courts: profile!.rule.courts },
      { client: new ReservioClient({ fetchFn }), state, ...makeClock(IN_WINDOW_20) },
    );

    expect(report.ok).toBe(false);
    expect(report.error?.kind).toBe('SlotTaken');
    await expect(state.getBooking('ilya', DATE, '20:00', 'Padel Court 3')).resolves.toBeNull();
    await expect(state.listBookings()).resolves.toHaveLength(0);
  });

  it('пара 20:00 + 21:00 — два раздельных дропа и две брони', async () => {
    const [profile] = loadProfiles(ENV);
    const state = new MemoryStateStore();
    const clock = makeClock(IN_WINDOW_20);

    // Общий fetch: слот целевого часа открыт сразу на Court 3.
    let bookingSeq = 0;
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.includes('/availability/')) {
        const u = new URL(url);
        const sid = u.searchParams.get('filter[serviceId]');
        const slots =
          sid === C3.serviceId
            ? [
                { start: slotStartISO(DATE, '20:00'), end: slotEndISO(DATE, '20:00') },
                { start: slotStartISO(DATE, '21:00'), end: slotEndISO(DATE, '21:00') },
              ]
            : [];
        return jsonResponse(200, availabilityBody(slots, C3.resourceId));
      }
      if (method === 'POST') {
        bookingSeq += 1;
        return jsonResponse(201, bookingBody(`bk-${bookingSeq}`, `tok-${bookingSeq}`));
      }
      throw new Error(`неожиданный запрос: ${method} ${url}`);
    }) as unknown as typeof fetch;

    const client = new ReservioClient({ fetchFn });
    const deps = { client, state, now: clock.now, sleep: clock.sleep };

    const r20 = await bookSlotDrop(profile!, { date: DATE, time: '20:00', courts: profile!.rule.courts }, deps);
    // Второй дроп на час позже — engine сам доспит до своего окна 21:58:30.
    const r21 = await bookSlotDrop(profile!, { date: DATE, time: '21:00', courts: profile!.rule.courts }, deps);

    expect([r20.ok, r21.ok]).toEqual([true, true]);
    expect(r20.bookingId).not.toBe(r21.bookingId);
    const stored = await state.listBookings('ilya');
    expect(stored).toHaveLength(2);
    expect(stored.map((b) => b.time)).toEqual(['20:00', '21:00']);
    // Каждая бронь со своим token — без него её не отменить.
    expect(new Set(stored.map((b) => b.token)).size).toBe(2);
  });

  it('отмена: клиент требует state="canceled", state помечает бронь', async () => {
    const state = new MemoryStateStore();
    await state.saveBooking({
      profileId: 'ilya',
      date: DATE,
      time: '20:00',
      court: 'Padel Court 3',
      bookingId: 'bk-real-1',
      token: 'tok-real-1',
      state: 'confirmed',
      createdAt: '2026-07-30T20:00:00+04:00',
    });
    const { fetchFn, calls } = makeFetch({ openOn: () => false });
    const client = new ReservioClient({ fetchFn });

    await client.cancelBooking('bk-real-1', 'tok-real-1');
    await state.markCanceled('bk-real-1');

    const patch = calls.find((c) => c.method === 'PATCH')!;
    expect(patch.url).toContain('token=tok-real-1');
    expect(patch.body).toMatchObject({ data: { attributes: { state: 'canceled' } } });
    expect((await state.getBooking('ilya', DATE, '20:00', 'Padel Court 3'))?.state).toBe('canceled');

    // Отменённая бронь больше не блокирует новую попытку на тот же слот.
    const [profile] = loadProfiles(ENV);
    const retry = makeFetch({ openOn: (sid) => sid === C3.serviceId });
    const report = await bookSlotDrop(
      profile!,
      { date: DATE, time: '20:00', courts: profile!.rule.courts },
      { client: new ReservioClient({ fetchFn: retry.fetchFn }), state, ...makeClock(IN_WINDOW_20) },
    );
    expect(report.ok).toBe(true);
  });

  it('смена формата availability у НАСТОЯЩЕГО клиента → ApiChanged, а не Timeout', async () => {
    // Клиент сам валидирует форму ответа и кидает ReservioApiError
    // (code=unexpectedResponse). Движок обязан распознать это как смену API:
    // иначе оператор получит «слот не появился» и будет ждать следующий вечер,
    // хотя бот сломан навсегда. Проверки Array.isArray внутри движка с этим
    // клиентом недостижимы — классификация идёт по коду ошибки.
    const [profile] = loadProfiles(ENV);
    const fetchFn = (async (): Promise<Response> =>
      jsonResponse(200, { data: { startsAt: '2026-08-06T20:00:00+04:00' } })) as unknown as typeof fetch;

    const report = await bookSlotDrop(
      profile!,
      { date: DATE, time: '20:00', courts: profile!.rule.courts },
      { client: new ReservioClient({ fetchFn }), state: new MemoryStateStore(), ...makeClock(IN_WINDOW_20) },
    );

    expect(report.ok).toBe(false);
    expect(report.error?.kind).toBe('ApiChanged');
  });

  it('POST 201 без data.id у настоящего клиента → ApiChanged и РОВНО один POST', async () => {
    // Ответ пришёл, значит бронь могла быть создана: второй POST (другой корт
    // или следующий круг polling) означал бы вторую реальную бронь.
    const [profile] = loadProfiles(ENV);
    const { fetchFn, calls } = makeFetch({
      openOn: () => true,
      onBook: () => jsonResponse(201, { data: { type: 'booking', attributes: { state: 'confirmed' } } }),
    });
    const state = new MemoryStateStore();

    const report = await bookSlotDrop(
      profile!,
      { date: DATE, time: '20:00', courts: profile!.rule.courts },
      { client: new ReservioClient({ fetchFn }), state, ...makeClock(IN_WINDOW_20) },
    );

    expect(report.ok).toBe(false);
    expect(report.error?.kind).toBe('ApiChanged');
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
    await expect(state.listBookings()).resolves.toHaveLength(0);
  });

  it('слот виден до дедлайна, но POST отклонён → не больше одного POST на корт', async () => {
    // Регрессия на «цикл polling переотправляет POST»: за 5-минутное окно
    // уходили сотни реальных POST /bookings.
    const [profile] = loadProfiles(ENV);
    const { fetchFn, calls } = makeFetch({
      openOn: () => true,
      onBook: () => jsonResponse(409, { errors: [{ code: 'slotNotAvailable', title: 'Slot already booked' }] }),
    });

    const report = await bookSlotDrop(
      profile!,
      { date: DATE, time: '20:00', courts: profile!.rule.courts },
      { client: new ReservioClient({ fetchFn }), state: new MemoryStateStore(), ...makeClock(IN_WINDOW_20) },
    );

    expect(report.error?.kind).toBe('SlotTaken');
    const posts = calls.filter((c) => c.method === 'POST');
    expect(posts).toHaveLength(2); // Court 3 и Court 2 — по одной попытке
  });

  it('таймаут POST у настоящего клиента → второй корт не бронируется', async () => {
    // AbortController рвёт запрос на 5 секунде: бронь могла уже создаться.
    const [profile] = loadProfiles(ENV);
    const calls: string[] = [];
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      calls.push(`${method} ${url.split('?')[0]}`);
      if (url.includes('/availability/')) {
        return jsonResponse(
          200,
          availabilityBody([{ start: slotStartISO(DATE, '20:00'), end: slotEndISO(DATE, '20:00') }], C3.resourceId),
        );
      }
      throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    }) as unknown as typeof fetch;

    const report = await bookSlotDrop(
      profile!,
      { date: DATE, time: '20:00', courts: profile!.rule.courts },
      { client: new ReservioClient({ fetchFn }), state: new MemoryStateStore(), ...makeClock(IN_WINDOW_20) },
    );

    expect(report.ok).toBe(false);
    expect(report.error?.kind).toBe('Timeout');
    expect(report.error?.detail).toContain('могла быть создана');
    expect(calls.filter((c) => c.startsWith('POST'))).toHaveLength(1);
  });

  it('scheduler и engine согласованы: целевая дата = T+7 от дня наблюдения', () => {
    const now = new Date(Date.parse(IN_WINDOW_20));
    expect(tbilisiDateOf(now)).toBe('2026-07-30');
    expect(targetDate(now)).toBe(DATE);
  });
});
