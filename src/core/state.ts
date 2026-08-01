// Контракт хранилища состояния: подтверждённые брони, дедупликация
// по (profileId, date, time, court).
//
// Корт в ключе с 01.08.2026 (миграция 20260801110000_multicourt.sql): клуб
// держит Court 2/3 на 20:00–22:00 под свои группы, вечером в дроп выходит то
// один корт, то другой, поэтому бот ловит НАБОР кортов и бронирует каждый
// появившийся — две брони на один час на РАЗНЫХ кортах легитимны, лишнее
// владелец отменяет руками. Отсюда две операции чтения:
//   getBooking(...court)     — точечно, «занят ли ИМЕННО этот корт»;
//   listBookingsForSlot(...) — весь слот, «есть ли на этот час хоть что-то».
//
// В ЭТОМ файле — только интерфейс и in-memory реализация. Никаких native- и
// сетевых зависимостей: файл импортируется в облаке (trigger.dev), где
// better-sqlite3 не собирается. Реализации живут отдельно:
//   state-sqlite.ts   — локальный запуск (better-sqlite3, файл на диске)
//   state-supabase.ts — облако (Supabase/PostgREST через fetch)
//
// Все методы асинхронные: сетевое хранилище иначе не выразить. Синхронные
// реализации (Memory, SQLite) просто возвращают уже готовый Promise.

export interface StoredBooking {
  profileId: string;
  date: string;
  time: string;
  court: string;
  bookingId: string;
  token: string;
  state: string;
  createdAt: string;
}

export interface StateStore {
  /** Точечно: бронь профиля на КОНКРЕТНОМ корте в этот час (или null). */
  getBooking(profileId: string, date: string, time: string, court: string): Promise<StoredBooking | null>;
  /** Все брони профиля на этот час — по всем кортам (включая отменённые). */
  listBookingsForSlot(profileId: string, date: string, time: string): Promise<StoredBooking[]>;
  saveBooking(b: StoredBooking): Promise<void>;
  listBookings(profileId?: string): Promise<StoredBooking[]>;
  markCanceled(bookingId: string): Promise<void>;
}

/**
 * Ключ дедупликации: один слот НА ОДНОМ КОРТЕ (profileId, date, time, court) —
 * максимум одна активная бронь. Тот же набор колонок, что у уникального индекса
 * bookings_profile_slot_court.
 */
export function dedupeKey(profileId: string, date: string, time: string, court: string): string {
  return `${profileId} ${date} ${time} ${court}`;
}

/**
 * In-memory хранилище: тесты и любой хост без персистентности.
 * Наружу отдаёт копии записей — как SQL-реализации, где строка всегда новая;
 * иначе поведение Memory и Sqlite/Supabase расходилось бы на мутациях.
 */
export class MemoryStateStore implements StateStore {
  private byKey = new Map<string, StoredBooking>();

  async getBooking(profileId: string, date: string, time: string, court: string): Promise<StoredBooking | null> {
    const found = this.byKey.get(dedupeKey(profileId, date, time, court));
    return found ? { ...found } : null;
  }

  async listBookingsForSlot(profileId: string, date: string, time: string): Promise<StoredBooking[]> {
    return [...this.byKey.values()]
      .filter((b) => b.profileId === profileId && b.date === date && b.time === time)
      .sort((a, b) => a.court.localeCompare(b.court))
      .map((b) => ({ ...b }));
  }

  async saveBooking(b: StoredBooking): Promise<void> {
    // INSERT OR REPLACE-семантика: перезаписываем запись по ключу слот+корт.
    this.byKey.set(dedupeKey(b.profileId, b.date, b.time, b.court), { ...b });
  }

  async listBookings(profileId?: string): Promise<StoredBooking[]> {
    const all = [...this.byKey.values()];
    const filtered = profileId === undefined ? all : all.filter((b) => b.profileId === profileId);
    // Корт в ключе сортировки: на один час теперь бывает несколько броней, и
    // без него порядок между ними зависел бы от порядка вставки.
    return filtered
      .sort((a, b) => (a.date + a.time + a.court).localeCompare(b.date + b.time + b.court))
      .map((b) => ({ ...b }));
  }

  async markCanceled(bookingId: string): Promise<void> {
    for (const b of this.byKey.values()) {
      if (b.bookingId === bookingId) {
        b.state = 'canceled';
      }
    }
  }
}
