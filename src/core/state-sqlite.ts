// SqliteStateStore — локальный/ручной запуск (CLI run-drop, отладка).
//
// ЕДИНСТВЕННОЕ место в проекте, импортирующее better-sqlite3. Native-модуль не
// собирается на воркерах trigger.dev, поэтому облачный код (src/trigger/*) не
// должен подтягивать этот файл ни прямо, ни транзитивно — см. state.ts.
//
// Вызовы better-sqlite3 синхронны; методы объявлены async только ради общего
// контракта StateStore (его сетевые реализации иначе не выразить).

import Database from 'better-sqlite3';
import type { StateStore, StoredBooking } from './state.js';

const COLUMNS = 'profileId, date, time, court, bookingId, token, state, createdAt';

export class SqliteStateStore implements StateStore {
  private db: Database.Database;

  constructor(filePath: string) {
    this.db = new Database(filePath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS bookings (
        profileId TEXT NOT NULL,
        date TEXT NOT NULL,
        time TEXT NOT NULL,
        court TEXT NOT NULL,
        bookingId TEXT NOT NULL,
        token TEXT NOT NULL,
        state TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        PRIMARY KEY (profileId, date, time)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_bookings_slot
        ON bookings (profileId, date, time);
      CREATE INDEX IF NOT EXISTS idx_bookings_bookingId
        ON bookings (bookingId);
    `);
  }

  async getBooking(profileId: string, date: string, time: string): Promise<StoredBooking | null> {
    const row = this.db
      .prepare(`SELECT ${COLUMNS} FROM bookings WHERE profileId = ? AND date = ? AND time = ?`)
      .get(profileId, date, time) as StoredBooking | undefined;
    return row ?? null;
  }

  async saveBooking(b: StoredBooking): Promise<void> {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO bookings
           (profileId, date, time, court, bookingId, token, state, createdAt)
         VALUES (@profileId, @date, @time, @court, @bookingId, @token, @state, @createdAt)`,
      )
      .run(b);
  }

  async listBookings(profileId?: string): Promise<StoredBooking[]> {
    if (profileId === undefined) {
      return this.db.prepare(`SELECT ${COLUMNS} FROM bookings ORDER BY date, time`).all() as StoredBooking[];
    }
    return this.db
      .prepare(`SELECT ${COLUMNS} FROM bookings WHERE profileId = ? ORDER BY date, time`)
      .all(profileId) as StoredBooking[];
  }

  async markCanceled(bookingId: string): Promise<void> {
    this.db.prepare('UPDATE bookings SET state = ? WHERE bookingId = ?').run('canceled', bookingId);
  }
}
