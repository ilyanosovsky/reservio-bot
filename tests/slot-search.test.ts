import { describe, expect, it } from 'vitest';
import { MAX_SLOT_OPTIONS, countSlotOptions, searchSlots, slotKey } from '../src/core/slot-search.js';
import type { BookingIntent } from '../src/core/intent.js';
import type { Slot } from '../src/reservio/types.js';

const HORIZON = { from: '2026-08-04', to: '2026-08-11' };

const C1 = 'Padel Court 1';
const C3 = 'Padel Court 3';
const C4 = 'Padel Court 4';

function slots(date: string, times: string[]): Slot[] {
  return times.map((t) => ({ start: `${date}T${t}:00+04:00`, end: `${date}T${t.slice(0, 2)}:59:00+04:00` }));
}

/** Карта availability: [корт, дата, свободные часы]. */
function mapOf(...entries: Array<[string, string, string[]]>): Map<string, Slot[]> {
  const map = new Map<string, Slot[]>();
  for (const [court, date, times] of entries) map.set(slotKey(court, date), slots(date, times));
  return map;
}

function find(patch: Partial<BookingIntent> = {}): BookingIntent {
  return { kind: 'find', ...patch };
}

/** Компактный вид варианта для сравнений: 'Padel Court 3 06.08 20:00+21:00'. */
function brief(o: { court: string; date: string; times: string[] }): string {
  return `${o.court} ${o.date} ${o.times.join('+')}`;
}

describe('searchSlots: длительность и связки', () => {
  it('без durationHours каждый свободный час — отдельный вариант', () => {
    const av = mapOf([C3, '2026-08-06', ['19:00', '20:00']]);
    expect(searchSlots(av, find(), HORIZON).map(brief)).toEqual([
      'Padel Court 3 2026-08-06 19:00',
      'Padel Court 3 2026-08-06 20:00',
    ]);
  });

  it('связка — только часы ПОДРЯД и только на одном корте', () => {
    const av = mapOf(
      [C3, '2026-08-06', ['20:00', '21:00', '23:00']], // 20+21 подряд, 23 в отрыве
      [C4, '2026-08-06', ['21:00']], // с 20:00 корта 3 в связку не склеится
    );
    const options = searchSlots(av, find({ durationHours: 2, consecutive: true }), HORIZON);
    expect(options.map(brief)).toEqual(['Padel Court 3 2026-08-06 20:00+21:00']);
  });

  it('через полночь связки не бывает: ни 23:00+00:00 внутри дня, ни через сутки', () => {
    const sameDay = mapOf([C3, '2026-08-06', ['00:00', '23:00']]);
    expect(searchSlots(sameDay, find({ durationHours: 2, consecutive: true }), HORIZON)).toEqual([]);

    const acrossDays = mapOf([C3, '2026-08-06', ['23:00']], [C3, '2026-08-07', ['00:00']]);
    expect(searchSlots(acrossDays, find({ durationHours: 2, consecutive: true }), HORIZON)).toEqual([]);

    // А внутри ночи подряд — нормальная связка.
    const night = mapOf([C3, '2026-08-06', ['00:00', '01:00']]);
    expect(searchSlots(night, find({ durationHours: 2, consecutive: true }), HORIZON).map(brief)).toEqual([
      'Padel Court 3 2026-08-06 00:00+01:00',
    ]);
  });

  it('три часа подряд собираются как одна связка со скользящим окном', () => {
    const av = mapOf([C3, '2026-08-06', ['18:00', '19:00', '20:00', '21:00']]);
    expect(searchSlots(av, find({ durationHours: 3, consecutive: true }), HORIZON).map(brief)).toEqual([
      'Padel Court 3 2026-08-06 18:00+19:00+20:00',
      'Padel Court 3 2026-08-06 19:00+20:00+21:00',
    ]);
  });

  it('длительность подрезается к 1..3 (мусор и перебор не ломают подбор)', () => {
    const av = mapOf([C3, '2026-08-06', ['18:00', '19:00', '20:00', '21:00']]);
    const long = searchSlots(av, find({ durationHours: 9, consecutive: true }), HORIZON);
    expect(long.every((o) => o.times.length === 3)).toBe(true);

    const junk = searchSlots(av, find({ durationHours: Number.NaN }), HORIZON);
    expect(junk.every((o) => o.times.length === 1)).toBe(true);
  });

  it('consecutive: true убирает одиночки, иначе они остаются запасным вариантом', () => {
    const av = mapOf([C3, '2026-08-06', ['20:00', '22:00']]); // связки нет вовсе

    expect(searchSlots(av, find({ durationHours: 2, consecutive: true }), HORIZON)).toEqual([]);
    expect(searchSlots(av, find({ durationHours: 2 }), HORIZON).map(brief)).toEqual([
      'Padel Court 3 2026-08-06 20:00',
      'Padel Court 3 2026-08-06 22:00',
    ]);
  });
});

describe('searchSlots: сортировка', () => {
  it('связки идут раньше одиночек, дальше по дате, времени и корту', () => {
    const av = mapOf(
      [C4, '2026-08-07', ['19:00']],
      [C3, '2026-08-06', ['20:00', '21:00']],
      [C1, '2026-08-06', ['19:00']],
    );
    expect(searchSlots(av, find({ durationHours: 2 }), HORIZON).map(brief)).toEqual([
      // связка — первой, дальше одиночки по дате/времени
      'Padel Court 3 2026-08-06 20:00+21:00',
      'Padel Court 1 2026-08-06 19:00',
      'Padel Court 3 2026-08-06 20:00',
      'Padel Court 3 2026-08-06 21:00',
      'Padel Court 4 2026-08-07 19:00',
    ]);
  });

  it('порядок не зависит от порядка ключей в карте', () => {
    const forward = mapOf([C1, '2026-08-06', ['20:00']], [C4, '2026-08-05', ['20:00']]);
    const backward = mapOf([C4, '2026-08-05', ['20:00']], [C1, '2026-08-06', ['20:00']]);
    const expected = ['Padel Court 4 2026-08-05 20:00', 'Padel Court 1 2026-08-06 20:00'];
    expect(searchSlots(forward, find(), HORIZON).map(brief)).toEqual(expected);
    expect(searchSlots(backward, find(), HORIZON).map(brief)).toEqual(expected);
  });
});

describe('searchSlots: лимит', () => {
  it('отдаёт не больше 8 вариантов, а countSlotOptions знает полное число', () => {
    const hours = ['08:00', '09:00', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00', '17:00'];
    const av = mapOf([C3, '2026-08-06', hours]);

    expect(MAX_SLOT_OPTIONS).toBe(8);
    expect(searchSlots(av, find(), HORIZON)).toHaveLength(8);
    expect(countSlotOptions(av, find(), HORIZON)).toBe(10);
    // Первые восемь — это именно самые ранние, а не случайные.
    expect(searchSlots(av, find(), HORIZON).map((o) => o.times[0])).toEqual(hours.slice(0, 8));
  });
});

describe('searchSlots: фильтры', () => {
  it('даты вне горизонта не рассматриваются, даже если приехали в карте', () => {
    const av = mapOf(
      [C3, '2026-08-03', ['20:00']], // вчера
      [C3, '2026-08-20', ['20:00']], // дальше T+7
      [C3, '2026-08-06', ['20:00']],
    );
    expect(searchSlots(av, find(), HORIZON).map(brief)).toEqual(['Padel Court 3 2026-08-06 20:00']);
  });

  it('диапазон намерения сужает горизонт, но не расширяет его', () => {
    const av = mapOf([C3, '2026-08-05', ['20:00']], [C3, '2026-08-06', ['20:00']], [C3, '2026-08-09', ['20:00']]);

    expect(searchSlots(av, find({ dateFrom: '2026-08-06', dateTo: '2026-08-06' }), HORIZON).map(brief)).toEqual([
      'Padel Court 3 2026-08-06 20:00',
    ]);
    // Попытка выйти за горизонт результата не добавляет.
    expect(
      searchSlots(av, find({ dateFrom: '2026-01-01', dateTo: '2027-01-01' }), HORIZON).map(brief),
    ).toHaveLength(3);
    // Пустой диапазон (from > to) — пустой результат, а не «весь горизонт».
    expect(searchSlots(av, find({ dateFrom: '2026-08-09', dateTo: '2026-08-05' }), HORIZON)).toEqual([]);
  });

  it('корты фильтруются по списку намерения, регистр не важен', () => {
    const av = mapOf([C3, '2026-08-06', ['20:00']], [C4, '2026-08-06', ['20:00']], [C1, '2026-08-06', ['20:00']]);

    expect(searchSlots(av, find({ courts: ['padel court 4', 'Padel Court 3'] }), HORIZON).map(brief)).toEqual([
      'Padel Court 3 2026-08-06 20:00',
      'Padel Court 4 2026-08-06 20:00',
    ]);
    // Пустой список кортов = любой корт.
    expect(searchSlots(av, find({ courts: [] }), HORIZON)).toHaveLength(3);
  });

  it('окно времени применяется к НАЧАЛУ связки', () => {
    const av = mapOf([C3, '2026-08-06', ['18:00', '19:00', '20:00', '21:00', '22:00']]);

    expect(searchSlots(av, find({ timeFrom: '20:00', timeTo: '21:00' }), HORIZON).map(brief)).toEqual([
      'Padel Court 3 2026-08-06 20:00',
      'Padel Court 3 2026-08-06 21:00',
    ]);

    // Точечный запрос «в 20:00 на два часа»: окно схлопнуто в одну точку, но
    // связка всё равно находится — иначе такой запрос всегда был бы пустым.
    expect(
      searchSlots(av, find({ timeFrom: '20:00', timeTo: '20:00', durationHours: 2, consecutive: true }), HORIZON).map(
        brief,
      ),
    ).toEqual(['Padel Court 3 2026-08-06 20:00+21:00']);
  });

  it('поля конкретного слота (kind: book) работают как фильтры', () => {
    const av = mapOf([C3, '2026-08-06', ['20:00', '21:00']], [C4, '2026-08-06', ['20:00']]);
    const booked: BookingIntent = { kind: 'book', date: '2026-08-06', time: '20:00', court: C4 };
    expect(searchSlots(av, booked, HORIZON).map(brief)).toEqual(['Padel Court 4 2026-08-06 20:00']);
  });
});

describe('searchSlots: устойчивость к мусору', () => {
  it('битые ключи и слоты без разбираемого start просто игнорируются', () => {
    const av = new Map<string, Slot[]>([
      ['без-разделителя', slots('2026-08-06', ['20:00'])],
      ['|2026-08-06', slots('2026-08-06', ['20:00'])],
      [slotKey(C3, 'не-дата'), slots('2026-08-06', ['20:00'])],
      [
        slotKey(C3, '2026-08-06'),
        [
          { start: 'мусор', end: 'мусор' },
          { start: '2026-08-06T20:00:00+04:00', end: '2026-08-06T20:59:00+04:00' },
          // дубль того же часа от API схлопывается
          { start: '2026-08-06T20:00:00+04:00', end: '2026-08-06T20:59:00+04:00' },
        ],
      ],
    ]);
    expect(searchSlots(av, find(), HORIZON).map(brief)).toEqual(['Padel Court 3 2026-08-06 20:00']);
  });

  it('пустая карта и пустые списки слотов дают пустой результат', () => {
    expect(searchSlots(new Map(), find(), HORIZON)).toEqual([]);
    expect(searchSlots(mapOf([C3, '2026-08-06', []]), find(), HORIZON)).toEqual([]);
    expect(countSlotOptions(new Map(), find(), HORIZON)).toBe(0);
  });
});
