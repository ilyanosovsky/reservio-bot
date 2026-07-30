import { describe, expect, it, vi } from 'vitest';
import { bookSlotDrop } from '../src/core/booking-engine.js';
import type { EngineDeps } from '../src/core/booking-engine.js';
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

// Виртуальные задержки сети — чтобы msFromSeenToBooked был отличим от нуля.
const LATENCY_GET = 120;
const LATENCY_POST = 400;

const profile: Profile = {
  id: 'ilya',
  label: 'Тест',
  contact: { name: 'Test Player', email: 'player@example.test', phone: '+995555000000' },
  rule: { times: ['20:00', '21:00'], courts: ['Padel Court 3', 'Padel Court 2'] },
};

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

function makeState(initial: StoredBooking[] = []) {
  const rows = [...initial];
  const getBooking = vi.fn(
    (profileId: string, date: string, time: string): StoredBooking | null =>
      rows.find((b) => b.profileId === profileId && b.date === date && b.time === time) ?? null,
  );
  const saveBooking = vi.fn((b: StoredBooking): void => {
    rows.push(b);
  });
  const listBookings = vi.fn((): StoredBooking[] => [...rows]);
  const markCanceled = vi.fn((): void => {});
  const state = { getBooking, saveBooking, listBookings, markCanceled };
  return { state: state as unknown as StateStore, getBooking, saveBooking, rows };
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

    const report = await bookSlotDrop(profile, { date: DATE, time: TIME }, deps(clock, client, state, (m) => logs.push(m)));

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

    const report = await bookSlotDrop(profile, { date: DATE, time: TIME }, deps(clock, client, state));

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

    const report = await bookSlotDrop(profile, { date: DATE, time: TIME }, deps(clock, client, state));

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

    const report = await bookSlotDrop(profile, { date: DATE, time: TIME }, deps(clock, client, state));

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

    const report = await bookSlotDrop(profile, { date: DATE, time: TIME }, deps(clock, client, state));

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

    const report = await bookSlotDrop(profile, { date: DATE, time: TIME }, deps(clock, client, state));

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

    const report = await bookSlotDrop(profile, { date: DATE, time: TIME }, deps(clock, client, state));

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

    const report = await bookSlotDrop(profile, { date: DATE, time: TIME }, deps(clock, client, state));

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

    const report = await bookSlotDrop(profile, { date: DATE, time: TIME }, deps(clock, client, state));

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

    const report = await bookSlotDrop(profile, { date: DATE, time: TIME }, deps(clock, client, state));

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
    const { state, getBooking } = makeState();
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
    getBooking.mockImplementation(() => (clock.ms() >= WINDOW_START_MS ? rival : null));

    const report = await bookSlotDrop(profile, { date: DATE, time: TIME }, deps(clock, client, state));

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
    const { state, getBooking } = makeState();
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
    getBooking.mockImplementation(() => (++calls === 1 ? null : rival));

    const report = await bookSlotDrop(profile, { date: DATE, time: TIME }, deps(clock, client, state));

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
      { date: '2026-8-6', time: '20:00' },
      { date: DATE, time: '8:00' },
      { date: '2026-02-30', time: '20:00' },
    ]) {
      const report = await bookSlotDrop(profile, bad, deps(clock, client, state));
      expect(report.ok).toBe(false);
      expect(report.error?.kind).toBe('ApiChanged');
      expect(report.timeline.length).toBeGreaterThan(0);
    }
    expect(createBooking).not.toHaveBeenCalled();
  });

  it('падение state.getBooking → DropReport без POST (дубль хуже пропуска)', async () => {
    const clock = makeClock(IN_WINDOW);
    const { client, createBooking } = makeClient(clock, {
      availability: () => [slot(WANT_START, WANT_END)],
    });
    const { state, getBooking } = makeState();
    getBooking.mockImplementation(() => {
      throw new Error('SQLITE_BUSY: database is locked');
    });

    const report = await bookSlotDrop(profile, { date: DATE, time: TIME }, deps(clock, client, state));

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

    const report = await bookSlotDrop(profile, { date: DATE, time: TIME }, deps(clock, client, state));

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

    const report = await bookSlotDrop(profile, { date: DATE, time: '00:00' }, deps(clock, client, state));

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

    const report = await bookSlotDrop(profile, { date: DATE, time: TIME }, deps(clock, client, state));

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

    const report = await bookSlotDrop(profile, { date: '2026-08-09', time: TIME }, deps(clock, client, state));

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

    const report = await bookSlotDrop(profile, { date: DATE, time: TIME }, deps(clock, client, state));

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

    const report = await bookSlotDrop(profile, { date: DATE, time: TIME }, deps(clock, client, state));

    expect(report.ok).toBe(false);
    expect(report.error?.kind).toBe('ApiChanged');
    expect(saveBooking).not.toHaveBeenCalled();
  });

  it('падение state.saveBooking не отменяет успех: token остаётся в отчёте', async () => {
    const clock = makeClock(IN_WINDOW);
    const { client } = makeClient(clock, { availability: () => [slot(WANT_START, WANT_END)] });
    const { state, saveBooking } = makeState();
    saveBooking.mockImplementation(() => {
      throw new Error('disk full');
    });

    const report = await bookSlotDrop(profile, { date: DATE, time: TIME }, deps(clock, client, state));

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

    await bookSlotDrop(profile, { date: DATE, time: TIME }, deps(clock, client, state));

    expect(createBooking.mock.calls[0]![0]).toMatchObject({ start: WANT_START, end: apiEnd });
  });

  it('неизвестный корт в профиле → отчёт, а не исключение', async () => {
    const clock = makeClock(IN_WINDOW);
    const { client, getAvailability } = makeClient(clock, { availability: () => [] });
    const { state } = makeState();
    const broken: Profile = { ...profile, rule: { ...profile.rule, courts: ['Padel Court 42'] } };

    const report = await bookSlotDrop(broken, { date: DATE, time: TIME }, deps(clock, client, state));

    expect(report.ok).toBe(false);
    expect(report.error?.kind).toBe('ApiChanged');
    expect(getAvailability).not.toHaveBeenCalled();
  });

  it('слот не появился до дедлайна → Timeout', async () => {
    const clock = makeClock(IN_WINDOW);
    const { client, createBooking } = makeClient(clock, { availability: () => [] });
    const { state } = makeState();

    const report = await bookSlotDrop(profile, { date: DATE, time: TIME }, deps(clock, client, state));

    expect(report.ok).toBe(false);
    expect(report.error?.kind).toBe('Timeout');
    expect(createBooking).not.toHaveBeenCalled();
    expect(clock.ms()).toBeGreaterThanOrEqual(DEADLINE_MS);
    expect(new Set(clock.sleeps)).toEqual(new Set([2000]));
  });
});
