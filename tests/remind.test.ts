// Тесты напоминания за 2 часа (src/trigger/remind.ts).
//
// Ключевой инвариант: напоминание НЕ доверяет своему payload. Между
// планированием и срабатыванием проходят часы — если бронь отменили, человек
// не должен получить приглашение на корт.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StoredBooking } from '../src/core/state.js';
import { MemoryStateStore } from '../src/core/state.js';

// Публичный тип Task из SDK не отдаёт run-функцию, а воркер ради этих тестов
// поднимать незачем (тот же приём, что в tests/book-drop.test.ts).
const triggerMock = vi.fn<(...args: unknown[]) => Promise<unknown>>();
vi.mock('@trigger.dev/sdk', () => ({
  task: (config: unknown) => config,
  tasks: { trigger: (...args: unknown[]) => triggerMock(...args) },
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), log: vi.fn() },
}));

const {
  remindAt,
  remindText,
  runReminder,
  scheduleReminder,
  reminderScheduler,
  remindTask,
  REMIND_LEAD_MS,
} = await import('../src/trigger/remind.js');

interface RemindTaskResult {
  outcome: string;
  profileId: string;
}
const runTask = (remindTask as unknown as { run: (p: unknown) => Promise<RemindTaskResult> }).run;

const DATE = '2026-08-06';
const TIME = '20:00';
const COURT = 'Padel Court 3';
const CHAT = '424242';

const booking = (patch: Partial<StoredBooking> = {}): StoredBooking => ({
  profileId: 'ilya',
  date: DATE,
  time: TIME,
  court: COURT,
  bookingId: 'bk-1',
  token: 'guest-token-1',
  state: 'confirmed',
  createdAt: '2026-07-30T20:58:51.000+04:00',
  ...patch,
});

// chatId в payload НЕТ намеренно: адресат читается из profiles в момент
// отправки (иначе он оседает в дашборде trigger.dev и переживает отзыв доступа).
const payload = { profileId: 'ilya', date: DATE, time: TIME, court: COURT, bookingId: 'bk-1' };

function sender(): { send: (text: string) => Promise<boolean>; texts: string[]; ok: { value: boolean } } {
  const texts: string[] = [];
  const ok = { value: true };
  return {
    texts,
    ok,
    send: async (text: string): Promise<boolean> => {
      texts.push(text);
      return ok.value;
    },
  };
}

beforeEach(() => {
  triggerMock.mockReset();
  triggerMock.mockResolvedValue({ id: 'run_1' });
});

describe('remindAt / remindText', () => {
  it('напоминание ровно за 2 часа до начала слота (в зоне клуба)', () => {
    expect(remindAt(DATE, TIME).toISOString()).toBe('2026-08-06T14:00:00.000Z'); // 18:00 +04:00
    expect(new Date('2026-08-06T20:00:00+04:00').getTime() - remindAt(DATE, TIME).getTime()).toBe(REMIND_LEAD_MS);
  });

  it('в тексте корт и границы слота (59 минут)', () => {
    const text = remindText({ date: DATE, time: TIME, court: COURT });
    expect(text).toContain('Через 2 часа');
    expect(text).toContain(COURT);
    expect(text).toContain('20:00—20:59');
    expect(text).toContain(DATE);
  });
});

describe('runReminder: перечитывает state', () => {
  it('бронь активна — шлём', async () => {
    const state = new MemoryStateStore();
    await state.saveBooking(booking());
    const s = sender();

    await expect(runReminder(payload, { state, send: s.send })).resolves.toBe('sent');
    expect(s.texts).toHaveLength(1);
    expect(s.texts[0]).toContain(COURT);
  });

  it('бронь отменена — молчим', async () => {
    const state = new MemoryStateStore();
    await state.saveBooking(booking({ state: 'canceled' }));
    const s = sender();

    await expect(runReminder(payload, { state, send: s.send })).resolves.toBe('skipped-canceled');
    expect(s.texts).toHaveLength(0);
  });

  it('брони нет в state — молчим', async () => {
    const s = sender();

    await expect(runReminder(payload, { state: new MemoryStateStore(), send: s.send })).resolves.toBe(
      'skipped-missing',
    );
    expect(s.texts).toHaveLength(0);
  });

  it('state не настроен — не шлём вслепую', async () => {
    const s = sender();

    await expect(runReminder(payload, { state: null, send: s.send })).resolves.toBe('skipped-no-state');
    expect(s.texts).toHaveLength(0);
  });

  it('корт берём из state, а не из устаревшего payload', async () => {
    const state = new MemoryStateStore();
    await state.saveBooking(booking({ court: 'Padel Court 2' }));
    const s = sender();

    await runReminder({ ...payload, court: 'Padel Court 3' }, { state, send: s.send });
    expect(s.texts[0]).toContain('Padel Court 2');
  });

  it('Telegram не принял — сообщаем об этом наружу (будет ретрай)', async () => {
    const state = new MemoryStateStore();
    await state.saveBooking(booking());
    const s = sender();
    s.ok.value = false;

    await expect(runReminder(payload, { state, send: s.send })).resolves.toBe('not-delivered');
  });

  it('адресата нет — не падаем', async () => {
    const state = new MemoryStateStore();
    await state.saveBooking(booking());

    await expect(runReminder(payload, { state, send: null })).resolves.toBe('skipped-no-chat');
  });

  it('на слоте другая бронь (отменил и перебронировал) — этот ран молчит', async () => {
    // Ключ state — (profileId, date, time), поэтому перебронь того же слота
    // перезаписывает строку. Ранов при этом два (remind-bk-1 и remind-bk-2), а
    // напоминание должно прийти ровно одно.
    const state = new MemoryStateStore();
    await state.saveBooking(booking({ bookingId: 'bk-2', court: 'Padel Court 2' }));
    const s = sender();

    await expect(runReminder(payload, { state, send: s.send })).resolves.toBe('skipped-stale');
    expect(s.texts).toHaveLength(0);

    // а «свой» ран новой брони — отправляет
    await expect(runReminder({ ...payload, bookingId: 'bk-2' }, { state, send: s.send })).resolves.toBe('sent');
    expect(s.texts).toHaveLength(1);
  });

  it('ошибка чтения state пробрасывается: ран должен упасть и ретрайнуться', async () => {
    const state = new MemoryStateStore();
    vi.spyOn(state, 'getBooking').mockRejectedValue(new Error('PostgREST 500'));

    await expect(runReminder(payload, { state, send: sender().send })).rejects.toThrow('PostgREST 500');
    vi.restoreAllMocks();
  });
});

describe('remindTask.run', () => {
  it('без SUPABASE_* напоминание не уходит (проверить бронь нечем)', async () => {
    const saved = { url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY };
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    try {
      const result = await runTask(payload);
      expect(result.outcome).toBe('skipped-no-state');
      // chat_id в output рана не попадает: дашборд виден всем, у кого есть доступ
      expect(JSON.stringify(result)).not.toContain(CHAT);
    } finally {
      if (saved.url !== undefined) process.env.SUPABASE_URL = saved.url;
      if (saved.key !== undefined) process.env.SUPABASE_SERVICE_ROLE_KEY = saved.key;
    }
  });
});

describe('scheduleReminder', () => {
  const now = (): Date => new Date('2026-07-30T21:00:00+04:00');

  it('ставит отложенный ран на «старт минус 2 часа» с idempotencyKey по броням', async () => {
    await expect(scheduleReminder(booking(), CHAT, { now })).resolves.toBe('scheduled');

    expect(triggerMock).toHaveBeenCalledTimes(1);
    const [id, sent, options] = triggerMock.mock.calls[0] as [string, Record<string, string>, { delay: Date; idempotencyKey: string }];
    expect(id).toBe('remind');
    // bookingId в payload есть (по нему ран сверяется со state), chat_id — нет:
    // payload видно в дашборде trigger.dev, а адресат берётся из profiles.
    expect(sent).toEqual({ profileId: 'ilya', date: DATE, time: TIME, court: COURT, bookingId: 'bk-1' });
    expect(JSON.stringify(sent)).not.toContain(CHAT);
    expect(options.delay.toISOString()).toBe(remindAt(DATE, TIME).toISOString());
    // повторный вызов (ретрай, второй терминал) не создаст второго напоминания
    expect(options.idempotencyKey).toBe('remind-bk-1');
  });

  it('до слота меньше двух часов — не планируем: «через 2 часа» было бы неправдой', async () => {
    const late = (): Date => new Date('2026-08-06T19:30:00+04:00');

    await expect(scheduleReminder(booking(), CHAT, { now: late })).resolves.toBe('skipped-past');
    expect(triggerMock).not.toHaveBeenCalled();
  });

  it('у профиля нет чата — планировать нечего', async () => {
    await expect(scheduleReminder(booking(), '  ', { now })).resolves.toBe('skipped-no-chat');
    expect(triggerMock).not.toHaveBeenCalled();
  });

  it('отказ trigger.dev пробрасывается наружу (глотает его вызывающий)', async () => {
    triggerMock.mockRejectedValue(new Error('trigger.dev 503'));

    await expect(scheduleReminder(booking(), CHAT, { now })).rejects.toThrow('trigger.dev 503');
  });

  it('reminderScheduler даёт подпись для bookNow', async () => {
    await reminderScheduler(CHAT, { now })(booking());

    expect(triggerMock).toHaveBeenCalledTimes(1);
  });
});
