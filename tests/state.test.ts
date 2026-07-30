// Тесты StateStore: один и тот же набор поведенческих проверок гоняется
// и на MemoryStateStore, и на SqliteStateStore (файл во временной директории).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStateStore, SqliteStateStore, type StateStore, type StoredBooking } from '../src/core/state.js';

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

// Общий набор проверок контракта StateStore — вызывается с фабрикой конкретной реализации.
function runStateStoreContract(makeStore: () => StateStore) {
  let store: StateStore;

  beforeEach(() => {
    store = makeStore();
  });

  it('getBooking по несуществующему слоту возвращает null', () => {
    expect(store.getBooking('ilya', '2026-08-06', '20:00')).toBeNull();
  });

  it('roundtrip: saveBooking затем getBooking возвращает те же поля', () => {
    const b = booking();
    store.saveBooking(b);
    expect(store.getBooking(b.profileId, b.date, b.time)).toEqual(b);
  });

  it('markCanceled меняет state сохранённой брони на canceled', () => {
    const b = booking({ state: 'confirmed' });
    store.saveBooking(b);
    store.markCanceled(b.bookingId);
    expect(store.getBooking(b.profileId, b.date, b.time)?.state).toBe('canceled');
  });

  it('markCanceled по несуществующему bookingId ничего не ломает', () => {
    expect(() => store.markCanceled('nope')).not.toThrow();
  });

  it('уникальность profileId+date+time: повторный save перезаписывает, не дублирует', () => {
    const b1 = booking({ bookingId: 'booking-1', token: 'token-1', state: 'confirmed' });
    store.saveBooking(b1);
    const b2 = booking({ bookingId: 'booking-2', token: 'token-2', state: 'confirmed' });
    store.saveBooking(b2);

    // Тот же слот -> только вторая запись, не дубль.
    expect(store.getBooking(b1.profileId, b1.date, b1.time)?.bookingId).toBe('booking-2');
    expect(store.listBookings(b1.profileId)).toHaveLength(1);
  });

  it('listBookings без фильтра возвращает брони всех профилей', () => {
    store.saveBooking(booking({ profileId: 'ilya', time: '20:00', bookingId: 'b-ilya' }));
    store.saveBooking(booking({ profileId: 'nina', time: '21:00', bookingId: 'b-nina' }));

    const all = store.listBookings();
    expect(all).toHaveLength(2);
    expect(all.map((b) => b.bookingId).sort()).toEqual(['b-ilya', 'b-nina']);
  });

  it('listBookings с фильтром profileId возвращает только брони этого профиля', () => {
    store.saveBooking(booking({ profileId: 'ilya', time: '20:00', bookingId: 'b-ilya-1' }));
    store.saveBooking(booking({ profileId: 'ilya', time: '21:00', bookingId: 'b-ilya-2' }));
    store.saveBooking(booking({ profileId: 'nina', time: '20:00', bookingId: 'b-nina' }));

    const ilyaOnly = store.listBookings('ilya');
    expect(ilyaOnly).toHaveLength(2);
    expect(ilyaOnly.every((b) => b.profileId === 'ilya')).toBe(true);
  });

  it('listBookings с фильтром на профиль без броней возвращает пустой массив', () => {
    store.saveBooking(booking({ profileId: 'ilya' }));
    expect(store.listBookings('someone-else')).toEqual([]);
  });
}

describe('MemoryStateStore', () => {
  runStateStoreContract(() => new MemoryStateStore());
});

describe('SqliteStateStore', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'reservio-bot-state-'));
    dbPath = join(dir, 'state.db');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  runStateStoreContract(() => new SqliteStateStore(dbPath));

  it('данные переживают переоткрытие того же файла', () => {
    const first = new SqliteStateStore(dbPath);
    first.saveBooking(booking());

    const reopened = new SqliteStateStore(dbPath);
    expect(reopened.getBooking('ilya', '2026-08-06', '20:00')).toEqual(booking());
  });
});
