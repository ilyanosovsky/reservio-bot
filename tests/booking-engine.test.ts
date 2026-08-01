import { describe, expect, it, vi } from 'vitest';
import { bookSlotDrop } from '../src/core/booking-engine.js';
import type { DropTarget, EngineDeps } from '../src/core/booking-engine.js';
import type { Profile } from '../src/core/profiles.js';
import type { StateStore, StoredBooking } from '../src/core/state.js';
import type { ReservioClient } from '../src/reservio/client.js';
import type { BookingCreated, Slot } from '../src/reservio/types.js';
import { courtByName } from '../src/reservio/types.js';

const DATE = '2026-08-06';
const TIME = '20:00';
const WANT_START = '2026-08-06T20:00:00+04:00';
const WANT_END = '2026-08-06T20:59:00+04:00';
// Окно дропа слота 20:00 дня T+7: 30.07 20:58:30 … 21:03:30 (+04:00).
// Час тот же, что у слота — см. комментарий в scheduler.ts (модель дропа).
const IN_WINDOW = '2026-07-30T20:58:40+04:00';
const WINDOW_START_MS = Date.parse('2026-07-30T20:58:30+04:00');
const DEADLINE_MS = Date.parse('2026-07-30T21:03:30+04:00');

const C3 = courtByName('Padel Court 3');
const C2 = courtByName('Padel Court 2');
const C4 = courtByName('Padel Court 4');

// Виртуальные задержки сети — чтобы msFromSeenToBooked был отличим от нуля.
const LATENCY_GET = 120;
const LATENCY_POST = 400;

const profile: Profile = {
  id: 'ilya',
  label: 'Тест',
  contact: { name: 'Test Player', email: 'player@example.test', phone: '+995555000000' },
  rule: { times: ['20:00', '21:00'], courts: ['Padel Court 3', 'Padel Court 2'] },
};

/**
 * Цель дропа. Набор кортов приходит от вызывающего (правило профиля, payload
 * таска, --courts у CLI), движок сам в профиль за ним не лезет.
 * По умолчанию — режим 'priority' (поведение фазы 2).
 */
function target(patch: Partial<DropTarget> = {}): DropTarget {
  return { date: DATE, time: TIME, courts: [...profile.rule.courts], ...patch };
}

function makeClock(startISO: string) {
  let t = Date.parse(startISO);
  const sleeps: number[] = [];
  return {
    sleeps,
    ms: (): number => t,
    now: (): Date => new Date(t),
    sleep: async (ms: number): Promise<void> => {
      sleeps.push(ms);
      t += ms;
    },
    tick: (ms: number): void => {
      t += ms;
    },
  };
}
type Clock = ReturnType<typeof makeClock>;

function slot(start: string, end: string): Slot {
  return { start, end };
}

function apiError(status: number, message = 'reservio error'): Error {
  return Object.assign(new Error(message), { status });
}

type AvailResult = Slot[] | { error: Error } | unknown;
type BookResult = BookingCreated | { error: Error };

function makeClient(
  clock: Clock,
  handlers: {
    availability: (serviceId: string, poll: number) => AvailResult;
    booking?: (serviceId: string) => BookResult;
  },
) {
  const polls = new Map<string, number>();
  const getAvailability = vi.fn(async (serviceId: string, _date: string) => {
    clock.tick(LATENCY_GET);
    const poll = (polls.get(serviceId) ?? 0) + 1;
    polls.set(serviceId, poll);
    const res = handlers.availability(serviceId, poll);
    if (res && typeof res === 'object' && 'error' in res) throw (res as { error: Error }).error;
    return res as Slot[];
  });
  const createBooking = vi.fn(async (args: { serviceId: string }) => {
    clock.tick(LATENCY_POST);
    const res: BookResult = handlers.booking
      ? handlers.booking(args.serviceId)
      : { bookingId: `bk-${args.serviceId.slice(0, 4)}`, token: `tok-${args.serviceId.slice(0, 4)}`, state: 'confirmed' };
    if ('error' in res) throw res.error;
    return res;
  });
  const client = { getAvailability, createBooking, cancelBooking: vi.fn(), getBooking: vi.fn() };
  return { client: client as unknown as ReservioClient, getAvailability, createBooking };
}

// StateStore асинхронен: моки возвращают Promise, движок обязан их awaitить.
// Ключ брони — (профиль, дата, время, КОРТ): на один час бывает несколько
// броней на разных кортах, поэтому точечное чтение и чтение всего часа разведены.
function makeState(initial: StoredBooking[] = []) {
  const rows = [...initial];
  const ofSlot = (profileId: string, date: string, time: string): StoredBooking[] =>
    rows.filter((b) => b.profileId === profileId && b.date === date && b.time === time);
  const getBooking = vi.fn(
    async (profileId: string, date: string, time: string, court: string): Promise<StoredBooking | null> =>
      ofSlot(profileId, date, time).find((b) => b.court === court) ?? null,
  );
  const listBookingsForSlot = vi.fn(
    async (profileId: string, date: string, time: string): Promise<StoredBooking[]> => ofSlot(profileId, date, time),
  );
  const saveBooking = vi.fn(async (b: StoredBooking): Promise<void> => {
    rows.push(b);
  });
  const listBookings = vi.fn(async (): Promise<StoredBooking[]> => [...rows]);
  const markCanceled = vi.fn(async (): Promise<void> => {});
  const state = { getBooking, listBookingsForSlot, saveBooking, listBookings, markCanceled };
  return { state: state as unknown as StateStore, getBooking, listBookingsForSlot, saveBooking, rows };
}

function deps(clock: Clock, client: ReservioClient, state: StateStore, log?: (m: string) => void): EngineDeps {
  return { client, state, now: clock.now, sleep: clock.sleep, log };
}

describe('bookSlotDrop', () => {
  it('бронирует Court 3, когда слот появился на втором опросе', async () => {
    const clock = makeClock(IN_WINDOW);
    const { client, getAvailability, createBooking } = makeClient(clock, {
      availability: (serviceId, poll) =>
        serviceId === C3.serviceId && poll >= 2 ? [slot(WANT_START, WANT_END)] : [],
    });
    const { state, saveBooking } = makeState();
    const logs: string[] = [];

    const report = await bookSlotDrop(profile, target(), deps(clock, client, state, (m) => logs.push(m)));

    expect(report.ok).toBe(true);
    expect(report.court).toBe('Padel Court 3');
    expect(report.bookingId).toBe(`bk-${C3.serviceId.slice(0, 4)}`);
    expect(report.token).toBe(`tok-${C3.serviceId.slice(0, 4)}`);
    expect(report.error).toBeUndefined();
    expect(report.msFromSeenToBooked).toBe(LATENCY_POST);

    // 1-й цикл: C3 пусто → C2 пусто; пауза 2000; 2-й цикл: C3 нашёл.
    expect(getAvailability).toHaveBeenCalledTimes(3);
    expect(clock.sleeps).toEqual([2000]);
    expect(createBooking).toHaveBeenCalledTimes(1);
    expect(createBooking).toHaveBeenCalledWith({
      serviceId: C3.serviceId,
      start: WANT_START,
      end: WANT_END,
      contact: profile.contact,
    });

    expect(saveBooking).toHaveBeenCalledTimes(1);
    const saved = saveBooking.mock.calls[0]![0];
    expect(saved).toMatchObject({
      profileId: 'ilya',
      date: DATE,
      time: TIME,
      court: 'Padel Court 3',
      bookingId: report.bookingId,
      token: report.token,
      state: 'confirmed',
    });
    expect(saved.token).not.toBe('');
    expect(saved.createdAt.endsWith('+04:00')).toBe(true);

    expect(report.timeline.length).toBeGreaterThan(0);
    expect(report.timeline.every((e) => e.at.endsWith('+04:00'))).toBe(true);
    expect(logs.length).toBeGreaterThan(0);
  });

  it('падение POST на Court 3 уводит на Court 2 в том же цикле', async () => {
    const clock = makeClock(IN_WINDOW);
    const { client, createBooking } = makeClient(clock, {
      availability: () => [slot(WANT_START, WANT_END)],
      booking: (serviceId) =>
        serviceId === C3.serviceId
          ? { error: apiError(409, 'slot already booked') }
          : { bookingId: 'bk-c2', token: 'tok-c2', state: 'confirmed' },
    });
    const { state, saveBooking } = makeState();

    const report = await bookSlotDrop(profile, target(), deps(clock, client, state));

    expect(report.ok).toBe(true);
    expect(report.court).toBe('Padel Court 2');
    expect(report.bookingId).toBe('bk-c2');
    expect(createBooking).toHaveBeenCalledTimes(2);
    expect(createBooking.mock.calls[0]![0].serviceId).toBe(C3.serviceId);
    expect(createBooking.mock.calls[1]![0].serviceId).toBe(C2.serviceId);
    // Между кортами паузы нет — оба POST в одном цикле.
    expect(clock.sleeps).toEqual([]);
    expect(saveBooking.mock.calls[0]![0].court).toBe('Padel Court 2');
  });

  it('бронирует Court 2, если на Court 3 слот так и не появился', async () => {
    const clock = makeClock(IN_WINDOW);
    const { client, createBooking } = makeClient(clock, {
      availability: (serviceId, poll) =>
        serviceId === C2.serviceId && poll >= 2 ? [slot(WANT_START, WANT_END)] : [],
    });
    const { state } = makeState();

    const report = await bookSlotDrop(profile, target(), deps(clock, client, state));

    expect(report.ok).toBe(true);
    expect(report.court).toBe('Padel Court 2');
    expect(createBooking).toHaveBeenCalledTimes(1);
    expect(createBooking.mock.calls[0]![0].serviceId).toBe(C2.serviceId);
    expect(report.msFromSeenToBooked).toBe(LATENCY_POST);
  });

  it('слот виден, но все POST падают → SlotTaken, РОВНО по одному POST на корт', async () => {
    const clock = makeClock(IN_WINDOW);
    const { client, createBooking, getAvailability } = makeClient(clock, {
      availability: () => [slot(WANT_START, WANT_END)],
      booking: () => ({ error: apiError(409, 'slot already booked') }),
    });
    const { state, saveBooking } = makeState();

    const report = await bookSlotDrop(profile, target(), deps(clock, client, state));

    expect(report.ok).toBe(false);
    expect(report.error?.kind).toBe('SlotTaken');
    expect(report.bookingId).toBeUndefined();
    expect(saveBooking).not.toHaveBeenCalled();
    // Регрессия: раньше цикл polling'а перепосылал POST каждые 2 с до дедлайна
    // (сотни реальных броней за окно). POST не ретраится — одна попытка на корт.
    expect(createBooking).toHaveBeenCalledTimes(2);
    expect(createBooking.mock.calls.map((c) => c[0].serviceId)).toEqual([C3.serviceId, C2.serviceId]);
    // И дальше не поллим: попыток больше нет, ждать бессмысленно.
    expect(getAvailability).toHaveBeenCalledTimes(2);
    expect(clock.ms()).toBeLessThan(DEADLINE_MS);
  });

  it('неоднозначный отказ POST (таймаут без статуса) НЕ уводит на второй корт', async () => {
    const clock = makeClock(IN_WINDOW);
    // Клиент кидает ReservioApiError code=networkError без status — бронь могла
    // быть создана на сервере, второй POST дал бы две реальные брони.
    const timeoutErr = Object.assign(new Error('createBooking: запрос не выполнен — таймаут'), {
      code: 'networkError',
    });
    const { client, createBooking } = makeClient(clock, {
      availability: () => [slot(WANT_START, WANT_END)],
      booking: (serviceId) =>
        serviceId === C3.serviceId
          ? { error: timeoutErr }
          : { bookingId: 'bk-c2', token: 'tok-c2', state: 'confirmed' },
    });
    const { state, saveBooking } = makeState();

    const report = await bookSlotDrop(profile, target(), deps(clock, client, state));

    expect(report.ok).toBe(false);
    expect(report.error?.kind).toBe('Timeout');
    expect(report.error?.detail).toContain('могла быть создана');
    expect(report.court).toBe('Padel Court 3');
    expect(createBooking).toHaveBeenCalledTimes(1);
    expect(saveBooking).not.toHaveBeenCalled();
  });

  it('5xx на POST тоже считается неоднозначным отказом', async () => {
    const clock = makeClock(IN_WINDOW);
    const { client, createBooking } = makeClient(clock, {
      availability: () => [slot(WANT_START, WANT_END)],
      booking: () => ({ error: apiError(502, 'bad gateway') }),
    });
    const { state } = makeState();

    const report = await bookSlotDrop(profile, target(), deps(clock, client, state));

    expect(report.ok).toBe(false);
    expect(report.error?.kind).toBe('Timeout');
    expect(createBooking).toHaveBeenCalledTimes(1);
  });

  it('стабильные 5xx → backoff 2s→4s→8s→16s→30s и Timeout к дедлайну', async () => {
    const clock = makeClock(IN_WINDOW);
    const { client, createBooking } = makeClient(clock, {
      availability: () => ({ error: apiError(503, 'service unavailable') }),
    });
    const { state } = makeState();

    const report = await bookSlotDrop(profile, target(), deps(clock, client, state));

    expect(report.ok).toBe(false);
    expect(report.error?.kind).toBe('Timeout');
    expect(report.error?.detail).toContain('503');
    expect(createBooking).not.toHaveBeenCalled();
    expect(clock.sleeps.slice(0, 5)).toEqual([2000, 4000, 8000, 16000, 30000]);
    expect(Math.max(...clock.sleeps)).toBe(30000);
    // Интервал опроса никогда не опускается ниже 2 секунд.
    expect(Math.min(...clock.sleeps)).toBeGreaterThanOrEqual(2000);
  });

  it('успешный ответ сбрасывает backoff обратно на 2 секунды', async () => {
    const clock = makeClock(IN_WINDOW);
    let round = 0;
    const { client } = makeClient(clock, {
      availability: (serviceId) => {
        if (serviceId === C3.serviceId) round += 1;
        // Первые два цикла — 500, третий отвечает нормально, четвёртый находит слот.
        if (round <= 2) return { error: apiError(500, 'boom') };
        return round >= 4 && serviceId === C3.serviceId ? [slot(WANT_START, WANT_END)] : [];
      },
    });
    const { state } = makeState();

    const report = await bookSlotDrop(profile, target(), deps(clock, client, state));

    expect(report.ok).toBe(true);
    expect(clock.sleeps).toEqual([2000, 4000, 2000]);
  });

  it('уже есть бронь в state → AlreadyBooked без единого запроса', async () => {
    const clock = makeClock(IN_WINDOW);
    const { client, getAvailability, createBooking } = makeClient(clock, {
      availability: () => [slot(WANT_START, WANT_END)],
    });
    const { state, saveBooking } = makeState([
      {
        profileId: 'ilya',
        date: DATE,
        time: TIME,
        court: 'Padel Court 3',
        bookingId: 'bk-existing',
        token: 'tok-existing',
        state: 'confirmed',
        createdAt: '2026-07-30T19:59:00.000+04:00',
      },
    ]);

    const report = await bookSlotDrop(profile, target(), deps(clock, client, state));

    expect(report.ok).toBe(false);
    expect(report.error?.kind).toBe('AlreadyBooked');
    expect(report.bookingId).toBe('bk-existing');
    expect(report.token).toBe('tok-existing');
    expect(createBooking).not.toHaveBeenCalled();
    expect(getAvailability).not.toHaveBeenCalled();
    expect(saveBooking).not.toHaveBeenCalled();
    expect(clock.sleeps).toEqual([]);
  });

  it('отменённая бронь в state не блокирует новую', async () => {
    const clock = makeClock(IN_WINDOW);
    const { client, createBooking } = makeClient(clock, {
      availability: () => [slot(WANT_START, WANT_END)],
    });
    const { state } = makeState([
      {
        profileId: 'ilya',
        date: DATE,
        time: TIME,
        court: 'Padel Court 3',
        bookingId: 'bk-old',
        token: 'tok-old',
        state: 'canceled',
        createdAt: '2026-07-30T19:59:00.000+04:00',
      },
    ]);

    const report = await bookSlotDrop(profile, target(), deps(clock, client, state));

    expect(report.ok).toBe(true);
    expect(createBooking).toHaveBeenCalledTimes(1);
  });

  it('бронь, появившаяся в state пока движок ждал окна → AlreadyBooked без POST', async () => {
    // Второй прогон, стартовавший до окна (два терминала / двойной trigger):
    // проверки на старте не хватает — она была ДО многоминутного сна.
    const clock = makeClock('2026-07-30T20:50:00+04:00');
    const { client, createBooking } = makeClient(clock, {
      availability: () => [slot(WANT_START, WANT_END)],
    });
    const { state, listBookingsForSlot } = makeState();
    const rival: StoredBooking = {
      profileId: 'ilya',
      date: DATE,
      time: TIME,
      court: 'Padel Court 3',
      bookingId: 'bk-rival',
      token: 'tok-rival',
      state: 'confirmed',
      createdAt: '2026-07-30T20:58:51.000+04:00',
    };
    // На старте брони нет, к моменту пробуждения — уже есть.
    listBookingsForSlot.mockImplementation(async () => (clock.ms() >= WINDOW_START_MS ? [rival] : []));

    const report = await bookSlotDrop(profile, target(), deps(clock, client, state));

    expect(report.ok).toBe(false);
    expect(report.error?.kind).toBe('AlreadyBooked');
    expect(report.bookingId).toBe('bk-rival');
    expect(createBooking).not.toHaveBeenCalled();
  });

  it('бронь, появившаяся в state между availability и POST → AlreadyBooked без POST', async () => {
    const clock = makeClock(IN_WINDOW);
    const { client, createBooking, getAvailability } = makeClient(clock, {
      availability: () => [slot(WANT_START, WANT_END)],
    });
    const { state, listBookingsForSlot } = makeState();
    const rival: StoredBooking = {
      profileId: 'ilya',
      date: DATE,
      time: TIME,
      court: 'Padel Court 3',
      bookingId: 'bk-rival',
      token: 'tok-rival',
      state: 'confirmed',
      createdAt: '2026-07-30T20:58:51.000+04:00',
    };
    // Первый вызов (старт) — пусто; следующий (перед POST) — уже занято.
    let calls = 0;
    listBookingsForSlot.mockImplementation(async () => (++calls === 1 ? [] : [rival]));

    const report = await bookSlotDrop(profile, target(), deps(clock, client, state));

    expect(report.ok).toBe(false);
    expect(report.error?.kind).toBe('AlreadyBooked');
    expect(getAvailability).toHaveBeenCalled();
    expect(createBooking).not.toHaveBeenCalled();
  });

  it('кривые date/time → DropReport, а не исключение', async () => {
    const clock = makeClock(IN_WINDOW);
    const { client, createBooking } = makeClient(clock, { availability: () => [] });
    const { state } = makeState();

    for (const bad of [
      target({ date: '2026-8-6' }),
      target({ time: '8:00' }),
      target({ date: '2026-02-30' }),
    ]) {
      const report = await bookSlotDrop(profile, bad, deps(clock, client, state));
      expect(report.ok).toBe(false);
      expect(report.error?.kind).toBe('ApiChanged');
      expect(report.timeline.length).toBeGreaterThan(0);
    }
    expect(createBooking).not.toHaveBeenCalled();
  });

  it('отказ чтения state (rejected promise) → DropReport без POST (дубль хуже пропуска)', async () => {
    // Сетевой store (Supabase) падает именно так — reject, а не throw.
    const clock = makeClock(IN_WINDOW);
    const { client, createBooking } = makeClient(clock, {
      availability: () => [slot(WANT_START, WANT_END)],
    });
    const { state, listBookingsForSlot } = makeState();
    listBookingsForSlot.mockRejectedValue(new Error('PGRST301: JWT expired'));

    const report = await bookSlotDrop(profile, target(), deps(clock, client, state));

    expect(report.ok).toBe(false);
    expect(report.error?.detail).toContain('PGRST301');
    expect(createBooking).not.toHaveBeenCalled();
  });

  it('синхронный throw из чтения state тоже не доводит до POST', async () => {
    const clock = makeClock(IN_WINDOW);
    const { client, createBooking } = makeClient(clock, {
      availability: () => [slot(WANT_START, WANT_END)],
    });
    const { state, listBookingsForSlot } = makeState();
    listBookingsForSlot.mockImplementation(() => {
      throw new Error('SQLITE_BUSY: database is locked');
    });

    const report = await bookSlotDrop(profile, target(), deps(clock, client, state));

    expect(report.ok).toBe(false);
    expect(report.error?.detail).toContain('SQLITE_BUSY');
    expect(createBooking).not.toHaveBeenCalled();
  });

  it('ждёт начала окна и не стучит в API раньше времени', async () => {
    const clock = makeClock('2026-07-30T20:50:00+04:00');
    let firstCallMs = 0;
    const { client } = makeClient(clock, {
      availability: () => {
        if (firstCallMs === 0) firstCallMs = clock.ms();
        return [slot(WANT_START, WANT_END)];
      },
    });
    const { state } = makeState();

    const report = await bookSlotDrop(profile, target(), deps(clock, client, state));

    expect(report.ok).toBe(true);
    // 20:50:00 → 20:58:30 = 510 секунд ожидания одним сном.
    expect(clock.sleeps[0]).toBe(510_000);
    expect(firstCallMs).toBeGreaterThanOrEqual(WINDOW_START_MS);
  });

  it('день наблюдения T считается от целевой даты, а не от «сегодня»', async () => {
    // Запуск 29.07 23:50 на цель 06.08 00:00: дроп ночного слота — 30.07 00:58:50.
    // Регрессия: при dayT = tbilisiDateOf(now) окно уезжало на сутки назад
    // и движок мгновенно отдавал Timeout, ни разу не дождавшись дропа.
    const clock = makeClock('2026-07-29T23:50:00+04:00');
    const midnightStart = '2026-08-06T00:00:00+04:00';
    const { client, createBooking } = makeClient(clock, {
      availability: () => [slot(midnightStart, '2026-08-06T00:59:00+04:00')],
    });
    const { state } = makeState();

    const report = await bookSlotDrop(profile, target({ time: '00:00' }), deps(clock, client, state));

    expect(report.ok).toBe(true);
    // 29.07 23:50 → 30.07 00:58:30 = 68.5 минут ожидания.
    expect(clock.sleeps[0]).toBe(68.5 * 60_000);
    expect(createBooking.mock.calls[0]![0]).toMatchObject({ start: midnightStart });
  });

  it('окно дропа уже закрыто → Timeout без единого запроса', async () => {
    const clock = makeClock('2026-07-30T22:00:00+04:00'); // окно 20:58:30…21:03:30 позади
    const { client, getAvailability, createBooking } = makeClient(clock, {
      availability: () => [slot(WANT_START, WANT_END)],
    });
    const { state } = makeState();

    const report = await bookSlotDrop(profile, target(), deps(clock, client, state));

    expect(report.ok).toBe(false);
    expect(report.error?.kind).toBe('Timeout');
    expect(report.error?.detail).toContain('уже закрыто');
    expect(getAvailability).not.toHaveBeenCalled();
    expect(createBooking).not.toHaveBeenCalled();
  });

  it('окно дропа дальше суток → отказ, а не бесконечный сон', async () => {
    // --date промахнулся на несколько дней: молча спать сутками нельзя.
    const clock = makeClock(IN_WINDOW);
    const { client, getAvailability } = makeClient(clock, { availability: () => [] });
    const { state } = makeState();

    const report = await bookSlotDrop(profile, target({ date: '2026-08-09' }), deps(clock, client, state));

    expect(report.ok).toBe(false);
    expect(report.error?.kind).toBe('Timeout');
    expect(report.error?.detail).toContain('не ближайший дроп');
    expect(getAvailability).not.toHaveBeenCalled();
    expect(clock.sleeps).toEqual([]);
  });

  it('нераспознаваемый ответ availability → ApiChanged', async () => {
    const clock = makeClock(IN_WINDOW);
    const { client, createBooking } = makeClient(clock, {
      availability: () => ({ data: 'что-то новое' }),
    });
    const { state } = makeState();

    const report = await bookSlotDrop(profile, target(), deps(clock, client, state));

    expect(report.ok).toBe(false);
    expect(report.error?.kind).toBe('ApiChanged');
    expect(createBooking).not.toHaveBeenCalled();
  });

  it('ответ POST без bookingId → ApiChanged, бронь не считается успешной', async () => {
    const clock = makeClock(IN_WINDOW);
    const { client } = makeClient(clock, {
      availability: () => [slot(WANT_START, WANT_END)],
      booking: () => ({ state: 'confirmed' } as unknown as BookingCreated),
    });
    const { state, saveBooking } = makeState();

    const report = await bookSlotDrop(profile, target(), deps(clock, client, state));

    expect(report.ok).toBe(false);
    expect(report.error?.kind).toBe('ApiChanged');
    expect(saveBooking).not.toHaveBeenCalled();
    // 2xx без id — тоже неоднозначный исход: бронь на сервере могла остаться.
    expect(report.results[0]).toMatchObject({ court: 'Padel Court 3', ok: false, ambiguous: true });
  });

  it('падение state.saveBooking не отменяет успех: token остаётся в отчёте', async () => {
    const clock = makeClock(IN_WINDOW);
    const { client } = makeClient(clock, { availability: () => [slot(WANT_START, WANT_END)] });
    const { state, saveBooking } = makeState();
    // Именно reject: у сетевого store отказ приходит асинхронно, после POST.
    saveBooking.mockRejectedValue(new Error('disk full'));

    const report = await bookSlotDrop(profile, target(), deps(clock, client, state));

    expect(report.ok).toBe(true);
    expect(report.token).toBe(`tok-${C3.serviceId.slice(0, 4)}`);
    expect(report.timeline.some((e) => e.event.includes('saveBooking'))).toBe(true);
  });

  it('end берётся из ответа availability, если он отличается от расчётного', async () => {
    const clock = makeClock(IN_WINDOW);
    const apiEnd = '2026-08-06T20:58:00+04:00';
    const { client, createBooking } = makeClient(clock, {
      availability: () => [slot(WANT_START, apiEnd)],
    });
    const { state } = makeState();

    await bookSlotDrop(profile, target(), deps(clock, client, state));

    expect(createBooking.mock.calls[0]![0]).toMatchObject({ start: WANT_START, end: apiEnd });
  });

  it('неизвестный корт в наборе → отчёт, а не исключение', async () => {
    const clock = makeClock(IN_WINDOW);
    const { client, getAvailability } = makeClient(clock, { availability: () => [] });
    const { state } = makeState();

    const report = await bookSlotDrop(profile, target({ courts: ['Padel Court 42'] }), deps(clock, client, state));

    expect(report.ok).toBe(false);
    expect(report.error?.kind).toBe('ApiChanged');
    expect(getAvailability).not.toHaveBeenCalled();
  });

  it('слот не появился до дедлайна → Timeout', async () => {
    const clock = makeClock(IN_WINDOW);
    const { client, createBooking } = makeClient(clock, { availability: () => [] });
    const { state } = makeState();

    const report = await bookSlotDrop(profile, target(), deps(clock, client, state));

    expect(report.ok).toBe(false);
    expect(report.error?.kind).toBe('Timeout');
    expect(createBooking).not.toHaveBeenCalled();
    expect(clock.ms()).toBeGreaterThanOrEqual(DEADLINE_MS);
    expect(new Set(clock.sleeps)).toEqual(new Set([2000]));
  });

  it('results заполняется и в режиме priority: по строке на каждый корт набора', async () => {
    // Сводка по кортам — единственный способ увидеть, что происходило с
    // остальным набором: корневые поля отчёта знают только про победителя.
    const clock = makeClock(IN_WINDOW);
    const { client } = makeClient(clock, {
      availability: (serviceId) => (serviceId === C2.serviceId ? [slot(WANT_START, WANT_END)] : []),
    });
    const { state } = makeState();

    const report = await bookSlotDrop(profile, target(), deps(clock, client, state));

    expect(report.ok).toBe(true);
    expect(report.results.map((r) => [r.court, r.ok])).toEqual([
      ['Padel Court 3', false],
      ['Padel Court 2', true],
    ]);
    expect(report.results[0]!.error).toContain('не появился');
    expect(report.results[1]!.bookingId).toBe(report.bookingId);
  });
});

// Вечерняя вахта: клуб держит C2/C3 на 20:00–22:00 и в дроп выпускает то один
// корт, то другой, поэтому вечером бронируется КАЖДЫЙ появившийся корт набора.
// Лишнюю бронь владелец отменяет руками; упущенный корт вернуть нельзя.
describe('bookSlotDrop: режим all', () => {
  const ALL = { courts: ['Padel Court 3', 'Padel Court 4'], mode: 'all' as const };
  const allTarget = (patch: Partial<DropTarget> = {}): DropTarget => target({ ...ALL, ...patch });

  const existingOn = (court: string, bookingId: string): StoredBooking => ({
    profileId: 'ilya',
    date: DATE,
    time: TIME,
    court,
    bookingId,
    token: `tok-${bookingId}`,
    state: 'confirmed',
    createdAt: '2026-07-30T20:58:51.000+04:00',
  });

  it('оба корта появились → две брони, оба results ok', async () => {
    const clock = makeClock(IN_WINDOW);
    const { client, createBooking } = makeClient(clock, { availability: () => [slot(WANT_START, WANT_END)] });
    const { state, saveBooking } = makeState();

    const report = await bookSlotDrop(profile, allTarget(), deps(clock, client, state));

    expect(report.ok).toBe(true);
    expect(createBooking).toHaveBeenCalledTimes(2);
    expect(createBooking.mock.calls.map((c) => c[0].serviceId)).toEqual([C3.serviceId, C4.serviceId]);
    expect(report.results.map((r) => [r.court, r.ok])).toEqual([
      ['Padel Court 3', true],
      ['Padel Court 4', true],
    ]);
    expect(new Set(report.results.map((r) => r.bookingId)).size).toBe(2);
    expect(report.results.every((r) => r.msFromSeenToBooked === LATENCY_POST)).toBe(true);
    // Корневые поля — первая бронь (совместимость с фазой 2).
    expect(report.court).toBe('Padel Court 3');
    expect(report.bookingId).toBe(`bk-${C3.serviceId.slice(0, 4)}`);
    expect(report.token).toBe(`tok-${C3.serviceId.slice(0, 4)}`);
    // Обе брони с token: без него бронь не отменить.
    expect(saveBooking).toHaveBeenCalledTimes(2);
    expect(saveBooking.mock.calls.map((c) => c[0].court)).toEqual(['Padel Court 3', 'Padel Court 4']);
    expect(saveBooking.mock.calls.every((c) => c[0].token !== '')).toBe(true);
  });

  it('появился только один корт → одна бронь, второй помечен в results', async () => {
    const clock = makeClock(IN_WINDOW);
    const { client, createBooking } = makeClient(clock, {
      availability: (serviceId) => (serviceId === C4.serviceId ? [slot(WANT_START, WANT_END)] : []),
    });
    const { state } = makeState();

    const report = await bookSlotDrop(profile, allTarget(), deps(clock, client, state));

    // Успех рана = хотя бы одна бронь.
    expect(report.ok).toBe(true);
    expect(report.court).toBe('Padel Court 4');
    expect(createBooking).toHaveBeenCalledTimes(1);
    expect(createBooking.mock.calls[0]![0].serviceId).toBe(C4.serviceId);
    const [c3, c4] = report.results;
    expect(c3).toMatchObject({ court: 'Padel Court 3', ok: false });
    expect(c3!.error).toContain('не появился');
    expect(c4).toMatchObject({ court: 'Padel Court 4', ok: true });
    // Вахта по незабронированному корту идёт до самого дедлайна.
    expect(clock.ms()).toBeGreaterThanOrEqual(DEADLINE_MS);
  });

  it('старая бронь не задваивается в отчёте, если state читался и до, и после ожидания окна', async () => {
    // Ран, поставленный до открытия окна, проверяет state дважды (старт и после
    // сна) и оба раза видит ту же бронь на C3. В отчёт владельцу корт обязан
    // попасть ОДИН раз, иначе сообщение выглядит как две разные брони.
    const clock = makeClock('2026-07-30T20:57:00+04:00'); // до окна: движок уснёт
    const { client, createBooking } = makeClient(clock, { availability: () => [] }); // C4 так и не вышел
    const { state } = makeState([existingOn('Padel Court 3', 'bk-existing')]);

    const report = await bookSlotDrop(profile, allTarget(), deps(clock, client, state));

    expect(clock.sleeps.length).toBeGreaterThan(0); // окно действительно ждали
    expect(createBooking).not.toHaveBeenCalled();
    expect(report.error?.kind).toBe('AlreadyBooked');
    const detail = report.error?.detail ?? '';
    expect(detail.match(/bk-existing/g)).toHaveLength(1);
    // В results тоже ровно одна строка на корт.
    expect(report.results.map((r) => r.court)).toEqual(['Padel Court 3', 'Padel Court 4']);
  });

  it('по-кортовая идемпотентность: C3 уже в state → POST только на C4', async () => {
    const clock = makeClock(IN_WINDOW);
    const { client, createBooking } = makeClient(clock, { availability: () => [slot(WANT_START, WANT_END)] });
    const { state } = makeState([existingOn('Padel Court 3', 'bk-existing')]);

    const report = await bookSlotDrop(profile, allTarget(), deps(clock, client, state));

    expect(report.ok).toBe(true);
    expect(createBooking).toHaveBeenCalledTimes(1);
    expect(createBooking.mock.calls[0]![0].serviceId).toBe(C4.serviceId);
    expect(report.results[0]).toMatchObject({ court: 'Padel Court 3', ok: false, bookingId: 'bk-existing' });
    expect(report.results[0]!.error).toContain('уже была в state');
    expect(report.results[1]).toMatchObject({ court: 'Padel Court 4', ok: true });
  });

  it('отменённая бронь корта не блокирует его повторную бронь', async () => {
    const clock = makeClock(IN_WINDOW);
    const { client, createBooking } = makeClient(clock, { availability: () => [slot(WANT_START, WANT_END)] });
    const { state } = makeState([{ ...existingOn('Padel Court 3', 'bk-old'), state: 'canceled' }]);

    const report = await bookSlotDrop(profile, allTarget(), deps(clock, client, state));

    expect(report.ok).toBe(true);
    expect(createBooking).toHaveBeenCalledTimes(2);
  });

  it('все корты набора уже забронированы → AlreadyBooked без единого запроса', async () => {
    const clock = makeClock(IN_WINDOW);
    const { client, getAvailability, createBooking } = makeClient(clock, {
      availability: () => [slot(WANT_START, WANT_END)],
    });
    const { state } = makeState([
      existingOn('Padel Court 3', 'bk-c3'),
      existingOn('Padel Court 4', 'bk-c4'),
    ]);

    const report = await bookSlotDrop(profile, allTarget(), deps(clock, client, state));

    expect(report.ok).toBe(false);
    expect(report.error?.kind).toBe('AlreadyBooked');
    expect(report.bookingId).toBe('bk-c3');
    expect(getAvailability).not.toHaveBeenCalled();
    expect(createBooking).not.toHaveBeenCalled();
    expect(report.results.every((r) => !r.ok && r.bookingId !== undefined)).toBe(true);
  });

  it('неоднозначный отказ POST на C3 НЕ блокирует C4', async () => {
    // Корты набора — разные service и разные ресурсы: потерянный ответ по
    // одному не может превратить бронь на другом в дубль. Упустить из-за этого
    // второй корт — прямой убыток, поэтому вахта продолжается.
    const clock = makeClock(IN_WINDOW);
    const timeoutErr = Object.assign(new Error('createBooking: запрос не выполнен — таймаут'), {
      code: 'networkError',
    });
    const { client, createBooking } = makeClient(clock, {
      availability: () => [slot(WANT_START, WANT_END)],
      booking: (serviceId) =>
        serviceId === C3.serviceId ? { error: timeoutErr } : { bookingId: 'bk-c4', token: 'tok-c4', state: 'confirmed' },
    });
    const { state, saveBooking } = makeState();

    const report = await bookSlotDrop(profile, allTarget(), deps(clock, client, state));

    expect(report.ok).toBe(true);
    expect(report.court).toBe('Padel Court 4');
    expect(createBooking).toHaveBeenCalledTimes(2);
    expect(report.results[0]!.error).toContain('неоднозначно');
    expect(report.results[0]!.error).toContain('могла быть создана');
    // Ран зелёный (бронь на C4 есть), корневой error занят быть не может —
    // поэтому фантомная бронь помечается флагом, по которому таск собирает ⚠️.
    expect(report.results[0]!.ambiguous).toBe(true);
    expect(report.error).toBeUndefined();
    expect(report.results[1]).toMatchObject({ court: 'Padel Court 4', ok: true, bookingId: 'bk-c4' });
    expect(report.results[1]!.ambiguous).toBeUndefined();
    // В state попадает только подтверждённая бронь.
    expect(saveBooking).toHaveBeenCalledTimes(1);
  });

  it('неоднозначный отказ единственного появившегося корта → Timeout с предупреждением', async () => {
    const clock = makeClock(IN_WINDOW);
    const timeoutErr = Object.assign(new Error('createBooking: запрос не выполнен — таймаут'), {
      code: 'networkError',
    });
    const { client } = makeClient(clock, {
      availability: (serviceId) => (serviceId === C3.serviceId ? [slot(WANT_START, WANT_END)] : []),
      booking: () => ({ error: timeoutErr }),
    });
    const { state } = makeState();

    const report = await bookSlotDrop(profile, allTarget(), deps(clock, client, state));

    expect(report.ok).toBe(false);
    expect(report.error?.kind).toBe('Timeout');
    expect(report.error?.detail).toContain('могла быть создана');
    expect(report.court).toBe('Padel Court 3');
  });

  it('POST отклонён на обоих кортах → SlotTaken и РОВНО по одному POST на корт', async () => {
    const clock = makeClock(IN_WINDOW);
    const { client, createBooking, getAvailability } = makeClient(clock, {
      availability: () => [slot(WANT_START, WANT_END)],
      booking: () => ({ error: apiError(409, 'slot already booked') }),
    });
    const { state, saveBooking } = makeState();

    const report = await bookSlotDrop(profile, allTarget(), deps(clock, client, state));

    expect(report.ok).toBe(false);
    expect(report.error?.kind).toBe('SlotTaken');
    expect(createBooking).toHaveBeenCalledTimes(2);
    expect(createBooking.mock.calls.map((c) => c[0].serviceId)).toEqual([C3.serviceId, C4.serviceId]);
    // Попыток больше нет — дальше не поллим.
    expect(getAvailability).toHaveBeenCalledTimes(2);
    expect(clock.ms()).toBeLessThan(DEADLINE_MS);
    expect(saveBooking).not.toHaveBeenCalled();
    expect(report.results.every((r) => (r.error ?? '').includes('POST отклонён'))).toBe(true);
  });

  it('отказ POST на C3 не мешает забронировать C4 в том же цикле', async () => {
    const clock = makeClock(IN_WINDOW);
    const { client, createBooking } = makeClient(clock, {
      availability: () => [slot(WANT_START, WANT_END)],
      booking: (serviceId) =>
        serviceId === C3.serviceId
          ? { error: apiError(409, 'slot already booked') }
          : { bookingId: 'bk-c4', token: 'tok-c4', state: 'confirmed' },
    });
    const { state } = makeState();

    const report = await bookSlotDrop(profile, allTarget(), deps(clock, client, state));

    expect(report.ok).toBe(true);
    expect(report.bookingId).toBe('bk-c4');
    expect(clock.sleeps).toEqual([]); // оба корта в одном цикле, без пауз
  });

  it('бронь корта, появившаяся между availability и POST, закрывает только свой корт', async () => {
    const clock = makeClock(IN_WINDOW);
    const { client, createBooking } = makeClient(clock, { availability: () => [slot(WANT_START, WANT_END)] });
    const { state, getBooking } = makeState();
    const rival = existingOn('Padel Court 3', 'bk-rival');
    // Точечная проверка перед POST: на C3 бронь уже есть, на C4 — нет.
    getBooking.mockImplementation(async (_p: string, _d: string, _t: string, court: string) =>
      court === 'Padel Court 3' ? rival : null,
    );

    const report = await bookSlotDrop(profile, allTarget(), deps(clock, client, state));

    expect(report.ok).toBe(true);
    expect(createBooking).toHaveBeenCalledTimes(1);
    expect(createBooking.mock.calls[0]![0].serviceId).toBe(C4.serviceId);
    expect(report.results[0]).toMatchObject({ court: 'Padel Court 3', bookingId: 'bk-rival', ok: false });
  });

  it('дубль корта в наборе не превращается во второй POST', async () => {
    const clock = makeClock(IN_WINDOW);
    const { client, createBooking } = makeClient(clock, { availability: () => [slot(WANT_START, WANT_END)] });
    const { state } = makeState();

    const report = await bookSlotDrop(
      profile,
      allTarget({ courts: ['Padel Court 3', 'Padel Court 3'] }),
      deps(clock, client, state),
    );

    expect(createBooking).toHaveBeenCalledTimes(1);
    expect(report.results).toHaveLength(1);
  });

  it('ни один корт не появился → Timeout и оба корта помечены', async () => {
    const clock = makeClock(IN_WINDOW);
    const { client, createBooking } = makeClient(clock, { availability: () => [] });
    const { state } = makeState();

    const report = await bookSlotDrop(profile, allTarget(), deps(clock, client, state));

    expect(report.ok).toBe(false);
    expect(report.error?.kind).toBe('Timeout');
    expect(createBooking).not.toHaveBeenCalled();
    expect(report.results.map((r) => r.court)).toEqual(['Padel Court 3', 'Padel Court 4']);
    expect(report.results.every((r) => !r.ok && (r.error ?? '').includes('не появился'))).toBe(true);
  });
});
