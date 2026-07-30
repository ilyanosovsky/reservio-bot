// Тесты обвязки облачного рана (src/trigger/book-drop.ts): деградация state,
// инвариант наблюдаемости «ровно одно сообщение за ран» и приватность отчёта.
// Движок и отправка в Telegram замоканы — проверяются решения таска, а не
// бронирование как таковое.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DropReport } from '../src/core/booking-engine.js';
import type { StateStore, StoredBooking } from '../src/core/state.js';
import { bookSlotDropTask, ResilientStateStore } from '../src/trigger/book-drop.js';

// Публичный тип Task из SDK не отдаёт саму run-функцию, а поднимать воркер ради
// этих тестов незачем: подменяем task() на «верни конфиг как есть».
vi.mock('@trigger.dev/sdk', () => ({
  task: (config: unknown) => config,
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), log: vi.fn() },
}));

const bookSlotDropMock = vi.fn<(...args: unknown[]) => Promise<DropReport>>();
vi.mock('../src/core/booking-engine.js', () => ({
  bookSlotDrop: (...args: unknown[]) => bookSlotDropMock(...args),
}));

const sendTelegramMock = vi.fn<(...args: unknown[]) => Promise<boolean>>();
vi.mock('../src/core/notify.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/notify.js')>();
  return { ...actual, sendTelegram: (...args: unknown[]) => sendTelegramMock(...args) };
});

interface Payload {
  profileId: string;
  date: string;
  time: string;
  live: boolean;
  force?: boolean;
}
const run = (bookSlotDropTask as unknown as { run: (p: Payload) => Promise<DropReport> }).run;

/** Дата в прошлом: окно дропа давно закрыто, значит проверка «стартовал слишком рано» пройдена. */
const DATE = '2026-07-16';
const TIME = '20:00';
const EMAIL = 'player.test@example.com';
const BOT_TOKEN = '123456:AAsecretTokenValueDoNotLeak';
const TOKEN = 'guest-token-value-1234';

const BASE_ENV: Record<string, string> = {
  CLIENT_NAME: 'Test Player Name',
  CLIENT_EMAIL: EMAIL,
  CLIENT_PHONE: '+995555000111',
  TELEGRAM_BOT_TOKEN: BOT_TOKEN,
  TELEGRAM_CHAT_ID: '-100500',
};

/** Переменные, которыми управляют эти тесты: чужие значения из окружения хоста мешают. */
const OWN_ENV_RE = /^(CLIENT_|PROFILE_|SUPABASE_|TELEGRAM_)/;
let savedEnv: NodeJS.ProcessEnv;

function payload(patch: Partial<Payload> = {}): Payload {
  return { profileId: 'ilya', date: DATE, time: TIME, live: true, ...patch };
}

function okReport(patch: Partial<DropReport> = {}): DropReport {
  return {
    ok: true,
    profileId: 'ilya',
    date: DATE,
    time: TIME,
    court: 'Padel Court 3',
    bookingId: 'booking-1',
    token: TOKEN,
    msFromSeenToBooked: 900,
    timeline: [],
    ...patch,
  };
}

function useSupabaseEnv(): void {
  process.env.SUPABASE_URL = 'https://project.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key-value-000';
}

/** Ответ PostgREST на пробное чтение: брони на слот нет. */
function supabaseAlive(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } })),
  );
}

function supabaseDown(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('network down');
    }),
  );
}

/** Текст первого (и по инварианту единственного) сообщения в Telegram. */
function sentText(): string {
  expect(sendTelegramMock).toHaveBeenCalled();
  return String(sendTelegramMock.mock.calls[0]![1]);
}

beforeEach(() => {
  savedEnv = { ...process.env };
  for (const key of Object.keys(process.env)) {
    if (OWN_ENV_RE.test(key)) delete process.env[key];
  }
  Object.assign(process.env, BASE_ENV);
  sendTelegramMock.mockReset();
  sendTelegramMock.mockResolvedValue(true);
  bookSlotDropMock.mockReset();
  bookSlotDropMock.mockResolvedValue(okReport());
});

afterEach(() => {
  process.env = { ...savedEnv };
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('ResilientStateStore', () => {
  const booking: StoredBooking = {
    profileId: 'ilya',
    date: DATE,
    time: TIME,
    court: 'Padel Court 3',
    bookingId: 'booking-1',
    token: TOKEN,
    state: 'confirmed',
    createdAt: '2026-07-16T20:58:51.000+04:00',
  };

  function primaryStub(failing: boolean): { store: StateStore; calls: string[]; repair: () => void } {
    const calls: string[] = [];
    let fails = failing;
    const guard = (op: string): void => {
      calls.push(op);
      if (fails) throw new Error('PostgREST 42P10');
    };
    const store: StateStore = {
      getBooking: async () => {
        guard('getBooking');
        return null;
      },
      saveBooking: async () => guard('saveBooking'),
      listBookings: async () => {
        guard('listBookings');
        return [];
      },
      markCanceled: async () => guard('markCanceled'),
    };
    return { store, calls, repair: () => (fails = false) };
  }

  it('живой primary: warning пуст, вызовы уходят в него', async () => {
    const primary = primaryStub(false);
    const degraded: string[] = [];
    const store = new ResilientStateStore(primary.store, (r) => degraded.push(r));

    await store.saveBooking(booking);
    await expect(store.getBooking('ilya', DATE, TIME)).resolves.toBeNull();

    expect(store.warning).toBeNull();
    expect(degraded).toEqual([]);
    expect(primary.calls).toEqual(['saveBooking', 'getBooking']);
  });

  it('отказ primary не пробрасывается наружу: ран доживает на памяти', async () => {
    // Бронь важнее персистентности — отказ хранилища не имеет права остановить
    // дроп, но обязан быть виден в отчёте.
    const primary = primaryStub(true);
    const degraded: string[] = [];
    const store = new ResilientStateStore(primary.store, (r) => degraded.push(r));

    await expect(store.getBooking('ilya', DATE, TIME)).resolves.toBeNull();
    expect(store.warning).toContain('Supabase-state недоступен');
    expect(store.warning).toContain('getBooking');
    expect(degraded).toHaveLength(1);

    // дальше это обычное in-memory хранилище
    await store.saveBooking(booking);
    await expect(store.getBooking('ilya', DATE, TIME)).resolves.toMatchObject({ bookingId: 'booking-1' });
  });

  it('деградация необратима: починившийся primary больше не дёргаем', async () => {
    // «То в базу, то мимо» — худший вариант: идемпотентность стала бы
    // непредсказуемой прямо в середине дропа.
    const primary = primaryStub(true);
    const store = new ResilientStateStore(primary.store, () => {});

    await store.getBooking('ilya', DATE, TIME);
    primary.repair();
    primary.calls.length = 0;

    await store.saveBooking(booking);
    await store.listBookings('ilya');
    expect(primary.calls).toEqual([]);
  });

  it('onDegrade зовётся один раз, а не на каждом обращении', async () => {
    const primary = primaryStub(true);
    const degraded: string[] = [];
    const store = new ResilientStateStore(primary.store, (r) => degraded.push(r));

    await store.getBooking('ilya', DATE, TIME);
    await store.saveBooking(booking);
    await store.listBookings();
    expect(degraded).toHaveLength(1);
  });
});

describe('book-slot-drop: ровно одно сообщение за ран', () => {
  it('успех: одно сообщение, token вырезан из output (он в state)', async () => {
    useSupabaseEnv();
    supabaseAlive();

    const report = await run(payload());

    expect(sendTelegramMock).toHaveBeenCalledTimes(1);
    expect(sentText()).toContain('✅');
    expect(sentText()).not.toContain(TOKEN);
    expect(report.token).not.toBe(TOKEN);
    expect(report.token).toContain('скрыт');
  });

  it('неудача дропа: тоже ровно одно сообщение', async () => {
    useSupabaseEnv();
    supabaseAlive();
    bookSlotDropMock.mockResolvedValue(
      okReport({ ok: false, token: undefined, bookingId: undefined, error: { kind: 'SlotTaken' } }),
    );

    const report = await run(payload());

    expect(report.ok).toBe(false);
    expect(sendTelegramMock).toHaveBeenCalledTimes(1);
    expect(sentText()).toContain('❌');
  });

  it('крах рана: одно ❌-сообщение и проброшенная ошибка', async () => {
    bookSlotDropMock.mockRejectedValue(new Error('движок взорвался'));

    await expect(run(payload())).rejects.toThrow('движок взорвался');

    expect(sendTelegramMock).toHaveBeenCalledTimes(1);
    expect(sentText()).toContain('Дроп сорвался');
  });

  it('Telegram ответил отказом: три попытки, но ран не падает', async () => {
    vi.useFakeTimers();
    sendTelegramMock.mockResolvedValue(false);

    const p = run(payload());
    await vi.advanceTimersByTimeAsync(10_000);
    const report = await p;

    expect(report.ok).toBe(true);
    expect(sendTelegramMock).toHaveBeenCalledTimes(3);
  });

  it('sendTelegram кинул исключение — ран всё равно возвращает отчёт', async () => {
    vi.useFakeTimers();
    sendTelegramMock.mockRejectedValue(new Error('telegram interceptor'));

    const p = run(payload());
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(p).resolves.toMatchObject({ ok: true });
  });

  it('глобального TELEGRAM_CHAT_ID нет, но у профиля свой — сообщение всё равно уходит', async () => {
    // Мультипрофиль: у каждого свой чат, общий chat_id может не задаваться вовсе.
    delete process.env.TELEGRAM_CHAT_ID;
    process.env.PROFILE_ILYA_TELEGRAM_CHAT_ID = '424242';

    await run(payload());

    expect(sendTelegramMock).toHaveBeenCalledTimes(1);
    expect(sendTelegramMock.mock.calls[0]![0]).toEqual({ botToken: BOT_TOKEN, chatId: '424242' });
  });
});

describe('book-slot-drop: state деградировал', () => {
  beforeEach(() => {
    useSupabaseEnv();
    supabaseDown();
  });

  it('бронь удалась, а state упал — token остаётся в output рана', async () => {
    // Иначе единственный ключ к брони теряется совсем: строки в Supabase нет,
    // память умрёт вместе с раном, в Telegram token не уходит по построению.
    const report = await run(payload());

    expect(report.ok).toBe(true);
    expect(report.token).toBe(TOKEN);
  });

  it('в сообщении есть предупреждение о state и подсказка про token — но не сам token', async () => {
    await run(payload());

    const text = sentText();
    expect(text).toContain('⚠️');
    expect(text).toContain('Supabase-state недоступен');
    expect(text).toContain('письма-подтверждения');
    expect(text).not.toContain(TOKEN);
  });

  it('дроп не удался — token по-прежнему вырезается из output', async () => {
    bookSlotDropMock.mockResolvedValue(
      okReport({ ok: false, error: { kind: 'AlreadyBooked', detail: 'бронь уже сохранена' } }),
    );

    const report = await run(payload());
    expect(report.token).not.toBe(TOKEN);
  });

  it('Supabase недоступен — ран не падает и сообщение уходит', async () => {
    const report = await run(payload());

    expect(report.ok).toBe(true);
    expect(sendTelegramMock).toHaveBeenCalledTimes(1);
  });
});

describe('book-slot-drop: контакт профиля не утекает', () => {
  it('email из текста ошибки не попадает ни в Telegram, ни в проброшенную ошибку', async () => {
    bookSlotDropMock.mockRejectedValue(new Error(`Reservio отклонил заявку для ${EMAIL}`));

    const err = await run(payload()).catch((e: unknown) => e);

    expect((err as Error).message).not.toContain(EMAIL);
    expect((err as Error).message).toContain('CLIENT_EMAIL');
    expect(sentText()).not.toContain(EMAIL);
  });

  it('email в detail отчёта вырезается перед отправкой', async () => {
    bookSlotDropMock.mockResolvedValue(
      okReport({ ok: false, token: undefined, error: { kind: 'SlotTaken', detail: `409 duplicate for ${EMAIL}` } }),
    );

    await run(payload());
    expect(sentText()).not.toContain(EMAIL);
    // проверка не вакуумная: строка с деталями в сообщении есть, вырезано именно значение
    expect(sentText()).toContain('409 duplicate for [CLIENT_EMAIL]');
  });

  it('заглушка редактирования не ломает HTML-разметку сообщения', async () => {
    // Текст уходит с parse_mode=HTML уже экранированным: «тег» вида
    // <CLIENT_EMAIL> Telegram отверг бы целиком (HTTP 400) — и вечер прошёл бы
    // молча, хотя отчёт был.
    bookSlotDropMock.mockResolvedValue(
      okReport({ ok: false, token: undefined, error: { kind: 'SlotTaken', detail: `отказ для ${EMAIL}` } }),
    );

    await run(payload());
    const body = sentText().replace(/<\/?b>|<\/?code>/g, '');
    expect(body).not.toContain('<');
    expect(body).not.toContain('>');
  });
});
