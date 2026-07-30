// Тесты StateStore: один и тот же набор поведенческих проверок гоняется
// и на MemoryStateStore, и на SqliteStateStore (файл во временной директории).
// Контракт асинхронный — сетевая реализация (Supabase) иначе не выражается.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MemoryStateStore, type StateStore, type StoredBooking } from '../src/core/state.js';
import { SqliteStateStore } from '../src/core/state-sqlite.js';

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

  it('getBooking по несуществующему слоту возвращает null', async () => {
    await expect(store.getBooking('ilya', '2026-08-06', '20:00')).resolves.toBeNull();
  });

  it('roundtrip: saveBooking затем getBooking возвращает те же поля', async () => {
    const b = booking();
    await store.saveBooking(b);
    await expect(store.getBooking(b.profileId, b.date, b.time)).resolves.toEqual(b);
  });

  it('markCanceled меняет state сохранённой брони на canceled', async () => {
    const b = booking({ state: 'confirmed' });
    await store.saveBooking(b);
    await store.markCanceled(b.bookingId);
    expect((await store.getBooking(b.profileId, b.date, b.time))?.state).toBe('canceled');
  });

  it('markCanceled по несуществующему bookingId ничего не ломает', async () => {
    await expect(store.markCanceled('nope')).resolves.toBeUndefined();
  });

  it('уникальность profileId+date+time: повторный save перезаписывает, не дублирует', async () => {
    const b1 = booking({ bookingId: 'booking-1', token: 'token-1', state: 'confirmed' });
    await store.saveBooking(b1);
    const b2 = booking({ bookingId: 'booking-2', token: 'token-2', state: 'confirmed' });
    await store.saveBooking(b2);

    // Тот же слот -> только вторая запись, не дубль.
    expect((await store.getBooking(b1.profileId, b1.date, b1.time))?.bookingId).toBe('booking-2');
    await expect(store.listBookings(b1.profileId)).resolves.toHaveLength(1);
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
    const got = (await store.getBooking(b.profileId, b.date, b.time))!;
    got.state = 'canceled';
    got.token = 'подменён';
    expect(await store.getBooking(b.profileId, b.date, b.time)).toEqual(b);
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
    await expect(reopened.getBooking('ilya', '2026-08-06', '20:00')).resolves.toEqual(booking());
  });
});

/** Код без комментариев: упоминание пакета в пояснении — не зависимость. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
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
