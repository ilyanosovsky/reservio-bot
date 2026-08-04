// Свободные запросы (фаза 5) — полный путь через собранного бота
// (src/bot/setup.ts → registerHandlers), стиль tests/bot-invite.test.ts:
// настоящий grammY-Composer, настоящий Context, Bot API подменена
// трансформером (любой исходящий вызов записывается и никуда не летит).
//
// Что здесь защищается, кроме счастливого пути:
//  - чужой чат не доходит до модели ВООБЩЕ: платный API за инвариантом тишины;
//  - мастер профиля и кнопки меню приоритетнее свободного текста — иначе
//    «⏰ Расписание» уезжало бы в модель вместо того, чтобы открыть расписание;
//  - суточный лимит режет запрос ДО обращения к модели (граница 20);
//  - модель ничего не бронирует сама: любой путь заканчивается тем же экраном
//    подтверждения `bk~`, а bookNow срабатывает только после нажатия кнопки;
//  - ключ модели не попадает ни в лог, ни в чат (как telegram-токен).

import { describe, expect, it, vi } from 'vitest';
import { Api, Composer, Context, type Transformer } from 'grammy';
import type { Update, UserFromGetMe } from 'grammy/types';
import type { BotContext, BotDeps } from '../src/bot/context.js';
import { installBot } from '../src/bot/setup.js';
import { BTN } from '../src/bot/menu.js';
import { FREE_QUERY_DAILY_LIMIT, FREE_QUERY_MAX_CHARS } from '../src/bot/handlers/free-query.js';
import { PROFILE_DRAFT_TTL_MS } from '../src/bot/wizard-state.js';
import type { BookingIntent } from '../src/core/intent.js';
import type { ProfileRow } from '../src/core/repos.js';
import type { Slot } from '../src/reservio/types.js';

const OWNER_CHAT = 424242;
const STRANGER_CHAT = 777002;

/** «Сегодня» стенда: 04.08.2026 в Батуми. Горизонт — 04.08 … 11.08. */
const NOW_MS = Date.UTC(2026, 7, 4, 12, 0, 0);
const TODAY = '2026-08-04';
const GAME_DAY = '2026-08-06';
/** Индекс Padel Court 3 в BOOKABLE_COURTS — он же едет в callback_data. */
const C3 = 2;

/** Ключ, которого нет ни у кого: тест ищет его в логах и в исходящих. */
const API_KEY = 'sk-ant-api03-TESTKEY-NOT-REAL-0000';

const BOT_INFO = {
  id: 1,
  is_bot: true,
  first_name: 'padel',
  username: 'padel_test_bot',
  can_join_groups: true,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
} as unknown as UserFromGetMe;

function profileRow(patch: Partial<ProfileRow> = {}): ProfileRow {
  return {
    id: 'ilya',
    label: 'Илья',
    name: 'Ilya Test',
    email: 'ilya@example.com',
    phone: '+995555000111',
    telegramChatId: String(OWNER_CHAT),
    isAdmin: false,
    ...patch,
  };
}

function slot(date: string, time: string): Slot {
  const hh = time.slice(0, 2);
  return { start: `${date}T${time}:00+04:00`, end: `${date}T${hh}:59:00+04:00` };
}

interface ApiCall {
  method: string;
  payload: Record<string, unknown>;
}

function recordingApi(): { api: Api; calls: ApiCall[] } {
  const calls: ApiCall[] = [];
  const api = new Api('12345:TEST-TOKEN-NOT-REAL');
  const transformer = (async (_prev: unknown, method: string, payload: Record<string, unknown>) => {
    calls.push({ method, payload });
    return { ok: true, result: { message_id: calls.length } };
  }) as unknown as Transformer;
  api.config.use(transformer);
  return { api, calls };
}

interface Harness {
  calls: ApiCall[];
  logs: string[];
  settings: Map<string, string>;
  getSetting: ReturnType<typeof vi.fn>;
  setSetting: ReturnType<typeof vi.fn>;
  parseIntent: ReturnType<typeof vi.fn>;
  availability: ReturnType<typeof vi.fn>;
  bookNow: ReturnType<typeof vi.fn>;
  handle(update: Update): Promise<void>;
}

interface HarnessInit {
  profile?: ProfileRow;
  /** Что вернёт парсер. null — «не разобрал». */
  intent?: BookingIntent | null;
  /** Подменяет парсер целиком (падения, проверка аргументов). */
  intentImpl?: (...args: unknown[]) => Promise<BookingIntent | null>;
  /** Слоты по ключу `${serviceId}|${date}`; по умолчанию — пусто. */
  slots?: Record<string, Slot[]>;
  availabilityImpl?: (serviceId: string, date: string) => Promise<Slot[]>;
  settings?: Record<string, string>;
  apiKey?: string;
  /** false — свободные запросы вообще не собраны (поведение до фазы 5). */
  freeQuery?: boolean;
  /** Подвижные часы стенда: нужны сценариям с TTL черновика мастера. */
  clock?: { ms: number };
}

function harness(init: HarnessInit = {}): Harness {
  const { api, calls } = recordingApi();
  const logs: string[] = [];
  const profile = init.profile ?? profileRow();
  const settings = new Map<string, string>(Object.entries(init.settings ?? {}));
  const slots = init.slots ?? {};

  const getSetting = vi.fn(async (key: string) => settings.get(key) ?? null);
  const setSetting = vi.fn(async (key: string, value: string) => {
    settings.set(key, value);
  });
  const parseIntent = vi.fn(init.intentImpl ?? (async () => init.intent ?? null));
  const availability = vi.fn(
    init.availabilityImpl ?? (async (serviceId: string, date: string) => slots[`${serviceId}|${date}`] ?? []),
  );
  const bookNow = vi.fn(async () => ({ ok: false, reason: 'в тесте бронь не создаётся' }));

  const deps = {
    profiles: {
      getByChatId: vi.fn(async (chatId: string) => (profile.telegramChatId === chatId ? profile : null)),
      getById: vi.fn(async (id: string) => (profile.id === id ? profile : null)),
      list: vi.fn(async () => [profile]),
      upsert: vi.fn(async () => {}),
    },
    invites: { claim: vi.fn(async () => null), create: vi.fn(async () => 'code') },
    schedules: {
      listByProfile: vi.fn(async () => []),
      upsert: vi.fn(async () => {}),
      setEnabled: vi.fn(async () => {}),
      remove: vi.fn(async () => {}),
    },
    skips: { listUpcoming: vi.fn(async () => []), add: vi.fn(async () => {}), remove: vi.fn(async () => {}) },
    state: { listBookings: vi.fn(async () => []) },
    client: { getAvailability: availability },
    bookNow,
    ...(init.freeQuery === false
      ? {}
      : {
          freeQuery: {
            parseIntent,
            settings: { get: getSetting, set: setSetting },
            apiKey: init.apiKey ?? API_KEY,
          },
        }),
    now: () => new Date(init.clock?.ms ?? NOW_MS),
    log: (msg: string): void => {
      logs.push(msg);
    },
  } as unknown as BotDeps;

  const bot = new Composer<BotContext>();
  installBot(bot, deps);
  const middleware = bot.middleware();

  return {
    calls,
    logs,
    settings,
    getSetting,
    setSetting,
    parseIntent,
    availability,
    bookNow,
    handle: async (update: Update): Promise<void> => {
      const ctx = new Context(update, api, BOT_INFO) as BotContext;
      await middleware(ctx, async () => {});
    },
  };
}

let updateId = 0;

function textUpdate(text: string, chatId: number): Update {
  updateId += 1;
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 1_754_000_000,
      chat: { id: chatId, type: 'private' },
      from: { id: chatId, is_bot: false, first_name: 'Tester' },
      text,
    },
  } as unknown as Update;
}

function commandUpdate(text: string, chatId: number): Update {
  const update = textUpdate(text, chatId);
  const command = text.split(' ')[0]!;
  const message = (update as unknown as { message: Record<string, unknown> }).message;
  message['entities'] = [{ type: 'bot_command', offset: 0, length: command.length }];
  return update;
}

function callbackUpdate(data: string, chatId: number): Update {
  updateId += 1;
  return {
    update_id: updateId,
    callback_query: {
      id: `cbq-${updateId}`,
      from: { id: chatId, is_bot: false, first_name: 'Tester' },
      chat_instance: String(chatId),
      data,
      message: {
        message_id: updateId,
        date: 1_754_000_000,
        chat: { id: chatId, type: 'private' },
        from: { id: BOT_INFO.id, is_bot: true, first_name: 'padel' },
        text: 'список вариантов',
      },
    },
  } as unknown as Update;
}

const lastText = (h: Harness): string => String(h.calls.at(-1)!.payload['text'] ?? '');

function buttonsOf(call: ApiCall): { text: string; callback_data?: string }[] {
  const markup = call.payload['reply_markup'] as { inline_keyboard?: { text: string; callback_data?: string }[][] };
  return (markup?.inline_keyboard ?? []).flat();
}

/** Сообщения бота (без answerCallbackQuery и прочей служебки). */
const messages = (h: Harness): ApiCall[] => h.calls.filter((c) => c.method === 'sendMessage' || c.method === 'editMessageText');

const findIntent = (patch: Partial<BookingIntent> = {}): BookingIntent => ({
  kind: 'find',
  dateFrom: GAME_DAY,
  dateTo: GAME_DAY,
  courts: ['Padel Court 3'],
  durationHours: 1,
  ...patch,
});

/** serviceId Padel Court 3 — ключ фейковой доступности. */
const C3_SERVICE = '303f3adf-8a99-4c1f-89fe-f9a9b56a620b';

// ---------------------------------------------------------------------------
// Кто вообще доходит до модели
// ---------------------------------------------------------------------------

describe('свободный запрос: до модели доходит только свой чат', () => {
  it('чужой chat_id — полная тишина, парсер не зовётся', async () => {
    // Платный API стоит за инвариантом тишины: чужой текст не должен стоить
    // ни одного токена и не должен подтвердить, что бот жив.
    const h = harness({ intent: findIntent() });

    await h.handle(textUpdate('найди 2 часа в субботу', STRANGER_CHAT));

    expect(h.calls).toEqual([]);
    expect(h.parseIntent).not.toHaveBeenCalled();
    expect(h.getSetting).not.toHaveBeenCalled();
  });

  it('свободные запросы не собраны — бот молчит, как до фазы 5', async () => {
    const h = harness({ freeQuery: false });

    await h.handle(textUpdate('просто мысли вслух', OWNER_CHAT));

    expect(h.calls).toEqual([]);
  });

  it('кнопка меню разбирается как кнопка, а не как запрос к модели', async () => {
    const h = harness({ intent: findIntent() });

    await h.handle(textUpdate(BTN.schedule, OWNER_CHAT));

    expect(h.parseIntent).not.toHaveBeenCalled();
    expect(lastText(h)).toContain('Расписание');
  });

  it('неизвестная команда до модели не доезжает', async () => {
    const h = harness({ intent: findIntent() });

    await h.handle(commandUpdate('/чтотоневедомое', OWNER_CHAT));

    expect(h.parseIntent).not.toHaveBeenCalled();
    expect(h.calls).toEqual([]);
  });

  it('известная команда остаётся командой', async () => {
    const h = harness({ intent: findIntent() });

    await h.handle(commandUpdate('/start', OWNER_CHAT));

    expect(h.parseIntent).not.toHaveBeenCalled();
    expect(lastText(h)).toContain('Илья');
  });

  it('мастер профиля приоритетнее: его шаг съедает текст', async () => {
    // Регрессия на порядок: пока у админа висит черновик, его текст — это ответ
    // на шаг мастера, а не свободный запрос.
    const h = harness({ profile: profileRow({ isAdmin: true }), intent: findIntent() });

    await h.handle(callbackUpdate('pw~n', OWNER_CHAT));
    await h.handle(textUpdate('Аня', OWNER_CHAT));

    expect(h.parseIntent).not.toHaveBeenCalled();
    expect(lastText(h)).toContain('шаг 2/4');
  });

  it('дописанный шаг ИСТЁКШЕГО мастера в модель не уезжает', async () => {
    // Регрессия на приватность. Про истёкший черновик бот говорит ровно один
    // раз, а мастер собирает имя/email/телефон ТРЕТЬЕГО человека: вторая строка
    // админа («+995…») мастером уже не съедена и по общему правилу уехала бы в
    // Anthropic API. docs/wiki/Bot.md обещает обратное.
    const clock = { ms: NOW_MS };
    const h = harness({ profile: profileRow({ isAdmin: true }), intent: findIntent(), clock });

    await h.handle(callbackUpdate('pw~n', OWNER_CHAT));
    await h.handle(textUpdate('Аня', OWNER_CHAT));
    clock.ms += PROFILE_DRAFT_TTL_MS + 1_000; // админ отвлёкся дольше TTL

    await h.handle(textUpdate('anna@example.com', OWNER_CHAT));
    expect(lastText(h)).toContain('Черновик профиля не найден');

    await h.handle(textUpdate('+995 555 000 111', OWNER_CHAT));

    expect(h.parseIntent).not.toHaveBeenCalled();
    expect(lastText(h)).toContain('контакт');
    // И сам номер не всплыл ни в исходящих, ни в логе процесса.
    expect(JSON.stringify(h.calls)).not.toContain('555 000 111');
    expect(JSON.stringify(h.calls)).not.toContain('+995555000111');
    expect(h.logs.join('\n')).not.toContain('995');
  });

  it('одинокая почта — подсказка, а не запрос к модели, и квота цела', async () => {
    const h = harness({ intent: findIntent() });

    await h.handle(textUpdate('anna@example.com', OWNER_CHAT));

    expect(h.parseIntent).not.toHaveBeenCalled();
    expect(h.settings.get(`llm_quota:ilya:${TODAY}`)).toBeUndefined();
    expect(lastText(h)).toContain('контакт');
    expect(h.logs.join('\n')).not.toContain('anna@example.com');
  });

  it('обычный запрос про корты за контакт не принимают', async () => {
    // Граница проверки: телефонный фильтр не должен глотать живые запросы.
    const h = harness({ intent: findIntent() });

    await h.handle(textUpdate('найди 2 часа подряд в субботу после 19:00', OWNER_CHAT));

    expect(h.parseIntent).toHaveBeenCalledTimes(1);
  });

  it('слишком длинный текст в модель не отправляется', async () => {
    const h = harness({ intent: findIntent() });

    await h.handle(textUpdate('а'.repeat(FREE_QUERY_MAX_CHARS + 1), OWNER_CHAT));

    expect(h.parseIntent).not.toHaveBeenCalled();
    expect(lastText(h)).toContain('Слишком длинный');
  });
});

// ---------------------------------------------------------------------------
// Суточный лимит
// ---------------------------------------------------------------------------

describe('свободный запрос: суточный лимит', () => {
  const key = `llm_quota:ilya:${TODAY}`;

  it('первый запрос за день заводит счётчик', async () => {
    const h = harness({ intent: findIntent() });

    await h.handle(textUpdate('что там завтра', OWNER_CHAT));

    expect(h.getSetting).toHaveBeenCalledWith(key);
    expect(h.settings.get(key)).toBe('1');
    expect(h.parseIntent).toHaveBeenCalledTimes(1);
  });

  it(`граница: ${FREE_QUERY_DAILY_LIMIT - 1} потрачено — запрос проходит`, async () => {
    const h = harness({ intent: findIntent(), settings: { [key]: String(FREE_QUERY_DAILY_LIMIT - 1) } });

    await h.handle(textUpdate('что там завтра', OWNER_CHAT));

    expect(h.parseIntent).toHaveBeenCalledTimes(1);
    expect(h.settings.get(key)).toBe(String(FREE_QUERY_DAILY_LIMIT));
  });

  it(`граница: ${FREE_QUERY_DAILY_LIMIT} потрачено — вежливый отказ БЕЗ модели`, async () => {
    const h = harness({ intent: findIntent(), settings: { [key]: String(FREE_QUERY_DAILY_LIMIT) } });

    await h.handle(textUpdate('что там завтра', OWNER_CHAT));

    expect(h.parseIntent).not.toHaveBeenCalled();
    expect(h.availability).not.toHaveBeenCalled();
    expect(lastText(h)).toContain('На сегодня хватит');
    // Счётчик не растёт: отказ ничего не стоил.
    expect(h.settings.get(key)).toBe(String(FREE_QUERY_DAILY_LIMIT));
  });

  it('счётчик свой у каждого профиля и у каждой даты', async () => {
    const h = harness({
      profile: profileRow({ id: 'anna' }),
      intent: findIntent(),
      settings: { [key]: String(FREE_QUERY_DAILY_LIMIT), [`llm_quota:anna:2026-08-03`]: '99' },
    });

    await h.handle(textUpdate('что там завтра', OWNER_CHAT));

    // Чужой профиль и вчерашняя дата чужой лимит не расходуют.
    expect(h.parseIntent).toHaveBeenCalledTimes(1);
    expect(h.settings.get(`llm_quota:anna:${TODAY}`)).toBe('1');
  });

  it('мусор в счётчике читается как ноль, а не запирает профиль навсегда', async () => {
    const h = harness({ intent: findIntent(), settings: { [key]: 'сломалось' } });

    await h.handle(textUpdate('что там завтра', OWNER_CHAT));

    expect(h.parseIntent).toHaveBeenCalledTimes(1);
    expect(h.settings.get(key)).toBe('1');
  });

  it('хранилище лежит — запрос НЕ проходит (лимит без счётчика не лимит)', async () => {
    const h = harness({ intent: findIntent() });
    h.getSetting.mockRejectedValueOnce(new Error('PostgREST 500'));

    await h.handle(textUpdate('что там завтра', OWNER_CHAT));

    expect(h.parseIntent).not.toHaveBeenCalled();
    // И человек об этом узнал: молчаливый провал — худший баг проекта.
    expect(messages(h)).toHaveLength(1);
  });

  it('упавшее хранилище не выдают за поломку Reservio', async () => {
    // Свалить свою поломку на клуб — значит отправить человека чинить не то.
    const h = harness({ intent: findIntent() });
    h.getSetting.mockRejectedValueOnce(new Error('PostgREST 500'));

    await h.handle(textUpdate('что там завтра', OWNER_CHAT));

    expect(lastText(h)).toContain('проверить лимит');
    expect(lastText(h)).not.toContain('Reservio');
  });
});

// ---------------------------------------------------------------------------
// Выключенный ключ
// ---------------------------------------------------------------------------

describe('свободный запрос: ключа модели нет', () => {
  it('говорим один раз за сутки и дальше молчим', async () => {
    const h = harness({ apiKey: '' });

    await h.handle(textUpdate('найди корт в субботу', OWNER_CHAT));
    expect(lastText(h)).toContain('не настроены');
    expect(h.parseIntent).not.toHaveBeenCalled();

    h.calls.length = 0;
    await h.handle(textUpdate('ну а в воскресенье?', OWNER_CHAT));
    expect(h.calls).toEqual([]);
  });

  it('квота на этом не тратится: модель не звали', async () => {
    const h = harness({ apiKey: '' });

    await h.handle(textUpdate('найди корт в субботу', OWNER_CHAT));

    expect(h.settings.get(`llm_quota:ilya:${TODAY}`)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Разбор не удался
// ---------------------------------------------------------------------------

describe('свободный запрос: не разобрали', () => {
  it('null от парсера — подсказка с примерами, а не тишина', async () => {
    const h = harness({ intent: null });

    await h.handle(textUpdate('ыыыы', OWNER_CHAT));

    expect(lastText(h)).toContain('Не понял запрос');
    expect(lastText(h)).toContain('«');
    expect(h.availability).not.toHaveBeenCalled();
  });

  it('kind unknown — та же подсказка', async () => {
    const h = harness({ intent: { kind: 'unknown' } });

    await h.handle(textUpdate('а погода как', OWNER_CHAT));

    expect(lastText(h)).toContain('Не понял запрос');
  });

  it('парсер упал — подсказка, хендлер не падает', async () => {
    const h = harness({
      intentImpl: async () => {
        throw new Error('таймаут');
      },
    });

    await h.handle(textUpdate('найди что-нибудь', OWNER_CHAT));

    expect(lastText(h)).toContain('Не понял запрос');
  });

  it('парсер получает только текст запроса и контекст дат/кортов', async () => {
    // Персональные данные профиля (email, телефон, chat_id) в модель не едут.
    const seen: unknown[] = [];
    const h = harness({
      intentImpl: async (...args: unknown[]) => {
        seen.push(...args);
        return null;
      },
    });

    await h.handle(textUpdate('найди 2 часа в субботу', OWNER_CHAT));

    expect(seen[0]).toBe('найди 2 часа в субботу');
    expect(seen[1]).toMatchObject({ todayTbilisi: TODAY, weekday: 2 });
    const payload = JSON.stringify([seen[0], seen[1]]);
    expect(payload).not.toContain('ilya@example.com');
    expect(payload).not.toContain('+995555000111');
    expect(payload).not.toContain(String(OWNER_CHAT));
  });
});

// ---------------------------------------------------------------------------
// kind 'find'
// ---------------------------------------------------------------------------

describe('свободный запрос: поиск слотов', () => {
  it('находит слот и даёт кнопку на существующий экран подтверждения', async () => {
    const h = harness({
      intent: findIntent(),
      slots: { [`${C3_SERVICE}|${GAME_DAY}`]: [slot(GAME_DAY, '20:00')] },
    });

    await h.handle(textUpdate('что свободно в четверг вечером на третьем', OWNER_CHAT));

    const answer = h.calls.at(-1)!;
    expect(String(answer.payload['text'])).toContain('Padel Court 3');
    const datas = buttonsOf(answer).map((b) => b.callback_data);
    // Схема та же, что у мастера «📆 Бронировать» — ничего своего.
    expect(datas).toContain(`bk~t~${GAME_DAY}~${C3}~20:00`);
    // И ни одной брони по дороге.
    expect(h.bookNow).not.toHaveBeenCalled();
  });

  it('кнопка варианта открывает ШТАТНОЕ подтверждение, бронь — только после него', async () => {
    const h = harness({
      intent: findIntent(),
      slots: { [`${C3_SERVICE}|${GAME_DAY}`]: [slot(GAME_DAY, '20:00')] },
    });

    await h.handle(textUpdate('что свободно в четверг', OWNER_CHAT));
    const button = buttonsOf(h.calls.at(-1)!).find((b) => b.callback_data?.startsWith('bk~t~'))!;
    expect(button, 'у варианта обязана быть кнопка брони').toBeDefined();

    await h.handle(callbackUpdate(button.callback_data!, OWNER_CHAT));

    const confirm = h.calls.at(-1)!;
    expect(String(confirm.payload['text'])).toContain('Подтверди бронь');
    expect(buttonsOf(confirm).map((b) => b.callback_data)).toContain(`bk~y~${GAME_DAY}~${C3}~20:00`);
    // Экран подтверждения ничего не бронирует.
    expect(h.bookNow).not.toHaveBeenCalled();

    // А вот подтверждение — бронирует, и это единственный путь к POST.
    await h.handle(callbackUpdate(`bk~y~${GAME_DAY}~${C3}~20:00`, OWNER_CHAT));
    expect(h.bookNow).toHaveBeenCalledTimes(1);
    expect(h.bookNow.mock.calls[0]?.[1]).toMatchObject({
      date: GAME_DAY,
      time: '20:00',
      court: 'Padel Court 3',
    });
  });

  it('связка двух часов — две кнопки: слот 59 минут, это две брони', async () => {
    const h = harness({
      intent: findIntent({ durationHours: 2, consecutive: true }),
      slots: { [`${C3_SERVICE}|${GAME_DAY}`]: [slot(GAME_DAY, '20:00'), slot(GAME_DAY, '21:00')] },
    });

    await h.handle(textUpdate('два часа подряд в четверг', OWNER_CHAT));

    const answer = h.calls.at(-1)!;
    const datas = buttonsOf(answer).map((b) => b.callback_data);
    expect(datas).toContain(`bk~t~${GAME_DAY}~${C3}~20:00`);
    expect(datas).toContain(`bk~t~${GAME_DAY}~${C3}~21:00`);
    expect(String(answer.payload['text'])).toContain('отдельная бронь');
  });

  it('один и тот же час не даёт двух одинаковых кнопок', async () => {
    // durationHours без consecutive: связка 20+21 и те же часы поодиночке — три
    // варианта, но всего два бронируемых слота. Кнопка-дубль выбора не даёт.
    const h = harness({
      intent: findIntent({ durationHours: 2 }),
      slots: { [`${C3_SERVICE}|${GAME_DAY}`]: [slot(GAME_DAY, '20:00'), slot(GAME_DAY, '21:00')] },
    });

    await h.handle(textUpdate('пару часов в четверг', OWNER_CHAT));

    const datas = buttonsOf(h.calls.at(-1)!).map((b) => b.callback_data);
    expect(datas).toEqual([`bk~t~${GAME_DAY}~${C3}~20:00`, `bk~t~${GAME_DAY}~${C3}~21:00`]);
    expect(new Set(datas).size).toBe(datas.length);
  });

  it('вариантов больше потолка — честно говорим, сколько осталось за кадром', async () => {
    // «Ровно восемь» и «восемь из десяти» иначе выглядят одинаково, и человек
    // не понимает, что запрос стоит сузить.
    const hours = ['09:00', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00', '17:00', '18:00'];
    const h = harness({
      intent: findIntent(),
      slots: { [`${C3_SERVICE}|${GAME_DAY}`]: hours.map((t) => slot(GAME_DAY, t)) },
    });

    await h.handle(textUpdate('что свободно в четверг', OWNER_CHAT));

    const answer = h.calls.at(-1)!;
    expect(String(answer.payload['text'])).toContain('И ещё 2 варианта');
    // Кнопок ровно столько, сколько показанных вариантов.
    expect(buttonsOf(answer)).toHaveLength(8);
  });

  it('ничего не нашлось — честный текст, а не пустой список', async () => {
    const h = harness({ intent: findIntent(), slots: {} });

    await h.handle(textUpdate('что свободно в четверг', OWNER_CHAT));

    expect(lastText(h)).toContain('Ничего не нашёл');
    expect(buttonsOf(h.calls.at(-1)!)).toEqual([]);
  });

  it('слишком широкий запрос: просим сузить, Reservio не трогаем', async () => {
    // 8 дней горизонта × 6 кортов = 48 обращений ради одной фразы.
    const h = harness({ intent: { kind: 'find' } });

    await h.handle(textUpdate('когда вообще что-нибудь свободно', OWNER_CHAT));

    expect(h.availability).not.toHaveBeenCalled();
    expect(lastText(h)).toContain('Слишком широкий');
  });

  it('запрос в пределах лимита обходит все пары «день × корт»', async () => {
    const h = harness({ intent: { kind: 'find', dateFrom: GAME_DAY, dateTo: '2026-08-07' } });

    await h.handle(textUpdate('что есть в четверг и пятницу', OWNER_CHAT));

    // 2 дня × 6 кортов = 12 ≤ лимита.
    expect(h.availability).toHaveBeenCalledTimes(12);
  });

  it('даты вне горизонта клуба — объясняем горизонт, а не ищем', async () => {
    const h = harness({ intent: findIntent({ dateFrom: '2026-09-01', dateTo: '2026-09-02' }) });

    await h.handle(textUpdate('найди корт первого сентября', OWNER_CHAT));

    expect(h.availability).not.toHaveBeenCalled();
    expect(lastText(h)).toContain('горизонт');
  });

  it('выдуманный моделью корт не превращается в запрос к Reservio', async () => {
    // Мусору в структуре не верим: неизвестное имя отбрасываем и смотрим клуб
    // целиком, а не ходим за несуществующим serviceId.
    const h = harness({ intent: findIntent({ courts: ['Wimbledon Centre Court'] }) });

    await h.handle(textUpdate('найди корт в четверг', OWNER_CHAT));

    const services = h.availability.mock.calls.map((c) => c[0]);
    expect(services).toHaveLength(6);
    expect(new Set(services).size).toBe(6);
  });

  it('и найденное по такому запросу показывается, а не теряется в фильтре', async () => {
    // Регрессия на согласование двух модулей: хендлер расширяет неизвестное имя
    // до всех кортов клуба, а searchSlots сверяет имена с ключами карты точным
    // совпадением. Пока в поиск ехало имя от модели, шесть запросов в Reservio
    // заканчивались гарантированным «Ничего не нашёл».
    const h = harness({
      intent: findIntent({ courts: ['Wimbledon Centre Court'] }),
      slots: { [`${C3_SERVICE}|${GAME_DAY}`]: [slot(GAME_DAY, '20:00')] },
    });

    await h.handle(textUpdate('найди корт в четверг', OWNER_CHAT));

    expect(lastText(h)).not.toContain('Ничего не нашёл');
    expect(buttonsOf(h.calls.at(-1)!).map((b) => b.callback_data)).toContain(`bk~t~${GAME_DAY}~${C3}~20:00`);
  });

  it('Reservio не ответил — честный текст, не тишина', async () => {
    const h = harness({
      intent: findIntent(),
      availabilityImpl: async () => {
        throw new Error('availability: HTTP 503');
      },
    });

    await h.handle(textUpdate('что свободно в четверг', OWNER_CHAT));

    expect(lastText(h)).toContain('Reservio не ответил');
  });
});

// ---------------------------------------------------------------------------
// kind 'book'
// ---------------------------------------------------------------------------

describe('свободный запрос: точечная бронь', () => {
  const bookIntent = (patch: Partial<BookingIntent> = {}): BookingIntent => ({
    kind: 'book',
    date: GAME_DAY,
    time: '20:00',
    court: 'Padel Court 3',
    ...patch,
  });

  it('свободный слот — сразу штатный экран подтверждения, без брони', async () => {
    const h = harness({
      intent: bookIntent(),
      slots: { [`${C3_SERVICE}|${GAME_DAY}`]: [slot(GAME_DAY, '20:00')] },
    });

    await h.handle(textUpdate('забронируй четверг 20:00 на третьем', OWNER_CHAT));

    const confirm = h.calls.at(-1)!;
    expect(String(confirm.payload['text'])).toContain('Подтверди бронь');
    expect(buttonsOf(confirm).map((b) => b.callback_data)).toContain(`bk~y~${GAME_DAY}~${C3}~20:00`);
    expect(h.bookNow).not.toHaveBeenCalled();
  });

  it('занятый слот — честный отказ до всякого подтверждения', async () => {
    const h = harness({ intent: bookIntent(), slots: { [`${C3_SERVICE}|${GAME_DAY}`]: [slot(GAME_DAY, '19:00')] } });

    await h.handle(textUpdate('забронируй четверг 20:00 на третьем', OWNER_CHAT));

    expect(lastText(h)).toContain('занят');
    expect(buttonsOf(h.calls.at(-1)!)).toEqual([]);
    expect(h.bookNow).not.toHaveBeenCalled();
  });

  it('мусор вместо корта/времени/даты не бронирует ничего', async () => {
    for (const patch of [{ court: 'Стадион Динамо' }, { time: '25:99' }, { date: '2026-12-31' }]) {
      const h = harness({ intent: bookIntent(patch) });

      await h.handle(textUpdate('забронируй уже что-нибудь', OWNER_CHAT));

      expect(h.availability).not.toHaveBeenCalled();
      expect(h.bookNow).not.toHaveBeenCalled();
      expect(lastText(h)).toContain('Не понял запрос');
    }
  });

  it('Reservio не ответил — честный текст вместо экрана подтверждения', async () => {
    const h = harness({
      intent: bookIntent(),
      availabilityImpl: async () => {
        throw new Error('availability: HTTP 503');
      },
    });

    await h.handle(textUpdate('забронируй четверг 20:00', OWNER_CHAT));

    expect(lastText(h)).toContain('Reservio не ответил');
    expect(h.bookNow).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Секреты и приватность
// ---------------------------------------------------------------------------

describe('свободный запрос: ключ модели наружу не течёт', () => {
  it('ключа нет ни в логах, ни в исходящих сообщениях', async () => {
    const h = harness({
      intent: findIntent(),
      slots: { [`${C3_SERVICE}|${GAME_DAY}`]: [slot(GAME_DAY, '20:00')] },
    });

    await h.handle(textUpdate('что свободно в четверг', OWNER_CHAT));

    expect(h.logs.join('\n')).not.toContain(API_KEY);
    expect(JSON.stringify(h.calls)).not.toContain(API_KEY);
  });

  it('ключ не всплывает и в тексте ошибки парсера', async () => {
    // Сетевые ошибки любят процитировать заголовки и URL целиком.
    const h = harness({
      intentImpl: async () => {
        throw new Error(`fetch failed: x-api-key=${API_KEY}`);
      },
    });

    await h.handle(textUpdate('найди что-нибудь', OWNER_CHAT));

    expect(h.logs.join('\n')).not.toContain(API_KEY);
    expect(JSON.stringify(h.calls)).not.toContain(API_KEY);
  });

  it('текст запроса человека в лог процесса не пишется', async () => {
    const h = harness({ intent: findIntent(), slots: {} });

    await h.handle(textUpdate('секретный план на четверг', OWNER_CHAT));

    expect(h.logs.join('\n')).not.toContain('секретный план');
    // Но факт запроса в логе есть: иначе разбирать инциденты нечем.
    expect(h.logs.join('\n')).toContain('свободный запрос');
  });
});
