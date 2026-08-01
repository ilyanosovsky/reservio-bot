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
    // Ключ = слот + КОРТ: на один час бывает несколько броней на разных кортах
    // (см. state.ts). PRIMARY KEY у таблицы нет намеренно — уникальность держит
    // индекс, который можно пересоздать; неявный индекс PK в SQLite — нельзя.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS bookings (
        profileId TEXT NOT NULL,
        date TEXT NOT NULL,
        time TEXT NOT NULL,
        court TEXT NOT NULL,
        bookingId TEXT NOT NULL,
        token TEXT NOT NULL,
        state TEXT NOT NULL,
        createdAt TEXT NOT NULL
      );
    `);
    this.migrateLegacySlotKey();
    this.db.exec(`
      DROP INDEX IF EXISTS idx_bookings_slot;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_bookings_slot_court
        ON bookings (profileId, date, time, court);
      CREATE INDEX IF NOT EXISTS idx_bookings_bookingId
        ON bookings (bookingId);
    `);
  }

  /**
   * Файлы, созданные до 01.08.2026, несут PRIMARY KEY (profileId, date, time).
   * Его неявный индекс (sqlite_autoindex_*) не удаляется, и вторая бронь того же
   * часа на другом корте падала бы на UNIQUE-конфликте. Лечится только
   * пересборкой таблицы; на свежем файле не делает ничего.
   */
  private migrateLegacySlotKey(): void {
    const cols = this.db.prepare('PRAGMA table_info(bookings)').all() as Array<{ name: string; pk: number }>;
    if (!cols.some((c) => c.pk > 0)) return;

    // Данные переезжают как есть: старый ключ (profileId,date,time) строже
    // нового, так что уникальность (profileId,date,time,court) заведомо цела.
    this.db.exec(`
      BEGIN;
      ALTER TABLE bookings RENAME TO bookings_legacy;
      CREATE TABLE bookings (
        profileId TEXT NOT NULL,
        date TEXT NOT NULL,
        time TEXT NOT NULL,
        court TEXT NOT NULL,
        bookingId TEXT NOT NULL,
        token TEXT NOT NULL,
        state TEXT NOT NULL,
        createdAt TEXT NOT NULL
      );
      INSERT INTO bookings (${COLUMNS}) SELECT ${COLUMNS} FROM bookings_legacy;
      DROP TABLE bookings_legacy;
      COMMIT;
    `);
  }

  async getBooking(profileId: string, date: string, time: string, court: string): Promise<StoredBooking | null> {
    const row = this.db
      .prepare(`SELECT ${COLUMNS} FROM bookings WHERE profileId = ? AND date = ? AND time = ? AND court = ?`)
      .get(profileId, date, time, court) as StoredBooking | undefined;
    return row ?? null;
  }

  async listBookingsForSlot(profileId: string, date: string, time: string): Promise<StoredBooking[]> {
    return this.db
      .prepare(`SELECT ${COLUMNS} FROM bookings WHERE profileId = ? AND date = ? AND time = ? ORDER BY court`)
      .all(profileId, date, time) as StoredBooking[];
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
    // Корт в ORDER BY: на один час теперь бывает несколько броней, и без него
    // порядок между ними не определён.
    if (profileId === undefined) {
      return this.db.prepare(`SELECT ${COLUMNS} FROM bookings ORDER BY date, time, court`).all() as StoredBooking[];
    }
    return this.db
      .prepare(`SELECT ${COLUMNS} FROM bookings WHERE profileId = ? ORDER BY date, time, court`)
      .all(profileId) as StoredBooking[];
  }

  async markCanceled(bookingId: string): Promise<void> {
    this.db.prepare('UPDATE bookings SET state = ? WHERE bookingId = ?').run('canceled', bookingId);
  }
}
