// Тесты StateStore: один и тот же набор поведенческих проверок гоняется
// и на MemoryStateStore, и на SqliteStateStore (файл во временной директории).
// Контракт асинхронный — сетевая реализация (Supabase) иначе не выражается.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MemoryStateStore, type StateStore, type StoredBooking } from '../src/core/state.js';
import { SqliteStateStore } from '../src/core/state-sqlite.js';

const COURT_1 = 'Padel Court 1';
const COURT_3 = 'Padel Court 3';
const COURT_4 = 'Padel Court 4';

function booking(overrides: Partial<StoredBooking> = {}): StoredBooking {
  return {
    profileId: 'ilya',
    date: '2026-08-06',
    time: '20:00',
    court: COURT_3,
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

  it('getBooking по несуществующему слоту возвращает null', async () => {
    await expect(store.getBooking('ilya', '2026-08-06', '20:00', COURT_3)).resolves.toBeNull();
  });

  it('roundtrip: saveBooking затем getBooking возвращает те же поля', async () => {
    const b = booking();
    await store.saveBooking(b);
    await expect(store.getBooking(b.profileId, b.date, b.time, b.court)).resolves.toEqual(b);
  });

  it('markCanceled меняет state сохранённой брони на canceled', async () => {
    const b = booking({ state: 'confirmed' });
    await store.saveBooking(b);
    await store.markCanceled(b.bookingId);
    expect((await store.getBooking(b.profileId, b.date, b.time, b.court))?.state).toBe('canceled');
  });

  it('markCanceled по несуществующему bookingId ничего не ломает', async () => {
    await expect(store.markCanceled('nope')).resolves.toBeUndefined();
  });

  it('уникальность profileId+date+time+court: повторный save перезаписывает, не дублирует', async () => {
    const b1 = booking({ bookingId: 'booking-1', token: 'token-1', state: 'confirmed' });
    await store.saveBooking(b1);
    const b2 = booking({ bookingId: 'booking-2', token: 'token-2', state: 'confirmed' });
    await store.saveBooking(b2);

    // Тот же слот и тот же корт -> только вторая запись, не дубль.
    expect((await store.getBooking(b1.profileId, b1.date, b1.time, b1.court))?.bookingId).toBe('booking-2');
    await expect(store.listBookings(b1.profileId)).resolves.toHaveLength(1);
  });

  it('один час на РАЗНЫХ кортах — две независимые брони, а не перезапись', async () => {
    // Требование владельца: клуб держит вечерние корты под свои группы, бот
    // ловит набор кортов и бронирует каждый появившийся. Старый ключ
    // (profileId,date,time) затирал первую бронь второй — и её нечем отменить.
    const c3 = booking({ court: COURT_3, bookingId: 'b-c3', token: 'token-c3' });
    const c4 = booking({ court: COURT_4, bookingId: 'b-c4', token: 'token-c4' });
    await store.saveBooking(c3);
    await store.saveBooking(c4);

    await expect(store.getBooking('ilya', '2026-08-06', '20:00', COURT_3)).resolves.toEqual(c3);
    await expect(store.getBooking('ilya', '2026-08-06', '20:00', COURT_4)).resolves.toEqual(c4);
    await expect(store.listBookings('ilya')).resolves.toHaveLength(2);
  });

  it('getBooking по другому корту того же часа возвращает null', async () => {
    await store.saveBooking(booking({ court: COURT_3 }));
    await expect(store.getBooking('ilya', '2026-08-06', '20:00', COURT_4)).resolves.toBeNull();
  });

  it('listBookingsForSlot отдаёт все корты часа, отсортированные по корту', async () => {
    await store.saveBooking(booking({ court: COURT_4, bookingId: 'b-c4' }));
    await store.saveBooking(booking({ court: COURT_3, bookingId: 'b-c3' }));
    // соседний час и чужой профиль в выборку попасть не должны
    await store.saveBooking(booking({ time: '21:00', court: COURT_3, bookingId: 'b-21' }));
    await store.saveBooking(booking({ profileId: 'nina', court: COURT_1, bookingId: 'b-nina' }));

    const rows = await store.listBookingsForSlot('ilya', '2026-08-06', '20:00');
    expect(rows.map((b) => b.court)).toEqual([COURT_3, COURT_4]);
    expect(rows.map((b) => b.bookingId)).toEqual(['b-c3', 'b-c4']);
  });

  it('listBookingsForSlot показывает и отменённые брони (решает вызыватель)', async () => {
    const b = booking();
    await store.saveBooking(b);
    await store.markCanceled(b.bookingId);

    const rows = await store.listBookingsForSlot('ilya', '2026-08-06', '20:00');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.state).toBe('canceled');
  });

  it('listBookingsForSlot по пустому часу возвращает пустой массив', async () => {
    await store.saveBooking(booking({ time: '21:00' }));
    await expect(store.listBookingsForSlot('ilya', '2026-08-06', '20:00')).resolves.toEqual([]);
  });

  it('listBookings без фильтра возвращает брони всех профилей', async () => {
    await store.saveBooking(booking({ profileId: 'ilya', time: '20:00', bookingId: 'b-ilya' }));
    await store.saveBooking(booking({ profileId: 'nina', time: '21:00', bookingId: 'b-nina' }));

    const all = await store.listBookings();
    expect(all).toHaveLength(2);
    expect(all.map((b) => b.bookingId).sort()).toEqual(['b-ilya', 'b-nina']);
  });

  it('listBookings с фильтром profileId возвращает только брони этого профиля', async () => {
    await store.saveBooking(booking({ profileId: 'ilya', time: '20:00', bookingId: 'b-ilya-1' }));
    await store.saveBooking(booking({ profileId: 'ilya', time: '21:00', bookingId: 'b-ilya-2' }));
    await store.saveBooking(booking({ profileId: 'nina', time: '20:00', bookingId: 'b-nina' }));

    const ilyaOnly = await store.listBookings('ilya');
    expect(ilyaOnly).toHaveLength(2);
    expect(ilyaOnly.every((b) => b.profileId === 'ilya')).toBe(true);
  });

  it('listBookings с фильтром на профиль без броней возвращает пустой массив', async () => {
    await store.saveBooking(booking({ profileId: 'ilya' }));
    await expect(store.listBookings('someone-else')).resolves.toEqual([]);
  });

  it('мутация возвращённой записи не меняет хранилище', async () => {
    // Sqlite/Supabase всегда отдают свежую строку; Memory обязан вести себя так же,
    // иначе баг «поправили объект из getBooking» проявится только в облаке.
    const b = booking();
    await store.saveBooking(b);
    const got = (await store.getBooking(b.profileId, b.date, b.time, b.court))!;
    got.state = 'canceled';
    got.token = 'подменён';
    expect(await store.getBooking(b.profileId, b.date, b.time, b.court)).toEqual(b);
  });

  it('мутация записи из listBookingsForSlot тоже не меняет хранилище', async () => {
    const b = booking();
    await store.saveBooking(b);
    const [got] = await store.listBookingsForSlot(b.profileId, b.date, b.time);
    got!.token = 'подменён';
    expect(await store.listBookingsForSlot(b.profileId, b.date, b.time)).toEqual([b]);
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

  it('данные переживают переоткрытие того же файла', async () => {
    const first = new SqliteStateStore(dbPath);
    await first.saveBooking(booking());

    const reopened = new SqliteStateStore(dbPath);
    await expect(reopened.getBooking('ilya', '2026-08-06', '20:00', COURT_3)).resolves.toEqual(booking());
  });

  it('файл старой схемы (PRIMARY KEY без корта) мигрирует: данные целы, второй корт влезает', async () => {
    // До 01.08.2026 таблица несла PRIMARY KEY (profileId, date, time). Его
    // неявный индекс в SQLite не удаляется, поэтому вторая бронь того же часа
    // на другом корте падала бы на UNIQUE-конфликте — лечится пересборкой.
    // Отдельный файл: dbPath уже создан общим контрактом (beforeEach выше).
    const legacyPath = join(dir, 'legacy.db');
    const legacy = new Database(legacyPath);
    legacy.exec(`
      CREATE TABLE bookings (
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
      CREATE UNIQUE INDEX idx_bookings_slot ON bookings (profileId, date, time);
      INSERT INTO bookings VALUES
        ('ilya','2026-08-06','20:00','Padel Court 3','booking-1','token-1','confirmed','2026-07-30T19:58:51+04:00');
    `);
    legacy.close();

    const store = new SqliteStateStore(legacyPath);
    // старая бронь на месте, ничего не потеряно
    await expect(store.getBooking('ilya', '2026-08-06', '20:00', COURT_3)).resolves.toEqual(booking());
    // и теперь тот же час на другом корте сохраняется, а не конфликтует
    const c4 = booking({ court: COURT_4, bookingId: 'b-c4', token: 'token-c4' });
    await store.saveBooking(c4);
    await expect(store.listBookingsForSlot('ilya', '2026-08-06', '20:00')).resolves.toEqual([booking(), c4]);
  });

  it('повторное открытие мигрированного файла не ломает данные', async () => {
    const first = new SqliteStateStore(dbPath);
    await first.saveBooking(booking());
    await first.saveBooking(booking({ court: COURT_4, bookingId: 'b-c4' }));

    const reopened = new SqliteStateStore(dbPath);
    await expect(reopened.listBookingsForSlot('ilya', '2026-08-06', '20:00')).resolves.toHaveLength(2);
  });
});

/**
 * Код без комментариев: упоминание пакета в пояснении — не зависимость.
 *
 * Строчные комментарии вырезаются ПЕРВЫМИ и только потом блочные: в пояснениях
 * встречается «src/trigger/*», и при обратном порядке этот `/*` открывал бы
 * фиктивный блочный комментарий до ближайшего `*` + `/` в файле — вместе с
 * настоящими import'ами, которые тест как раз и должен видеть.
 */
function stripComments(src: string): string {
  return src.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

/**
 * Транзитивный обход импортов от файла-корня. Относительные `./x.js`
 * разрешаются в `./x.ts` (NodeNext-стиль этого проекта), внешние пакеты
 * возвращаются как есть — их содержимое не читаем.
 */
function importGraph(entryFile: string): { files: string[]; packages: string[] } {
  const files: string[] = [];
  const packages = new Set<string>();
  const queue = [entryFile];

  while (queue.length > 0) {
    const file = queue.shift()!;
    if (files.includes(file)) continue;
    files.push(file);

    const src = stripComments(readFileSync(file, 'utf8'));
    // и `import ... from 'x'`, и голое `import 'x'`
    for (const m of src.matchAll(/from\s+['"]([^'"]+)['"]|import\s+['"]([^'"]+)['"]/g)) {
      const spec = m[1] ?? m[2]!;
      if (!spec.startsWith('.')) {
        packages.add(spec);
        continue;
      }
      queue.push(resolve(dirname(file), spec.replace(/\.js$/, '.ts')));
    }
  }

  return { files, packages: [...packages] };
}

describe('изоляция native-зависимостей', () => {
  const srcDir = resolve(dirname(fileURLToPath(import.meta.url)), '../src');

  it('src/core/state.ts не тянет better-sqlite3', () => {
    // Регрессия на облако: better-sqlite3 — native-модуль, на воркерах
    // trigger.dev он недоступен. state.ts импортируют и облачные модули, так
    // что любой импорт отсюда роняет деплой целиком.
    const src = stripComments(readFileSync(join(srcDir, 'core/state.ts'), 'utf8'));
    expect(src).not.toContain('better-sqlite3');
  });

  it('таск trigger.dev не тянет better-sqlite3 ни по одной цепочке импортов', () => {
    // Главная защита деплоя: better-sqlite3 не собирается на воркерах, и любой
    // транзитивный импорт (например, случайный `state-sqlite` вместо `state`)
    // ломает бандл целиком — молча, до самого вечернего прогона.
    const { files, packages } = importGraph(join(srcDir, 'trigger/book-drop.ts'));

    expect(packages).not.toContain('better-sqlite3');
    expect(files.filter((f) => f.includes('state-sqlite'))).toEqual([]);
    // обход действительно прошёл по графу, а не остановился на входном файле
    expect(files.length).toBeGreaterThan(5);
    expect(files.some((f) => f.endsWith('core/state-supabase.ts'))).toBe(true);
  });

  // Точки входа, которые собираются НЕ на этой машине: таски едут на воркеры
  // trigger.dev, бот — на хостинг из docs/wiki/Hosting.md. Ни там, ни там
  // native-модуля нет, и оба работают только через Supabase.
  const CLOUD_ENTRIES = [
    'trigger/book-drop.ts',
    'trigger/remind.ts',
    'trigger/daily-planner.ts',
    'trigger/drop-observe.ts',
    'trigger/heartbeat.ts',
    'bot/index.ts',
  ];

  it.each(CLOUD_ENTRIES)('%s не тянет better-sqlite3 ни по одной цепочке импортов', (entry) => {
    const { files, packages } = importGraph(join(srcDir, entry));

    expect(packages).not.toContain('better-sqlite3');
    expect(files.filter((f) => f.includes('state-sqlite'))).toEqual([]);
  });

  it('grammY живёт только в src/bot: облачные таски его не тянут', () => {
    // Обратная страховка к предыдущей: бот не должен протечь в таски. Общий
    // код между ними — только чистое ядро (state/scheduler/reservio).
    for (const entry of CLOUD_ENTRIES.filter((e) => e.startsWith('trigger/'))) {
      expect(importGraph(join(srcDir, entry)).packages).not.toContain('grammy');
    }
  });

  it('SqliteStateStore живёт ровно в одном файле', () => {
    // Единственная точка импорта native-модуля — иначе изоляцию выше
    // невозможно поддерживать: следующий импорт better-sqlite3 появится
    // в файле, который облако как раз тянет.
    const owners = ['core/state.ts', 'core/state-sqlite.ts', 'core/state-supabase.ts', 'core/booking-engine.ts', 'trigger/book-drop.ts', 'run-drop.ts'].filter(
      (rel) => stripComments(readFileSync(join(srcDir, rel), 'utf8')).includes('better-sqlite3'),
    );
    expect(owners).toEqual(['core/state-sqlite.ts']);
  });
});
