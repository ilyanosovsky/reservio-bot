// Приглашения игроков и мастер «➕ Добавить профиль» — полный путь через
// собранного бота (src/bot/setup.ts → registerHandlers), стиль
// tests/bot-auth.test.ts: настоящий grammY-Composer, настоящий Context, Bot API
// подменена трансформером (любой исходящий вызов записывается и никуда не летит).
//
// Главное, что здесь проверяется, — НЕПРИСТУПНОСТЬ единственного исключения из
// инварианта тишины. Приглашение обязано отвечать ровно в одном случае:
// приватный чат + `/start inv_<код>` + код погашен впервые + профиль под ним
// существует и свободен. Любое отклонение — та же полная тишина, что у чужого
// chat_id: по разнице в поведении перебирающий не должен понять ни что он
// угадал живой код, ни что бот вообще жив.
//
// Поэтому почти каждый тест ниже утверждает `calls == []`. Это не паранойя: за
// исключением из тишины стоит доступ к чужому профилю и его броням.

import { describe, expect, it, vi } from 'vitest';
import { Api, Composer, Context, type Transformer } from 'grammy';
import type { Update, UserFromGetMe } from 'grammy/types';
import { inviteMiddleware } from '../src/bot/auth.js';
import type { BotContext, BotDeps } from '../src/bot/context.js';
import { installBot } from '../src/bot/setup.js';
import { BTN } from '../src/bot/menu.js';
import { PROFILE_DRAFT_TTL_MS } from '../src/bot/wizard-state.js';
import type { ProfileRow } from '../src/core/repos.js';

const ADMIN_CHAT = 424242;
/** Второй администратор: его активность не должна ломать мастер первого. */
const ADMIN2_CHAT = 424243;
/** Чат приглашённого игрока: боту он до перехода по ссылке неизвестен. */
const GUEST_CHAT = 777001;
const STRANGER_CHAT = 777002;
const GROUP_CHAT = -1001234567890;

/** Код того же вида, что выдаёт InvitesRepo.create: 32 hex-символа. */
const CODE = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const OTHER_CODE = 'ffeeddccbbaa99887766554433221100';

function profileRow(patch: Partial<ProfileRow> = {}): ProfileRow {
  return {
    id: 'ilya',
    label: 'Илья',
    name: 'Ilya Test',
    email: 'ilya@example.com',
    phone: '+995555000111',
    telegramChatId: String(ADMIN_CHAT),
    isAdmin: false,
    ...patch,
  };
}

const BOT_INFO = {
  id: 1,
  is_bot: true,
  first_name: 'padel',
  username: 'padel_test_bot',
  can_join_groups: true,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
} as unknown as UserFromGetMe;

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

/**
 * Фейковый Supabase на объектах в памяти: профили ищутся по chat_id и id, коды
 * гасятся так же атомарно, как это делает PostgREST (одна проверка used_at под
 * тем же вызовом). Настоящий SQL здесь не нужен — форму запроса к PostgREST
 * проверяет tests/repos.test.ts, а тут важно ПОВЕДЕНИЕ бота вокруг него.
 */
interface InviteRecord {
  profileId: string;
  used: boolean;
}

interface Harness {
  calls: ApiCall[];
  profiles: ProfileRow[];
  invites: Map<string, InviteRecord>;
  claim: ReturnType<typeof vi.fn>;
  createInvite: ReturnType<typeof vi.fn>;
  upsert: ReturnType<typeof vi.fn>;
  now: { value: number };
  handle(update: Update): Promise<void>;
}

interface HarnessInit {
  profiles?: ProfileRow[];
  invites?: Record<string, InviteRecord>;
  /** Подменяет claim целиком — для гонок и падений хранилища. */
  claimImpl?: (code: string, chatId: string) => Promise<{ profileId: string } | null>;
}

function harness(init: HarnessInit = {}): Harness {
  const { api, calls } = recordingApi();
  const profiles = init.profiles ?? [];
  const invites = new Map<string, InviteRecord>(Object.entries(init.invites ?? {}));
  const now = { value: Date.UTC(2026, 7, 4, 12, 0, 0) };

  const defaultClaim = async (code: string): Promise<{ profileId: string } | null> => {
    const found = invites.get(code);
    // Ровно семантика `update ... where code = $1 and used_at is null`: не
    // нашли ИЛИ уже погашен — пустой ответ, снаружи неразличимо.
    if (found === undefined || found.used) return null;
    found.used = true;
    return { profileId: found.profileId };
  };
  const claim = vi.fn(init.claimImpl ?? defaultClaim);

  const createInvite = vi.fn(async (profileId: string) => {
    invites.set(OTHER_CODE, { profileId, used: false });
    return OTHER_CODE;
  });

  const upsert = vi.fn(async (row: ProfileRow) => {
    const at = profiles.findIndex((p) => p.id === row.id);
    if (at < 0) profiles.push(row);
    else profiles[at] = row;
  });

  const deps = {
    profiles: {
      getByChatId: vi.fn(async (chatId: string) => profiles.find((p) => p.telegramChatId === chatId) ?? null),
      getById: vi.fn(async (id: string) => profiles.find((p) => p.id === id) ?? null),
      list: vi.fn(async () => profiles),
      upsert,
    },
    invites: { claim, create: createInvite },
    schedules: {
      listByProfile: vi.fn(async () => []),
      upsert: vi.fn(async () => {}),
      setEnabled: vi.fn(async () => {}),
      remove: vi.fn(async () => {}),
    },
    skips: { listUpcoming: vi.fn(async () => []), add: vi.fn(async () => {}), remove: vi.fn(async () => {}) },
    state: { listBookings: vi.fn(async () => []) },
    client: {},
    bookNow: vi.fn(),
    now: () => new Date(now.value),
    log: (): void => {},
  } as unknown as BotDeps;

  const bot = new Composer<BotContext>();
  installBot(bot, deps);
  const middleware = bot.middleware();

  return {
    calls,
    profiles,
    invites,
    claim,
    createInvite,
    upsert,
    now,
    handle: async (update: Update): Promise<void> => {
      const ctx = new Context(update, api, BOT_INFO) as BotContext;
      await middleware(ctx, async () => {});
    },
  };
}

let updateId = 0;

function textUpdate(text: string, chatId: number, chatType: 'private' | 'supergroup' = 'private'): Update {
  updateId += 1;
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 1_754_000_000,
      chat: { id: chatId, type: chatType },
      from: { id: chatId === GROUP_CHAT ? STRANGER_CHAT : chatId, is_bot: false, first_name: 'Tester' },
      text,
    },
  } as unknown as Update;
}

/** Команда: grammY ищет entity bot_command в начале текста. */
function commandUpdate(text: string, chatId: number, chatType: 'private' | 'supergroup' = 'private'): Update {
  const update = textUpdate(text, chatId, chatType);
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
        text: 'экран мастера',
      },
    },
  } as unknown as Update;
}

/** Ссылка-приглашение, как её открывает Telegram: `/start inv_<код>`. */
const inviteStart = (code: string, chatId: number, chatType: 'private' | 'supergroup' = 'private'): Update =>
  commandUpdate(`/start inv_${code}`, chatId, chatType);

/** Текст последнего исходящего сообщения. */
const lastText = (h: Harness): string => String(h.calls.at(-1)!.payload['text'] ?? '');

function buttonsOf(call: ApiCall): { text: string; callback_data?: string }[] {
  const markup = call.payload['reply_markup'] as { inline_keyboard?: { text: string; callback_data?: string }[][] };
  return (markup?.inline_keyboard ?? []).flat();
}

// ---------------------------------------------------------------------------
// Приём приглашения
// ---------------------------------------------------------------------------

describe('приглашение: валидный код привязывает чат', () => {
  it('чат привязывается к профилю, игрок получает приветствие и меню', async () => {
    const anna = profileRow({ id: 'p1a2b3c4', label: 'Аня', telegramChatId: null });
    const h = harness({ profiles: [anna], invites: { [CODE]: { profileId: 'p1a2b3c4', used: false } } });

    await h.handle(inviteStart(CODE, GUEST_CHAT));

    expect(h.claim).toHaveBeenCalledWith(CODE, String(GUEST_CHAT));
    // Привязка ушла в базу…
    expect(h.upsert).toHaveBeenCalledTimes(1);
    expect(h.upsert.mock.calls[0]?.[0]).toMatchObject({ id: 'p1a2b3c4', telegramChatId: String(GUEST_CHAT) });
    // …и человек об этом узнал (молчаливый успех — тот же молчаливый провал).
    expect(h.calls.map((c) => c.method)).toEqual(['sendMessage']);
    expect(lastText(h)).toContain('Аня');
  });

  it('приветствие показывает меню игрока, БЕЗ админской кнопки «Профили»', async () => {
    const anna = profileRow({ id: 'p1a2b3c4', label: 'Аня', telegramChatId: null });
    const h = harness({ profiles: [anna], invites: { [CODE]: { profileId: 'p1a2b3c4', used: false } } });

    await h.handle(inviteStart(CODE, GUEST_CHAT));

    const markup = h.calls[0]!.payload['reply_markup'] as { keyboard?: { text: string }[][] };
    const labels = (markup.keyboard ?? []).flat().map((b) => b.text);
    expect(labels).toContain(BTN.schedule);
    expect(labels).toContain(BTN.skip);
    // Приглашённый админом не становится никогда.
    expect(labels).not.toContain(BTN.profiles);
  });

  it('после привязки чат работает как обычный профиль', async () => {
    const anna = profileRow({ id: 'p1a2b3c4', label: 'Аня', telegramChatId: null });
    const h = harness({ profiles: [anna], invites: { [CODE]: { profileId: 'p1a2b3c4', used: false } } });

    await h.handle(inviteStart(CODE, GUEST_CHAT));
    h.calls.length = 0;
    await h.handle(textUpdate(BTN.bookings, GUEST_CHAT));

    expect(h.calls.map((c) => c.method)).toEqual(['sendMessage']);
  });

  it('код гасится: он одноразовый по построению', async () => {
    const anna = profileRow({ id: 'p1a2b3c4', label: 'Аня', telegramChatId: null });
    const h = harness({ profiles: [anna], invites: { [CODE]: { profileId: 'p1a2b3c4', used: false } } });

    await h.handle(inviteStart(CODE, GUEST_CHAT));

    expect(h.invites.get(CODE)?.used).toBe(true);
  });
});

describe('приглашение: гонка за один код', () => {
  it('двойной тап по ссылке -> ровно ОДНА привязка и одно приветствие', async () => {
    // Человек жмёт Start дважды (или Telegram доставил апдейт повторно).
    // Одноразовость держит условие used_at is null внутри claim, а не проверка
    // до него: «сначала select, потом update» здесь дал бы две привязки.
    const anna = profileRow({ id: 'p1a2b3c4', label: 'Аня', telegramChatId: null });
    const h = harness({ profiles: [anna], invites: { [CODE]: { profileId: 'p1a2b3c4', used: false } } });

    await h.handle(inviteStart(CODE, GUEST_CHAT));
    await h.handle(inviteStart(CODE, GUEST_CHAT));

    expect(h.claim).toHaveBeenCalledTimes(1); // второй раз чат уже свой — /start
    expect(h.upsert).toHaveBeenCalledTimes(1);
    // Второй тап — обычный /start: приветствие, а не вторая привязка.
    expect(h.calls.map((c) => c.method)).toEqual(['sendMessage', 'sendMessage']);
    expect(h.profiles.filter((p) => p.telegramChatId === String(GUEST_CHAT))).toHaveLength(1);
  });

  it('два РАЗНЫХ чата за один код: привязывается первый, второй молчит', async () => {
    // Ссылку переслали дальше. Профиль достаётся тому, кто успел; второму —
    // тишина, как чужому чату.
    const anna = profileRow({ id: 'p1a2b3c4', label: 'Аня', telegramChatId: null });
    const h = harness({ profiles: [anna], invites: { [CODE]: { profileId: 'p1a2b3c4', used: false } } });

    await h.handle(inviteStart(CODE, GUEST_CHAT));
    const afterFirst = h.calls.length;
    await h.handle(inviteStart(CODE, STRANGER_CHAT));

    expect(h.claim).toHaveBeenCalledTimes(2);
    expect(h.upsert).toHaveBeenCalledTimes(1);
    expect(h.calls).toHaveLength(afterFirst); // второму не ушло НИЧЕГО
    expect(h.profiles[0]?.telegramChatId).toBe(String(GUEST_CHAT));
  });

  it('claim проиграл гонку (пустой ответ) — тишина, привязки нет', async () => {
    // Ровно то, что вернёт PostgREST проигравшему в конкурентном update.
    const anna = profileRow({ id: 'p1a2b3c4', label: 'Аня', telegramChatId: null });
    const h = harness({
      profiles: [anna],
      invites: { [CODE]: { profileId: 'p1a2b3c4', used: false } },
      claimImpl: async () => null,
    });

    await h.handle(inviteStart(CODE, GUEST_CHAT));

    expect(h.calls).toEqual([]);
    expect(h.upsert).not.toHaveBeenCalled();
  });
});

describe('приглашение: всё остальное — та же тишина, что чужому чату', () => {
  it('несуществующий код', async () => {
    const h = harness({ profiles: [profileRow({ id: 'p1', telegramChatId: null })] });

    await h.handle(inviteStart(CODE, GUEST_CHAT));

    expect(h.calls).toEqual([]);
    expect(h.upsert).not.toHaveBeenCalled();
  });

  it('уже использованный код', async () => {
    const anna = profileRow({ id: 'p1a2b3c4', label: 'Аня', telegramChatId: null });
    const h = harness({ profiles: [anna], invites: { [CODE]: { profileId: 'p1a2b3c4', used: true } } });

    await h.handle(inviteStart(CODE, GUEST_CHAT));

    expect(h.calls).toEqual([]);
    expect(h.upsert).not.toHaveBeenCalled();
  });

  it('несуществующий и использованный код неотличимы по поведению бота', async () => {
    // Разное поведение подсказало бы перебирающему, что он угадал живой код.
    const missing = harness({ profiles: [profileRow({ id: 'p1', telegramChatId: null })] });
    const used = harness({
      profiles: [profileRow({ id: 'p1a2b3c4', telegramChatId: null })],
      invites: { [CODE]: { profileId: 'p1a2b3c4', used: true } },
    });

    await missing.handle(inviteStart(CODE, GUEST_CHAT));
    await used.handle(inviteStart(CODE, GUEST_CHAT));

    expect(missing.calls).toEqual(used.calls);
    expect(missing.calls).toEqual([]);
  });

  it('код ведёт на профиль, у которого chat_id УЖЕ занят', async () => {
    // Перепривязка отобрала бы у живого человека доступ к его броням.
    const taken = profileRow({ id: 'p1a2b3c4', telegramChatId: String(ADMIN_CHAT) });
    const h = harness({ profiles: [taken], invites: { [CODE]: { profileId: 'p1a2b3c4', used: false } } });

    await h.handle(inviteStart(CODE, GUEST_CHAT));

    expect(h.calls).toEqual([]);
    expect(h.upsert).not.toHaveBeenCalled();
    expect(h.profiles[0]?.telegramChatId).toBe(String(ADMIN_CHAT));
    // Код при этом сгорел — и правильно: он уже был выпущен и предъявлен.
    expect(h.invites.get(CODE)?.used).toBe(true);
  });

  it('код ведёт на профиль, которого больше нет', async () => {
    const h = harness({ profiles: [], invites: { [CODE]: { profileId: 'p-удалён', used: false } } });

    await h.handle(inviteStart(CODE, GUEST_CHAT));

    expect(h.calls).toEqual([]);
    expect(h.upsert).not.toHaveBeenCalled();
  });

  it('ссылка из ГРУППЫ не привязывает никого', async () => {
    // chat_id группы — не удостоверение личности: под ним пишет любой участник.
    const anna = profileRow({ id: 'p1a2b3c4', telegramChatId: null });
    const h = harness({ profiles: [anna], invites: { [CODE]: { profileId: 'p1a2b3c4', used: false } } });

    await h.handle(inviteStart(CODE, GROUP_CHAT, 'supergroup'));

    expect(h.calls).toEqual([]);
    expect(h.claim).not.toHaveBeenCalled(); // код даже не тратится
    expect(h.upsert).not.toHaveBeenCalled();
  });

  it('код не того формата до хранилища не доезжает', async () => {
    const h = harness({ profiles: [profileRow({ id: 'p1', telegramChatId: null })] });

    await h.handle(inviteStart('короткий', GUEST_CHAT));
    await h.handle(commandUpdate('/start inv_', GUEST_CHAT));
    await h.handle(commandUpdate(`/start ref_${CODE}`, GUEST_CHAT));

    expect(h.calls).toEqual([]);
    expect(h.claim).not.toHaveBeenCalled();
  });

  it('обычный /start от неизвестного чата — по-прежнему тишина', async () => {
    // Проверка, что invite-ветка не приоткрыла общий вход.
    const h = harness({ profiles: [profileRow({ id: 'p1a2b3c4', telegramChatId: null })] });

    await h.handle(commandUpdate('/start', GUEST_CHAT));
    await h.handle(textUpdate(BTN.bookings, GUEST_CHAT));

    expect(h.calls).toEqual([]);
  });

  it('хранилище упало на claim — молчим (fail-closed), а не «у нас проблемы»', async () => {
    const h = harness({
      profiles: [profileRow({ id: 'p1a2b3c4', telegramChatId: null })],
      invites: { [CODE]: { profileId: 'p1a2b3c4', used: false } },
      claimImpl: async () => {
        throw new Error('PostgREST 500');
      },
    });

    await h.handle(inviteStart(CODE, GUEST_CHAT));

    expect(h.calls).toEqual([]);
  });

  it('падение уже ПОСЛЕ claim тоже не порождает ответа', async () => {
    const anna = profileRow({ id: 'p1a2b3c4', telegramChatId: null });
    const h = harness({ profiles: [anna], invites: { [CODE]: { profileId: 'p1a2b3c4', used: false } } });
    h.upsert.mockRejectedValueOnce(new Error('PostgREST 500'));

    await h.handle(inviteStart(CODE, GUEST_CHAT));

    expect(h.calls).toEqual([]);
  });
});

describe('приглашение: известный чат остаётся при своём профиле', () => {
  it('свой чат с invite-ссылкой получает ОБЫЧНЫЙ /start, код не тратится', async () => {
    // Переслал ссылку сам себе — ничего не должно измениться, и код обязан
    // остаться живым для того, кому он предназначен.
    const own = profileRow({ label: 'Илья' });
    const h = harness({ profiles: [own], invites: { [CODE]: { profileId: 'p1a2b3c4', used: false } } });

    await h.handle(inviteStart(CODE, ADMIN_CHAT));

    expect(h.claim).not.toHaveBeenCalled();
    expect(h.invites.get(CODE)?.used).toBe(false);
    expect(h.upsert).not.toHaveBeenCalled();
    expect(h.calls.map((c) => c.method)).toEqual(['sendMessage']);
    expect(lastText(h)).toContain('Илья');
  });

  it('чужая ссылка не переселяет уже привязанный чат на другой профиль', async () => {
    const own = profileRow({ id: 'ilya', telegramChatId: String(ADMIN_CHAT) });
    const anna = profileRow({ id: 'p1a2b3c4', label: 'Аня', telegramChatId: null });
    const h = harness({ profiles: [own, anna], invites: { [CODE]: { profileId: 'p1a2b3c4', used: false } } });

    await h.handle(inviteStart(CODE, ADMIN_CHAT));

    expect(h.profiles.find((p) => p.id === 'p1a2b3c4')?.telegramChatId).toBeNull();
    expect(h.profiles.find((p) => p.id === 'ilya')?.telegramChatId).toBe(String(ADMIN_CHAT));
  });
});

describe('inviteMiddleware: порядок в сборке', () => {
  it('не-приглашение пропускается дальше нетронутым', async () => {
    // Иначе invite-ветка съедала бы обычные апдейты до authMiddleware.
    const next = vi.fn(async () => {});
    const claim = vi.fn();
    const mw = inviteMiddleware({
      invites: { claim },
      profiles: { getByChatId: vi.fn(async () => null), getById: vi.fn(async () => null), upsert: vi.fn(async () => {}) },
    });

    const ctx = {
      chat: { id: GUEST_CHAT, type: 'private' },
      from: { id: GUEST_CHAT },
      message: { text: 'привет' },
    } as unknown as BotContext;
    await mw(ctx, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(claim).not.toHaveBeenCalled();
  });

  it('приглашение обрабатывается ДО общей проверки allowlist', async () => {
    // Единственный содержательный тест порядка: чат без профиля, который
    // authMiddleware отбросил бы молча, здесь получает ответ.
    const anna = profileRow({ id: 'p1a2b3c4', label: 'Аня', telegramChatId: null });
    const h = harness({ profiles: [anna], invites: { [CODE]: { profileId: 'p1a2b3c4', used: false } } });

    await h.handle(inviteStart(CODE, GUEST_CHAT));

    expect(h.calls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Мастер «➕ Добавить профиль»
// ---------------------------------------------------------------------------

const admin = (): ProfileRow => profileRow({ isAdmin: true });
const admin2 = (): ProfileRow =>
  profileRow({ id: 'ilya2', label: 'Второй админ', telegramChatId: String(ADMIN2_CHAT), isAdmin: true });

/** Проходит мастер до сводки и возвращает стенд. */
async function walkToSummary(h: Harness): Promise<void> {
  await h.handle(textUpdate(BTN.profiles, ADMIN_CHAT));
  const add = buttonsOf(h.calls[0]!).find((b) => b.text.includes('Добавить профиль'))!;
  await h.handle(callbackUpdate(add.callback_data!, ADMIN_CHAT));
  await h.handle(textUpdate('Аня', ADMIN_CHAT));
  await h.handle(textUpdate('anna@example.com', ADMIN_CHAT));
  await h.handle(textUpdate('+995 555 111 222', ADMIN_CHAT));
}

describe('мастер профиля: полный путь по кнопкам, которые бот рисует сам', () => {
  it('«👤 Профили» предлагает кнопку «➕ Добавить профиль»', async () => {
    const h = harness({ profiles: [admin()] });

    await h.handle(textUpdate(BTN.profiles, ADMIN_CHAT));

    const button = buttonsOf(h.calls[0]!).find((b) => b.text.includes('Добавить профиль'));
    expect(button, 'кнопка мастера обязана быть на экране профилей').toBeDefined();
    expect(button!.callback_data).toBe('pw~n');
  });

  it('три шага спрашивают имя, email и телефон — сообщениями', async () => {
    const h = harness({ profiles: [admin()] });

    await h.handle(textUpdate(BTN.profiles, ADMIN_CHAT));
    await h.handle(callbackUpdate('pw~n', ADMIN_CHAT));
    expect(lastText(h)).toContain('Имя игрока');
    expect(lastText(h)).toContain('шаг 1/4');

    await h.handle(textUpdate('Аня', ADMIN_CHAT));
    expect(lastText(h)).toContain('Email');
    expect(lastText(h)).toContain('шаг 2/4');

    await h.handle(textUpdate('anna@example.com', ADMIN_CHAT));
    expect(lastText(h)).toContain('Телефон');
    expect(lastText(h)).toContain('шаг 3/4');

    await h.handle(textUpdate('+995555111222', ADMIN_CHAT));
    expect(lastText(h)).toContain('шаг 4/4');
  });

  it('сводка показывает введённое и даёт кнопки «Создать»/«Отмена»', async () => {
    const h = harness({ profiles: [admin()] });

    await walkToSummary(h);

    const summary = h.calls.at(-1)!;
    expect(String(summary.payload['text'])).toContain('Аня');
    expect(String(summary.payload['text'])).toContain('anna@example.com');
    // Телефон нормализован — скобки и пробелы мастер убрал сам.
    expect(String(summary.payload['text'])).toContain('+995555111222');
    expect(buttonsOf(summary).map((b) => b.callback_data)).toEqual(['pw~y', 'pw~x']);
  });

  it('«✅ Создать» заводит профиль и выдаёт ссылку-приглашение', async () => {
    const h = harness({ profiles: [admin()] });

    await walkToSummary(h);
    await h.handle(callbackUpdate('pw~y', ADMIN_CHAT));

    expect(h.upsert).toHaveBeenCalledTimes(1);
    const created = h.upsert.mock.calls[0]?.[0] as ProfileRow;
    expect(created).toMatchObject({
      label: 'Аня',
      name: 'Аня',
      email: 'anna@example.com',
      phone: '+995555111222',
      // Чат привяжет сам игрок по ссылке; админом мастер не делает никого.
      telegramChatId: null,
      isAdmin: false,
    });
    expect(created.id).toMatch(/^p[0-9a-f]{8}$/);

    expect(h.createInvite).toHaveBeenCalledWith(created.id);
    expect(lastText(h)).toContain(`https://t.me/${BOT_INFO.username}?start=inv_${OTHER_CODE}`);
  });

  it('имя бота в ссылке берётся из getMe, а не хардкодом', async () => {
    const h = harness({ profiles: [admin()] });

    await walkToSummary(h);
    await h.handle(callbackUpdate('pw~y', ADMIN_CHAT));

    expect(lastText(h)).toContain('padel_test_bot');
  });

  it('выданная ссылка реально работает: игрок по ней привязывается', async () => {
    // Сквозная проверка мастера и приёма приглашения одним стендом — то, ради
    // чего всё это и делалось.
    const h = harness({ profiles: [admin()] });

    await walkToSummary(h);
    await h.handle(callbackUpdate('pw~y', ADMIN_CHAT));
    const created = h.upsert.mock.calls[0]?.[0] as ProfileRow;
    h.calls.length = 0;

    await h.handle(inviteStart(OTHER_CODE, GUEST_CHAT));

    expect(h.calls.map((c) => c.method)).toEqual(['sendMessage']);
    expect(h.profiles.find((p) => p.id === created.id)?.telegramChatId).toBe(String(GUEST_CHAT));
  });

  it('повторный тап «Создать» не заводит второго игрока', async () => {
    // Кнопка stateless: сеть подтормозила — человек жмёт ещё раз. Второй тап
    // видит «черновика нет», и это честнее, чем дубль профиля и второй код.
    const h = harness({ profiles: [admin()] });

    await walkToSummary(h);
    await h.handle(callbackUpdate('pw~y', ADMIN_CHAT));
    await h.handle(callbackUpdate('pw~y', ADMIN_CHAT));

    expect(h.upsert).toHaveBeenCalledTimes(1);
    expect(h.createInvite).toHaveBeenCalledTimes(1);
    expect(lastText(h)).toContain('не найден');
  });

  it('«❌ Отмена» ничего не создаёт', async () => {
    const h = harness({ profiles: [admin()] });

    await walkToSummary(h);
    await h.handle(callbackUpdate('pw~x', ADMIN_CHAT));

    expect(h.upsert).not.toHaveBeenCalled();
    expect(h.createInvite).not.toHaveBeenCalled();
    expect(lastText(h)).toContain('отменён');
  });
});

describe('мастер профиля: валидация и сброс', () => {
  it('кривой email переспрашивает тот же шаг, не двигаясь дальше', async () => {
    const h = harness({ profiles: [admin()] });

    await h.handle(callbackUpdate('pw~n', ADMIN_CHAT));
    await h.handle(textUpdate('Аня', ADMIN_CHAT));
    await h.handle(textUpdate('не-почта', ADMIN_CHAT));

    expect(lastText(h)).toContain('шаг 2/4');
    expect(lastText(h)).toContain('⚠️');
    // Значение в чат не возвращаем: персональные данные.
    expect(lastText(h)).not.toContain('не-почта');

    // Исправленный ответ принимается.
    await h.handle(textUpdate('anna@example.com', ADMIN_CHAT));
    expect(lastText(h)).toContain('шаг 3/4');
  });

  it('/cancel посреди мастера сбрасывает черновик', async () => {
    const h = harness({ profiles: [admin()] });

    await h.handle(callbackUpdate('pw~n', ADMIN_CHAT));
    await h.handle(textUpdate('Аня', ADMIN_CHAT));
    await h.handle(commandUpdate('/cancel', ADMIN_CHAT));
    expect(lastText(h)).toContain('отменён');

    // Черновика больше нет: следующий свободный текст мастер не ест.
    h.calls.length = 0;
    await h.handle(textUpdate('anna@example.com', ADMIN_CHAT));
    expect(h.calls).toEqual([]);
  });

  it('/cancel без черновика отвечает «отменять нечего»', async () => {
    const h = harness({ profiles: [admin()] });

    await h.handle(commandUpdate('/cancel', ADMIN_CHAT));

    expect(lastText(h)).toContain('нечего');
  });

  it('кнопка меню посреди мастера РАБОТАЕТ и сбрасывает черновик с подсказкой', async () => {
    // Молчаливый сброс был бы хуже: человек дописывал бы мастер, которого нет.
    const h = harness({ profiles: [admin()] });

    await h.handle(callbackUpdate('pw~n', ADMIN_CHAT));
    await h.handle(textUpdate('Аня', ADMIN_CHAT));
    h.calls.length = 0;

    await h.handle(textUpdate(BTN.schedule, ADMIN_CHAT));

    const texts = h.calls.map((c) => String(c.payload['text']));
    expect(texts.some((t) => t.includes('отменён'))).toBe(true);
    // И сам экран расписания человек всё-таки увидел.
    expect(texts.some((t) => t.includes('Расписание'))).toBe(true);

    // Черновика больше нет.
    h.calls.length = 0;
    await h.handle(textUpdate('anna@example.com', ADMIN_CHAT));
    expect(h.calls).toEqual([]);
  });

  it('черновик протухает через 15 минут и объясняется ровно один раз', async () => {
    const h = harness({ profiles: [admin()] });

    await h.handle(callbackUpdate('pw~n', ADMIN_CHAT));
    await h.handle(textUpdate('Аня', ADMIN_CHAT));
    h.now.value += PROFILE_DRAFT_TTL_MS;
    h.calls.length = 0;

    await h.handle(textUpdate('anna@example.com', ADMIN_CHAT));
    expect(lastText(h)).toContain('15 минут');

    // Второе сообщение — уже обычный посторонний текст, бот молчит.
    h.calls.length = 0;
    await h.handle(textUpdate('+995555111222', ADMIN_CHAT));
    expect(h.calls).toEqual([]);
  });

  it('черновик, вычищенный активностью ДРУГОГО админа, всё равно объясняется владельцу', async () => {
    // Регрессия: чистка памяти проходит по всем черновикам сразу, поэтому
    // протухший мастер первого админа выметает любое сообщение второго. Раньше
    // подсказка «истёк» при этом терялась насовсем, и первый админ на свой
    // ответ получал полную тишину — молчаливо съеденное сообщение.
    const h = harness({ profiles: [admin(), admin2()] });

    await h.handle(callbackUpdate('pw~n', ADMIN_CHAT));
    await h.handle(textUpdate('Аня', ADMIN_CHAT));
    h.now.value += PROFILE_DRAFT_TTL_MS;

    // Второй админ просто нажимает свою кнопку — этого достаточно.
    await h.handle(textUpdate(BTN.bookings, ADMIN2_CHAT));
    h.calls.length = 0;

    // Первый возвращается к мастеру: он обязан узнать, что черновика больше нет.
    await h.handle(textUpdate('anna@example.com', ADMIN_CHAT));

    expect(lastText(h)).toContain('15 минут');
  });

  it('текст вместо кнопки на сводке возвращает СВОДКУ с кнопками, а не «ответь сообщением»', async () => {
    // Экран шага заканчивается инструкцией «Ответь сообщением», и под ним нет
    // кнопок: показать его в ответ на «нажми кнопку» значит выдать экран,
    // который противоречит сам себе.
    const h = harness({ profiles: [admin()] });

    await walkToSummary(h);
    h.calls.length = 0;

    await h.handle(textUpdate('да, создавай', ADMIN_CHAT));

    const answer = h.calls.at(-1)!;
    const text = String(answer.payload['text']);
    expect(text).toContain('⚠️');
    expect(text).toContain('Создать');
    // Кнопки под этим же сообщением — жать есть куда.
    expect(buttonsOf(answer).map((b) => b.callback_data)).toEqual(['pw~y', 'pw~x']);
    // И никакого «ответь сообщением»: отвечать сообщением тут как раз не надо.
    expect(text).not.toContain('Ответь сообщением');
    // Введённое не потерялось.
    expect(text).toContain('anna@example.com');
  });

  it('«Создать» по протухшему черновику ничего не создаёт', async () => {
    const h = harness({ profiles: [admin()] });

    await walkToSummary(h);
    h.now.value += PROFILE_DRAFT_TTL_MS;
    h.upsert.mockClear();

    await h.handle(callbackUpdate('pw~y', ADMIN_CHAT));

    expect(h.upsert).not.toHaveBeenCalled();
    expect(h.createInvite).not.toHaveBeenCalled();
    expect(lastText(h)).toContain('не найден');
  });

  it('свободный текст админа БЕЗ черновика мастер не трогает', async () => {
    // Гейт не должен превращать бота в эхо: без активного мастера обычное
    // сообщение остаётся неотвеченным, как и раньше.
    const h = harness({ profiles: [admin()] });

    await h.handle(textUpdate('просто мысли вслух', ADMIN_CHAT));

    expect(h.calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Перевыпуск приглашения
// ---------------------------------------------------------------------------

describe('перевыпуск приглашения: кнопка «🔗 Ссылка» у непривязанного профиля', () => {
  const anna = (): ProfileRow => profileRow({ id: 'p1a2b3c4', label: 'Аня', telegramChatId: null });

  it('кнопка есть у профиля без чата и её НЕТ у привязанного', async () => {
    const h = harness({ profiles: [admin(), anna()] });

    await h.handle(textUpdate(BTN.profiles, ADMIN_CHAT));

    const datas = buttonsOf(h.calls[0]!).map((b) => b.callback_data);
    expect(datas).toContain('pw~i~p1a2b3c4');
    // admin() привязан к своему чату — приглашение ему не нужно.
    expect(datas).not.toContain('pw~i~ilya');
  });

  it('нажатие выдаёт новую ссылку, и она реально привязывает игрока', async () => {
    const h = harness({ profiles: [admin(), anna()] });

    await h.handle(callbackUpdate('pw~i~p1a2b3c4', ADMIN_CHAT));

    expect(h.createInvite).toHaveBeenCalledWith('p1a2b3c4');
    expect(lastText(h)).toContain(`https://t.me/${BOT_INFO.username}?start=inv_${OTHER_CODE}`);

    h.calls.length = 0;
    await h.handle(inviteStart(OTHER_CODE, GUEST_CHAT));
    expect(h.profiles.find((p) => p.id === 'p1a2b3c4')?.telegramChatId).toBe(String(GUEST_CHAT));
  });

  it('привязка упала ПОСЛЕ погашения кода — профиль чинится кнопкой, а не SQL', async () => {
    // Регрессия на дыру между claim и upsert: код сгорел, привязки нет. Без
    // перевыпуска такой профиль остался бы недоступным навсегда.
    const h = harness({ profiles: [admin(), anna()], invites: { [CODE]: { profileId: 'p1a2b3c4', used: false } } });
    h.upsert.mockRejectedValueOnce(new Error('PostgREST 500'));

    await h.handle(inviteStart(CODE, GUEST_CHAT));
    expect(h.calls).toEqual([]); // игроку — тишина, как и положено
    expect(h.invites.get(CODE)?.used).toBe(true); // код сгорел безвозвратно
    expect(h.profiles.find((p) => p.id === 'p1a2b3c4')?.telegramChatId).toBeNull();

    // Админ открывает «👤 Профили» и жмёт кнопку у непривязанного профиля.
    await h.handle(textUpdate(BTN.profiles, ADMIN_CHAT));
    const button = buttonsOf(h.calls.at(-1)!).find((b) => b.callback_data === 'pw~i~p1a2b3c4');
    expect(button, 'у непривязанного профиля обязана быть кнопка перевыпуска').toBeDefined();
    await h.handle(callbackUpdate(button!.callback_data!, ADMIN_CHAT));

    // Новая ссылка работает — игрок заходит по ней.
    await h.handle(inviteStart(OTHER_CODE, GUEST_CHAT));
    expect(h.profiles.find((p) => p.id === 'p1a2b3c4')?.telegramChatId).toBe(String(GUEST_CHAT));
  });

  it('профилю с уже привязанным чатом код не выпускается', async () => {
    // Кнопки у такого профиля нет, но сообщение со списком живёт в истории:
    // нажатая из прошлого экрана кнопка не должна плодить живые коды.
    const taken = profileRow({ id: 'p1a2b3c4', label: 'Аня', telegramChatId: String(GUEST_CHAT) });
    const h = harness({ profiles: [admin(), taken] });

    await h.handle(callbackUpdate('pw~i~p1a2b3c4', ADMIN_CHAT));

    expect(h.createInvite).not.toHaveBeenCalled();
    expect(lastText(h)).toContain('уже привязан');
  });

  it('кнопка из старого сообщения на удалённый профиль — понятный отказ', async () => {
    const h = harness({ profiles: [admin()] });

    await h.handle(callbackUpdate('pw~i~p1a2b3c4', ADMIN_CHAT));

    expect(h.createInvite).not.toHaveBeenCalled();
    expect(lastText(h)).toContain('больше нет');
  });

  it('не-админ кода не получает, чужой чат — полная тишина', async () => {
    const notAdmin = harness({ profiles: [profileRow({ isAdmin: false }), anna()] });
    await notAdmin.handle(callbackUpdate('pw~i~p1a2b3c4', ADMIN_CHAT));
    expect(notAdmin.createInvite).not.toHaveBeenCalled();
    expect(notAdmin.calls.map((c) => c.method)).toEqual(['answerCallbackQuery']);

    const stranger = harness({ profiles: [admin(), anna()] });
    await stranger.handle(callbackUpdate('pw~i~p1a2b3c4', STRANGER_CHAT));
    expect(stranger.createInvite).not.toHaveBeenCalled();
    expect(stranger.calls).toEqual([]);
  });
});

describe('мастер профиля: доступ только у админа', () => {
  it('не-админ не получает ни кнопки, ни ответа на её callback_data', async () => {
    const h = harness({ profiles: [profileRow({ isAdmin: false })] });

    await h.handle(textUpdate(BTN.profiles, ADMIN_CHAT));
    expect(h.calls).toEqual([]);

    // Подделанная кнопка: спиннер гасим, но мастер не открываем.
    await h.handle(callbackUpdate('pw~n', ADMIN_CHAT));
    expect(h.calls.map((c) => c.method)).toEqual(['answerCallbackQuery']);
  });

  it('не-админ не может создать профиль подделанной кнопкой «Создать»', async () => {
    const h = harness({ profiles: [profileRow({ isAdmin: false })] });

    await h.handle(callbackUpdate('pw~y', ADMIN_CHAT));

    expect(h.upsert).not.toHaveBeenCalled();
    expect(h.createInvite).not.toHaveBeenCalled();
    expect(h.calls.map((c) => c.method)).toEqual(['answerCallbackQuery']);
  });

  it('кнопки мастера от чужого чата — полная тишина', async () => {
    const h = harness({ profiles: [admin()] });

    await h.handle(callbackUpdate('pw~n', STRANGER_CHAT));
    await h.handle(callbackUpdate('pw~y', STRANGER_CHAT));

    expect(h.calls).toEqual([]);
  });

  it('разжалованный админ не дописывает свой мастер', async () => {
    // Черновик живёт в памяти и переживает снятие флага в базе; ввод по нему
    // после разжалования принимать нельзя.
    const profile = admin();
    const h = harness({ profiles: [profile] });

    await h.handle(callbackUpdate('pw~n', ADMIN_CHAT));
    profile.isAdmin = false;
    h.calls.length = 0;

    await h.handle(textUpdate('Аня', ADMIN_CHAT));

    expect(h.calls).toEqual([]);
  });
});
