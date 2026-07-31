// Тесты брони по запросу (src/core/book-now.ts).
//
// Здесь проверяются РЕШЕНИЯ функции, а не сеть: клиент Reservio — заглушка,
// state настоящий (MemoryStateStore). Главные инварианты: ровно один POST,
// никакого POST при непроверенном/занятом слоте и при уже существующей брони,
// напоминание не может стоить нам брони.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { bookNow, type BookNowDeps } from '../src/core/book-now.js';
import { ReservioApiError, type ReservioClient } from '../src/reservio/client.js';
import type { BookingCreated, Slot } from '../src/reservio/types.js';
import { courtByName } from '../src/reservio/types.js';
import { MemoryStateStore, type StoredBooking } from '../src/core/state.js';

const DATE = '2026-08-06';
const TIME = '20:00';
const COURT = 'Padel Court 3';
const START = '2026-08-06T20:00:00+04:00';
const END = '2026-08-06T20:59:00+04:00';
const EMAIL = 'player.test@example.com';

const PROFILE = {
  id: 'ilya',
  contact: { name: 'Test Player', email: EMAIL, phone: '+995555000111' },
};

const TARGET = { date: DATE, time: TIME, court: COURT };

const FREE_SLOT: Slot = { start: START, end: END };

interface ClientStub {
  slots?: Slot[];
  availabilityError?: unknown;
  createError?: unknown;
  created?: BookingCreated;
}

interface Harness {
  state: MemoryStateStore;
  deps: BookNowDeps;
  createCalls: Array<{ serviceId: string; start: string; end: string }>;
  /** Счётчик обращений к availability; читать как `counters.availability`. */
  counters: { availability: number };
  reminders: StoredBooking[];
}

function harness(stub: ClientStub = {}, extra: Partial<BookNowDeps> = {}): Harness {
  const createCalls: Harness['createCalls'] = [];
  const reminders: StoredBooking[] = [];
  const counters = { availability: 0 };

  const client = {
    getAvailability: async (): Promise<Slot[]> => {
      counters.availability += 1;
      if (stub.availabilityError) throw stub.availabilityError;
      return stub.slots ?? [FREE_SLOT];
    },
    createBooking: async (args: { serviceId: string; start: string; end: string }): Promise<BookingCreated> => {
      createCalls.push({ serviceId: args.serviceId, start: args.start, end: args.end });
      if (stub.createError) throw stub.createError;
      return stub.created ?? { bookingId: 'bk-1', token: 'guest-token-1', state: 'confirmed' };
    },
  } as unknown as ReservioClient;

  const state = new MemoryStateStore();
  const deps: BookNowDeps = {
    client,
    state,
    scheduleReminder: async (b) => {
      reminders.push(b);
    },
    now: () => new Date('2026-08-01T12:00:00+04:00'),
    ...extra,
  };

  return { state, deps, createCalls, counters, reminders };
}

// vi.spyOn на state в отдельных тестах не должен протекать в соседние.
beforeEach(() => {
  vi.restoreAllMocks();
});

const stored = (patch: Partial<StoredBooking> = {}): StoredBooking => ({
  profileId: PROFILE.id,
  date: DATE,
  time: TIME,
  court: COURT,
  bookingId: 'old-1',
  token: 'old-token',
  state: 'confirmed',
  createdAt: '2026-08-01T10:00:00.000+04:00',
  ...patch,
});

describe('bookNow: успешная бронь', () => {
  it('слот свободен — один POST, бронь в state вместе с token', async () => {
    const h = harness();

    const res = await bookNow(PROFILE, TARGET, h.deps);

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.booking.bookingId).toBe('bk-1');
    expect(res.booking.token).toBe('guest-token-1');
    expect(res.booking.court).toBe(COURT);

    expect(h.createCalls).toHaveLength(1);
    expect(h.createCalls[0]).toEqual({ serviceId: courtByName(COURT).serviceId, start: START, end: END });

    // token обязан доехать до state: без него бронь не отменить (PROTOCOL.md)
    await expect(h.state.getBooking(PROFILE.id, DATE, TIME)).resolves.toMatchObject({
      bookingId: 'bk-1',
      token: 'guest-token-1',
      state: 'confirmed',
    });
  });

  it('end берётся из ответа availability, а не из нашей арифметики', async () => {
    const h = harness({ slots: [{ start: START, end: '2026-08-06T21:00:00+04:00' }] });

    await bookNow(PROFILE, TARGET, h.deps);

    expect(h.createCalls[0]?.end).toBe('2026-08-06T21:00:00+04:00');
  });

  it('после брони планируется напоминание', async () => {
    const h = harness();

    await bookNow(PROFILE, TARGET, h.deps);

    expect(h.reminders).toHaveLength(1);
    expect(h.reminders[0]).toMatchObject({ bookingId: 'bk-1', date: DATE, time: TIME, court: COURT });
  });

  it('отменённая бронь на этот слот не мешает забронировать заново', async () => {
    const h = harness();
    await h.state.saveBooking(stored({ state: 'canceled' }));

    const res = await bookNow(PROFILE, TARGET, h.deps);

    expect(res.ok).toBe(true);
    expect(h.createCalls).toHaveLength(1);
  });
});

describe('bookNow: POST не делается', () => {
  it('слота нет в availability — занято', async () => {
    const h = harness({ slots: [{ start: '2026-08-06T21:00:00+04:00', end: '2026-08-06T21:59:00+04:00' }] });

    const res = await bookNow(PROFILE, TARGET, h.deps);

    expect(res).toMatchObject({ ok: false });
    if (res.ok) return;
    expect(res.reason).toContain('занято');
    expect(h.createCalls).toHaveLength(0);
  });

  it('на слот уже есть активная бронь — дубль не создаём', async () => {
    const h = harness();
    await h.state.saveBooking(stored());

    const res = await bookNow(PROFILE, TARGET, h.deps);

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toContain('уже есть бронь');
    expect(res.reason).toContain('old-1');
    expect(h.createCalls).toHaveLength(0);
    // до availability дело тоже не доходит: проверка состояния идёт первой
    expect(h.counters.availability).toBe(0);
  });

  it('state недоступен — бронируем вслепую? нет', async () => {
    // Иначе дубль: чем отменять лишнюю бронь руками, лучше честно отказать.
    const h = harness();
    vi.spyOn(h.state, 'getBooking').mockRejectedValue(new Error('PostgREST 500'));

    const res = await bookNow(PROFILE, TARGET, h.deps);

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toContain('вслепую');
    expect(h.createCalls).toHaveLength(0);
  });

  it('availability упал — отказ, а не попытка «наудачу»', async () => {
    const h = harness({ availabilityError: new ReservioApiError('availability: HTTP 503', { status: 503 }) });

    const res = await bookNow(PROFILE, TARGET, h.deps);

    expect(res.ok).toBe(false);
    expect(h.createCalls).toHaveLength(0);
  });

  it('неизвестный корт — ошибка конфига, сеть не трогаем', async () => {
    const h = harness();

    const res = await bookNow(PROFILE, { ...TARGET, court: 'Padel Court 42' }, h.deps);

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toContain('Неизвестный корт');
    expect(h.counters.availability).toBe(0);
  });

  it('кривая дата — отказ до сети', async () => {
    const h = harness();

    const res = await bookNow(PROFILE, { ...TARGET, date: '06.08.2026' }, h.deps);

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toContain('Неверные дата/время');
    expect(h.counters.availability).toBe(0);
  });
});

describe('bookNow: отказы POST', () => {
  it('детерминированный отказ (4xx) — честное «нет», без ретрая', async () => {
    const h = harness({
      createError: new ReservioApiError('createBooking: HTTP 409 conflict — slot taken', {
        status: 409,
        code: 'conflict',
      }),
    });

    const res = await bookNow(PROFILE, TARGET, h.deps);

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toContain('Reservio отклонил бронь');
    expect(h.createCalls).toHaveLength(1); // ровно одна попытка
    await expect(h.state.getBooking(PROFILE.id, DATE, TIME)).resolves.toBeNull();
  });

  it('неоднозначный отказ (5xx) — предупреждаем, что бронь могла создаться', async () => {
    const h = harness({ createError: new ReservioApiError('createBooking: HTTP 502', { status: 502 }) });

    const res = await bookNow(PROFILE, TARGET, h.deps);

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toContain('МОГЛА быть создана');
    expect(h.reminders).toHaveLength(0);
  });

  it('ответ без bookingId успехом не считается', async () => {
    const h = harness({ created: { bookingId: '', token: 'tok', state: 'confirmed' } as BookingCreated });

    const res = await bookNow(PROFILE, TARGET, h.deps);

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toContain('без id брони');
  });

  it('email из чужого текста ошибки не утекает в reason', async () => {
    // reason уходит человеку в чат с parse_mode=HTML — ни персональных данных,
    // ни угловых скобок в заглушке быть не должно.
    const h = harness({
      createError: new ReservioApiError(`createBooking: HTTP 422 — invalid client ${EMAIL}`, { status: 422 }),
    });

    const res = await bookNow(PROFILE, TARGET, h.deps);

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).not.toContain(EMAIL);
    expect(res.reason).toContain('[email]');
    expect(res.reason).not.toContain('<');
  });
});

describe('bookNow: бронь важнее обвязки', () => {
  it('saveBooking упал — бронь всё равно успех, token возвращён вызывающему', async () => {
    const logs: string[] = [];
    const h = harness({}, { log: (m) => logs.push(m) });
    vi.spyOn(h.state, 'saveBooking').mockRejectedValue(new Error('PostgREST 500'));

    const res = await bookNow(PROFILE, TARGET, h.deps);

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.booking.token).toBe('guest-token-1');
    expect(logs.join('\n')).toContain('не сохранена в state');
  });

  it('scheduleReminder упал — бронь остаётся успешной', async () => {
    const logs: string[] = [];
    const h = harness(
      {},
      {
        log: (m) => logs.push(m),
        scheduleReminder: async () => {
          throw new Error('trigger.dev недоступен');
        },
      },
    );

    const res = await bookNow(PROFILE, TARGET, h.deps);

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.booking.bookingId).toBe('bk-1');
    expect(logs.join('\n')).toContain('напоминание');
    // бронь при этом сохранена
    await expect(h.state.getBooking(PROFILE.id, DATE, TIME)).resolves.toMatchObject({ bookingId: 'bk-1' });
  });

  it('scheduleReminder не задан — просто не зовём', async () => {
    const h = harness({}, { scheduleReminder: undefined });

    await expect(bookNow(PROFILE, TARGET, h.deps)).resolves.toMatchObject({ ok: true });
  });
});
