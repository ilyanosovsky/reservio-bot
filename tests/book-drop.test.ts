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

// Своя логика планирования (окно «минус 2 часа», idempotencyKey, отсутствие
// чата) проверяется в tests/remind.test.ts. Здесь важно другое: ЗОВЁТ ли дроп
// планировщик, с чем именно, и переживает ли его отказ.
const scheduleReminderMock = vi.fn<(...args: unknown[]) => Promise<string>>();
vi.mock('../src/trigger/remind.js', () => ({
  scheduleReminder: (...args: unknown[]) => scheduleReminderMock(...args),
}));

interface Payload {
  profileId: string;
  date: string;
  time: string;
  live: boolean;
  force?: boolean;
  courts?: string[];
  mode?: 'priority' | 'all';
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
    results: [{ court: 'Padel Court 3', ok: true, bookingId: 'booking-1', msFromSeenToBooked: 900 }],
    timeline: [],
    ...patch,
  };
}

/** Отчёт вечерней вахты (mode 'all'): две брони и один непоявившийся корт. */
function multiCourtReport(patch: Partial<DropReport> = {}): DropReport {
  return okReport({
    court: 'Padel Court 3',
    bookingId: 'booking-c3',
    msFromSeenToBooked: 743,
    results: [
      { court: 'Padel Court 3', ok: true, bookingId: 'booking-c3', msFromSeenToBooked: 743 },
      { court: 'Padel Court 4', ok: true, bookingId: 'booking-c4', msFromSeenToBooked: 1200 },
      { court: 'Padel Court 1', ok: false, error: 'слот не появился до дедлайна' },
    ],
    ...patch,
  });
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

type FetchMock = ReturnType<typeof vi.fn<(input: unknown, init?: unknown) => Promise<Response>>>;

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

/**
 * PostgREST, отвечающий по-разному на разные таблицы: скип и брони — это два
 * отдельных запроса, и тестам нужно разводить их ответы. Возвращает мок, чтобы
 * можно было проверить сам URL (например, под каким profile_id ищется скип).
 */
function supabaseRouted(
  handlers: { skips?: () => Response; profiles?: () => Response; rules?: () => Response } = {},
): FetchMock {
  const fetchMock = vi.fn<(input: unknown, init?: unknown) => Promise<Response>>(async (input: unknown) => {
    const url = String(input);
    if (url.includes('/rest/v1/skips')) return (handlers.skips ?? ((): Response => jsonResponse([])))();
    if (url.includes('/rest/v1/profiles')) return (handlers.profiles ?? ((): Response => jsonResponse([])))();
    if (url.includes('/rest/v1/schedule_rules')) return (handlers.rules ?? ((): Response => jsonResponse([])))();
    return jsonResponse([]);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** Строка profiles так, как её вернул бы PostgREST (ProfilesRepo.getById). */
function profileRow(patch: Record<string, unknown> = {}): Response {
  return jsonResponse([
    {
      id: 'anna',
      label: 'Аня',
      name: 'Anna Ivanova',
      email: 'anna@example.com',
      phone: '+995555123456',
      telegram_chat_id: '5550001',
      is_admin: false,
      ...patch,
    },
  ]);
}

/** Строка schedule_rules так, как её вернул бы PostgREST (SchedulesRepo.listByProfile). */
function ruleRow(patch: Record<string, unknown> = {}): Response {
  return jsonResponse([
    {
      id: 'rule-1',
      profile_id: 'anna',
      times: [TIME],
      courts: ['Padel Court 1', 'Padel Court 4'],
      days_of_week: null,
      enabled: true,
      ...patch,
    },
  ]);
}

/** Строка скипа так, как её вернул бы PostgREST (SkipsRepo.isSkipped select=date). */
function skipRow(date: string): Response {
  return jsonResponse([{ date }]);
}

/** URL всех запросов к таблице скипов — для проверок «под каким id искали». */
function skipUrls(fetchMock: FetchMock): string[] {
  return fetchMock.mock.calls.map((c) => String(c[0])).filter((u) => u.includes('/rest/v1/skips'));
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
  scheduleReminderMock.mockReset();
  scheduleReminderMock.mockResolvedValue('scheduled');
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
      listBookingsForSlot: async () => {
        guard('listBookingsForSlot');
        return [];
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
    await expect(store.getBooking('ilya', DATE, TIME, booking.court)).resolves.toBeNull();

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

    await expect(store.getBooking('ilya', DATE, TIME, booking.court)).resolves.toBeNull();
    expect(store.warning).toContain('Supabase-state недоступен');
    expect(store.warning).toContain('getBooking');
    expect(degraded).toHaveLength(1);

    // дальше это обычное in-memory хранилище
    await store.saveBooking(booking);
    await expect(store.getBooking('ilya', DATE, TIME, booking.court)).resolves.toMatchObject({ bookingId: 'booking-1' });
  });

  it('деградация необратима: починившийся primary больше не дёргаем', async () => {
    // «То в базу, то мимо» — худший вариант: идемпотентность стала бы
    // непредсказуемой прямо в середине дропа.
    const primary = primaryStub(true);
    const store = new ResilientStateStore(primary.store, () => {});

    await store.getBooking('ilya', DATE, TIME, booking.court);
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

    await store.getBooking('ilya', DATE, TIME, booking.court);
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

describe('book-slot-drop: скип на этот день', () => {
  beforeEach(() => {
    useSupabaseEnv();
  });

  it('скип стоит — брони нет, но сообщение всё равно одно', async () => {
    // Осознанный пропуск — не молчаливый провал: инвариант «ровно одно
    // сообщение за ран» действует и здесь.
    supabaseRouted({ skips: () => skipRow(DATE) });

    const report = await run(payload());

    expect(bookSlotDropMock).not.toHaveBeenCalled();
    expect(report.ok).toBe(false);
    expect(report.error).toBeUndefined(); // скип — не ошибка дропа
    expect(sendTelegramMock).toHaveBeenCalledTimes(1);
    expect(sentText()).toContain('Пропущено по команде');
    expect(sentText()).not.toContain('❌');
  });

  it('скип проверяется ДО ожидания окна и до всякой брони', async () => {
    supabaseRouted({ skips: () => skipRow(DATE) });

    const report = await run(payload());

    expect(report.timeline.map((e) => e.event).join(' ')).toContain('пропущено по команде');
  });

  it('скип живёт под настоящим id профиля — DRY-суффикс к нему не приклеивается', async () => {
    // «Сегодня не играем» одинаково верно для LIVE и для репетиции, иначе
    // DRY-прогон проигнорировал бы скип и разбудил человека отчётом о брони.
    const fetchMock = supabaseRouted({ skips: () => skipRow(DATE) });

    await run(payload({ live: false }));

    const urls = skipUrls(fetchMock);
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain('profile_id=eq.ilya');
    expect(urls[0]).not.toContain('dry'); // ни 'ilya:dry', ни '%3Adry'
    expect(bookSlotDropMock).not.toHaveBeenCalled();
  });

  it('скипа нет — дроп идёт как обычно', async () => {
    supabaseRouted();

    const report = await run(payload());

    expect(bookSlotDropMock).toHaveBeenCalledTimes(1);
    expect(report.ok).toBe(true);
  });

  it('проверка скипа сорвалась — дроп НЕ отменяем, но предупреждаем', async () => {
    // Пропущенный корт не вернуть, поэтому сеть важнее скипа. Молчать при этом
    // нельзя: скип мог быть, и тогда бронь окажется лишней.
    supabaseRouted({
      skips: () => {
        throw new Error('PostgREST 500');
      },
    });

    const report = await run(payload());

    expect(bookSlotDropMock).toHaveBeenCalledTimes(1);
    expect(report.ok).toBe(true);
    expect(sendTelegramMock).toHaveBeenCalledTimes(1);
    expect(sentText()).toContain('скип не проверен');
  });

  it('без SUPABASE_* скипы не проверяются, но дроп идёт', async () => {
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;

    const report = await run(payload());

    expect(report.ok).toBe(true);
    expect(sendTelegramMock).toHaveBeenCalledTimes(1);
  });

  it('скип, поставленный ПОСЛЕ старта рана, всё равно отменяет бронь', async () => {
    // Ран стартует за ~2 минуты до окна, и всё это время у человека на экране
    // живая кнопка «⏭ Пропустить». Одной проверки на старте мало: бот ответил
    // бы «бронировать не будем», а движок в 20:58:51 всё равно сделал бы POST.
    vi.useFakeTimers();
    // окно слота 20:00 дня T=2026-08-07 открывается в 20:58:30 +04:00
    vi.setSystemTime(new Date('2026-08-07T16:57:00.000Z'));
    const FUTURE = '2026-08-14'; // dropDayOf → 2026-08-07
    let checks = 0;
    const fetchMock = supabaseRouted({
      skips: () => {
        checks += 1;
        return checks === 1 ? jsonResponse([]) : skipRow(FUTURE);
      },
    });

    const p = run(payload({ date: FUTURE }));
    await vi.advanceTimersByTimeAsync(120_000);
    const report = await p;

    expect(skipUrls(fetchMock)).toHaveLength(2);
    expect(bookSlotDropMock).not.toHaveBeenCalled();
    expect(report.timeline.map((e) => e.event).join(' ')).toContain('перед окном');
    expect(sendTelegramMock).toHaveBeenCalledTimes(1);
    expect(sentText()).toContain('Пропущено по команде');
  });

  it('скипа не появилось — после повторной проверки дроп идёт как обычно', async () => {
    // Проверка «не вакуумная»: второй запрос сам по себе бронь не отменяет.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-07T16:57:00.000Z'));
    const FUTURE = '2026-08-14';
    const fetchMock = supabaseRouted();

    const p = run(payload({ date: FUTURE }));
    await vi.advanceTimersByTimeAsync(120_000);
    const report = await p;

    expect(skipUrls(fetchMock)).toHaveLength(2);
    expect(bookSlotDropMock).toHaveBeenCalledTimes(1);
    expect(report.ok).toBe(true);
  });
});

describe('book-slot-drop: профиль из Supabase, а не из ENV', () => {
  beforeEach(() => {
    useSupabaseEnv();
  });

  it('профиль, заведённый через /add_profile, бронируется и получает отчёт в СВОЙ чат', async () => {
    // Планировщик берёт правила из Supabase; если бы дроп резолвил профиль
    // только из ENV, такой профиль не бронировался бы вовсе, а сообщение о
    // провале ушло бы владельцу (глобальный TELEGRAM_CHAT_ID).
    supabaseRouted({ profiles: () => profileRow(), rules: () => ruleRow() });

    const report = await run(payload({ profileId: 'anna' }));

    expect(report.ok).toBe(true);
    const engineProfile = bookSlotDropMock.mock.calls[0]![0] as {
      id: string;
      contact: { email: string };
      rule: { courts: string[] };
    };
    expect(engineProfile.id).toBe('anna');
    expect(engineProfile.contact.email).toBe('anna@example.com');
    // корты — из правила профиля в Supabase, а не из ENV-профиля владельца
    expect(engineProfile.rule.courts).toEqual(['Padel Court 1', 'Padel Court 4']);
    expect(sendTelegramMock).toHaveBeenCalledTimes(1);
    expect(sendTelegramMock.mock.calls[0]![0]).toEqual({ botToken: BOT_TOKEN, chatId: '5550001' });
  });

  it('чат профиля из Supabase перебивает глобальный TELEGRAM_CHAT_ID и для напоминания', async () => {
    supabaseRouted({ profiles: () => profileRow(), rules: () => ruleRow() });

    await run(payload({ profileId: 'anna' }));

    expect(scheduleReminderMock).toHaveBeenCalledTimes(1);
    expect(scheduleReminderMock.mock.calls[0]![1]).toBe('5550001');
  });

  it('профиля нет ни в Supabase, ни в ENV — громкий отчёт, а не молчание', async () => {
    supabaseRouted();

    await expect(run(payload({ profileId: 'anna' }))).rejects.toThrow(/не найден/);

    expect(bookSlotDropMock).not.toHaveBeenCalled();
    expect(sendTelegramMock).toHaveBeenCalledTimes(1);
    expect(sentText()).toContain('Дроп сорвался');
  });
});

describe('book-slot-drop: набор кортов и режим', () => {
  /** Цель дропа, с которой позвали движок. */
  function engineTarget(): { date: string; time: string; courts: string[]; mode: string } {
    expect(bookSlotDropMock).toHaveBeenCalled();
    return bookSlotDropMock.mock.calls[0]![1] as { date: string; time: string; courts: string[]; mode: string };
  }

  beforeEach(() => {
    useSupabaseEnv();
  });

  it('courts и mode из payload уходят в движок как есть', async () => {
    supabaseRouted();

    await run(payload({ courts: ['Padel Court 4', 'Padel Court 1'], mode: 'all' }));

    expect(engineTarget()).toMatchObject({
      date: DATE,
      time: TIME,
      courts: ['Padel Court 4', 'Padel Court 1'],
      mode: 'all',
    });
  });

  it('без payload набор и режим берутся из правила профиля', async () => {
    supabaseRouted({ profiles: () => profileRow(), rules: () => ruleRow({ mode: 'all' }) });

    await run(payload({ profileId: 'anna' }));

    expect(engineTarget()).toMatchObject({ courts: ['Padel Court 1', 'Padel Court 4'], mode: 'all' });
  });

  it('старое правило без mode работает как priority (обратная совместимость)', async () => {
    supabaseRouted({ profiles: () => profileRow(), rules: () => ruleRow() });

    await run(payload({ profileId: 'anna' }));

    expect(engineTarget().mode).toBe('priority');
  });

  it('мусор в колонке mode не включает вахту по всем кортам', async () => {
    // Иначе кривая строка в БД молча начала бы бронировать по три корта за вечер.
    supabaseRouted({ profiles: () => profileRow(), rules: () => ruleRow({ mode: 'ALL!!' }) });

    await run(payload({ profileId: 'anna' }));

    expect(engineTarget().mode).toBe('priority');
  });

  it('mode из payload перебивает правило профиля', async () => {
    supabaseRouted({ profiles: () => profileRow(), rules: () => ruleRow({ mode: 'all' }) });

    await run(payload({ profileId: 'anna', mode: 'priority' }));

    expect(engineTarget().mode).toBe('priority');
  });

  it('пустой courts в payload игнорируется — работаем по правилу', async () => {
    supabaseRouted({ profiles: () => profileRow(), rules: () => ruleRow() });

    await run(payload({ profileId: 'anna', courts: [] }));

    expect(engineTarget().courts).toEqual(['Padel Court 1', 'Padel Court 4']);
  });

  it('courts в payload спасают профиль без правила в БД', async () => {
    // Ручной ран «поймай мне вот эти корты» не должен зависеть от того, что
    // записано в сценариях профиля.
    supabaseRouted({ profiles: () => profileRow(), rules: () => jsonResponse([]) });

    const report = await run(payload({ profileId: 'anna', courts: ['Padel Court 4'], mode: 'all' }));

    expect(report.ok).toBe(true);
    expect(engineTarget().courts).toEqual(['Padel Court 4']);
  });
});

describe('book-slot-drop: сводка по кортам и напоминания вахты', () => {
  beforeEach(() => {
    useSupabaseEnv();
    supabaseRouted();
    bookSlotDropMock.mockResolvedValue(multiCourtReport());
  });

  it('в единственном сообщении есть построчная сводка по всему набору', async () => {
    await run(payload({ mode: 'all' }));

    const text = sentText();
    expect(sendTelegramMock).toHaveBeenCalledTimes(1);
    expect(text).toContain('Корты:');
    expect(text).toContain('Padel Court 3 (743 мс)');
    expect(text).toContain('Padel Court 4 (1.2 с)');
    expect(text).toContain('Padel Court 1 — слот не появился до дедлайна');
  });

  it('сводки нет, когда корт в наборе один: строка «Корт: …» уже всё сказала', async () => {
    bookSlotDropMock.mockResolvedValue(okReport());

    await run(payload());

    expect(sentText()).not.toContain('Корты:');
  });

  it('предупреждение о state остаётся последней строкой сообщения', async () => {
    // Предупреждения читают последними и по ним принимают решения — сводка
    // не имеет права их оттеснить.
    supabaseDown();

    await run(payload({ mode: 'all' }));

    const lines = sentText().split('\n');
    expect(lines[lines.length - 1]!.startsWith('⚠️')).toBe(true);
    expect(lines.some((l) => l.startsWith('Корты:'))).toBe(true);
  });

  it('неоднозначный POST по одному корту виден в сообщении, даже когда ран зелёный', async () => {
    // Регрессия: в режиме 'all' успех на соседнем корте делает отчёт ✅ и
    // оставляет корневой error пустым, а строка корта в сводке режется по 120
    // символов — без отдельного ⚠️ владелец не узнал бы, что где-то могла
    // остаться фантомная бронь, и не отменил бы её до дедлайна.
    bookSlotDropMock.mockResolvedValue(
      multiCourtReport({
        results: [
          {
            court: 'Padel Court 3',
            ok: false,
            ambiguous: true,
            error:
              'POST Padel Court 3 завершился неоднозначно (createBooking: запрос не выполнен — fetch failed ' +
              'code=networkError): бронь могла быть создана на сервере, id/token потеряны — проверь почту профиля',
          },
          { court: 'Padel Court 4', ok: true, bookingId: 'booking-c4', msFromSeenToBooked: 1200 },
        ],
      }),
    );

    const report = await run(payload({ mode: 'all' }));

    expect(report.ok).toBe(true);
    const text = sentText();
    expect(sendTelegramMock).toHaveBeenCalledTimes(1);
    expect(text).toContain('⚠️');
    expect(text).toContain('Padel Court 3');
    expect(text).toContain('МОГЛА быть создана');
    expect(text).toContain('проверь почту профиля и клуб вручную');
  });

  it('без неоднозначных отказов лишнего предупреждения нет', async () => {
    await run(payload({ mode: 'all' }));

    expect(sentText()).not.toContain('МОГЛА быть создана');
  });

  it('напоминание ставится по КАЖДОЙ успешной брони вечера', async () => {
    await run(payload({ mode: 'all' }));

    expect(scheduleReminderMock).toHaveBeenCalledTimes(2);
    const booked = scheduleReminderMock.mock.calls.map((c) => c[0] as { court: string; bookingId: string });
    expect(booked.map((b) => b.court)).toEqual(['Padel Court 3', 'Padel Court 4']);
    expect(booked.map((b) => b.bookingId)).toEqual(['booking-c3', 'booking-c4']);
    // token напоминанию не нужен — и не должен путешествовать лишний раз
    expect(JSON.stringify(booked)).not.toContain(TOKEN);
  });

  it('упавшее напоминание по одной брони не отменяет напоминание по второй', async () => {
    scheduleReminderMock.mockRejectedValueOnce(new Error('trigger.dev 503'));

    const report = await run(payload({ mode: 'all' }));

    expect(scheduleReminderMock).toHaveBeenCalledTimes(2);
    expect(report.ok).toBe(true);
    expect(sendTelegramMock).toHaveBeenCalledTimes(1);
  });

  it('DRY — напоминаний нет ни по одной брони вахты', async () => {
    await run(payload({ live: false, mode: 'all' }));

    expect(scheduleReminderMock).not.toHaveBeenCalled();
  });
});

describe('book-slot-drop: напоминание за 2 часа', () => {
  beforeEach(() => {
    useSupabaseEnv();
    supabaseRouted();
  });

  it('LIVE-успех — напоминание планируется на бронь и чат профиля', async () => {
    await run(payload());

    expect(scheduleReminderMock).toHaveBeenCalledTimes(1);
    const [booking, chatId] = scheduleReminderMock.mock.calls[0] as [Record<string, string>, string];
    expect(booking).toMatchObject({
      profileId: 'ilya',
      date: DATE,
      time: TIME,
      court: 'Padel Court 3',
      bookingId: 'booking-1',
    });
    expect(chatId).toBe('-100500');
    // token напоминанию не нужен — и не должен путешествовать лишний раз
    expect(JSON.stringify(booking)).not.toContain(TOKEN);
  });

  it('корт берётся из отчёта: напоминание про fallback-корт, а не про желаемый', async () => {
    bookSlotDropMock.mockResolvedValue(
      okReport({
        court: 'Padel Court 2',
        results: [{ court: 'Padel Court 2', ok: true, bookingId: 'booking-1', msFromSeenToBooked: 900 }],
      }),
    );

    await run(payload());

    expect(scheduleReminderMock.mock.calls[0]![0]).toMatchObject({ court: 'Padel Court 2' });
  });

  it('DRY — напоминания нет: бронь синтетическая', async () => {
    await run(payload({ live: false }));

    expect(scheduleReminderMock).not.toHaveBeenCalled();
  });

  it('дроп не удался — напоминать не о чем', async () => {
    bookSlotDropMock.mockResolvedValue(
      okReport({ ok: false, token: undefined, bookingId: undefined, error: { kind: 'SlotTaken' } }),
    );

    await run(payload());

    expect(scheduleReminderMock).not.toHaveBeenCalled();
  });

  it('успех без bookingId — напоминание не ставим (нечем дедуплицировать)', async () => {
    bookSlotDropMock.mockResolvedValue(
      okReport({ bookingId: undefined, results: [{ court: 'Padel Court 3', ok: true }] }),
    );

    await run(payload());

    expect(scheduleReminderMock).not.toHaveBeenCalled();
  });

  it('планировщик упал — бронь и отчёт этим не портятся', async () => {
    scheduleReminderMock.mockRejectedValue(new Error('trigger.dev 503'));

    const report = await run(payload());

    expect(report.ok).toBe(true);
    expect(sendTelegramMock).toHaveBeenCalledTimes(1);
    expect(sentText()).toContain('✅');
  });

  it('сначала отчёт, потом напоминание', async () => {
    // Отчёт — инвариант вечера, напоминание бонус: он не имеет права
    // задерживать единственное сообщение или отнимать у него бюджет рана.
    const order: string[] = [];
    sendTelegramMock.mockImplementation(async () => {
      order.push('telegram');
      return true;
    });
    scheduleReminderMock.mockImplementation(async () => {
      order.push('remind');
      return 'scheduled';
    });

    await run(payload());

    expect(order).toEqual(['telegram', 'remind']);
  });
});
