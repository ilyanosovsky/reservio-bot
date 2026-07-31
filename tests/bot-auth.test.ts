// Тесты авторизации бота: authMiddleware, adminOnly и — главное — собранный
// бот целиком (src/bot/setup.ts).
//
// Зачем сборка, а не только юниты: инвариант «чужому чату бот не отвечает
// НИЧЕГО» держится на порядке регистрации (auth раньше хендлеров). Порядок
// нельзя проверить, вызывая middleware по отдельности, поэтому здесь поднимается
// настоящий grammY-Composer с настоящим Context, а Bot API подменён
// трансформером: любой исходящий вызов записывается и никуда не летит.
//
// Второй проверяемый инвариант — апдейт из ГРУППЫ игнорируется, даже если id
// группы лежит в profiles.telegram_chat_id (с фазы 2 туда вполне мог попасть
// адрес групповых отчётов: scripts/seed-profiles.ts кладёт TELEGRAM_CHAT_ID).
// Иначе любой участник группы получил бы права владельца, включая админские.

import { describe, expect, it, vi } from 'vitest';
import { Api, Composer, Context, type Transformer } from 'grammy';
import type { Update, UserFromGetMe } from 'grammy/types';
import { adminOnly, authMiddleware } from '../src/bot/auth.js';
import type { BotContext, BotDeps } from '../src/bot/context.js';
import { installBot } from '../src/bot/setup.js';
import { BTN } from '../src/bot/menu.js';
import type { ProfileRow } from '../src/core/repos.js';

const OWNER_CHAT = 424242;
const STRANGER_CHAT = 777001;
/** id группы (всегда отрицательный) — ровно тот вид, что уходит в TELEGRAM_CHAT_ID. */
const GROUP_CHAT = -1001234567890;

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

// ---------------------------- authMiddleware ----------------------------

interface FakeCtxInit {
  chatId?: number;
  chatType?: 'private' | 'group' | 'supergroup';
  fromId?: number;
}

/** Контекст-заглушка: middleware читает только chat/from и пишет state. */
function fakeCtx(init: FakeCtxInit = {}): BotContext {
  const { chatId = OWNER_CHAT, chatType = 'private', fromId } = init;
  return {
    chat: chatId === undefined ? undefined : { id: chatId, type: chatType },
    from: { id: fromId ?? chatId },
  } as unknown as BotContext;
}

describe('authMiddleware', () => {
  it('чат из allowlist — профиль кладётся в state, апдейт идёт дальше', async () => {
    const row = profileRow();
    const getByChatId = vi.fn(async () => row);
    const next = vi.fn(async () => {});
    const ctx = fakeCtx();

    await authMiddleware({ getByChatId })(ctx, next);

    expect(getByChatId).toHaveBeenCalledWith(String(OWNER_CHAT));
    expect(next).toHaveBeenCalledTimes(1);
    expect(ctx.state.profile).toBe(row);
  });

  it('чужой чат — next НЕ вызывается и state не появляется', async () => {
    const next = vi.fn(async () => {});
    const ctx = fakeCtx({ chatId: STRANGER_CHAT });

    await authMiddleware({ getByChatId: vi.fn(async () => null) })(ctx, next);

    expect(next).not.toHaveBeenCalled();
    expect(ctx.state).toBeUndefined();
  });

  it('апдейт из группы отбрасывается ДО обращения к allowlist', async () => {
    // Даже если id группы записан в profiles (адрес отчётов с фазы 2), под ним
    // пишет любой её участник — это не удостоверение личности.
    const getByChatId = vi.fn(async () => profileRow({ telegramChatId: String(GROUP_CHAT) }));
    const next = vi.fn(async () => {});

    await authMiddleware({ getByChatId })(fakeCtx({ chatId: GROUP_CHAT, chatType: 'supergroup' }), next);

    expect(getByChatId).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it('allowlist недоступен — fail-closed: молчим, дальше не пускаем', async () => {
    const next = vi.fn(async () => {});
    const debug = vi.fn();

    await authMiddleware(
      {
        getByChatId: vi.fn(async () => {
          throw new Error('PostgREST 500');
        }),
      },
      { debug },
    )(fakeCtx(), next);

    expect(next).not.toHaveBeenCalled();
    expect(debug.mock.calls.join(' ')).toContain('allowlist недоступен');
  });

  it('chat_id чужого не попадает в лог без exposeChatId', async () => {
    const debug = vi.fn();
    const auth = authMiddleware({ getByChatId: vi.fn(async () => null) }, { debug });

    await auth(fakeCtx({ chatId: STRANGER_CHAT }), vi.fn(async () => {}));

    expect(debug).toHaveBeenCalled();
    expect(debug.mock.calls.join(' ')).not.toContain(String(STRANGER_CHAT));
  });

  it('exposeChatId=true — chat_id в логе есть (локальная отладка)', async () => {
    const debug = vi.fn();
    const auth = authMiddleware({ getByChatId: vi.fn(async () => null) }, { debug, exposeChatId: true });

    await auth(fakeCtx({ chatId: STRANGER_CHAT }), vi.fn(async () => {}));

    expect(debug.mock.calls.join(' ')).toContain(String(STRANGER_CHAT));
  });
});

describe('adminOnly', () => {
  const next = (): ReturnType<typeof vi.fn<() => Promise<void>>> => vi.fn<() => Promise<void>>(async () => {});

  it('админа пропускает', async () => {
    const n = next();
    const ctx = { state: { profile: profileRow({ isAdmin: true }) } } as unknown as BotContext;

    await adminOnly()(ctx, n);

    expect(n).toHaveBeenCalledTimes(1);
  });

  it('не-админа не пропускает и ничего ему не отвечает', async () => {
    const n = next();
    const ctx = { state: { profile: profileRow({ isAdmin: false }) } } as unknown as BotContext;

    await adminOnly()(ctx, n);

    expect(n).not.toHaveBeenCalled();
  });

  it('профиля нет вовсе — тоже не пропускает (fail-closed)', async () => {
    const n = next();
    await adminOnly()({} as unknown as BotContext, n);
    expect(n).not.toHaveBeenCalled();
  });
});

// ------------------------- собранный бот (installBot) -------------------------

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

/** Api, которая никуда не ходит: трансформер записывает вызов и отвечает «ок». */
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

interface BotHarness {
  calls: ApiCall[];
  deps: BotDeps;
  listBookings: ReturnType<typeof vi.fn>;
  list: ReturnType<typeof vi.fn>;
  upsert: ReturnType<typeof vi.fn>;
  handle(update: Update): Promise<void>;
}

/** Бот, собранный ровно как в проде (installBot), но с фейковыми зависимостями. */
function harness(profile: ProfileRow | null): BotHarness {
  const { api, calls } = recordingApi();
  const listBookings = vi.fn(async () => []);
  const list = vi.fn(async () => (profile === null ? [] : [profile]));
  const upsert = vi.fn(async () => {});
  const deps = {
    profiles: { getByChatId: vi.fn(async () => profile), getById: vi.fn(async () => null), list, upsert },
    schedules: { listByProfile: vi.fn(async () => []), upsert: vi.fn(async () => {}) },
    skips: { listUpcoming: vi.fn(async () => []), add: vi.fn(async () => {}), remove: vi.fn(async () => {}) },
    state: { listBookings },
    client: {},
    bookNow: vi.fn(),
    log: (): void => {},
  } as unknown as BotDeps;

  const bot = new Composer<BotContext>();
  installBot(bot, deps);
  const middleware = bot.middleware();

  return {
    calls,
    deps,
    listBookings,
    list,
    upsert,
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

describe('installBot: чужому чату — полная тишина', () => {
  it('кнопка меню от чата вне allowlist не порождает ни одного вызова Bot API', async () => {
    const h = harness(null);

    await h.handle(textUpdate(BTN.bookings, STRANGER_CHAT));

    expect(h.calls).toEqual([]);
    expect(h.listBookings).not.toHaveBeenCalled();
  });

  it('/start от чужого чата — тоже тишина', async () => {
    const h = harness(null);

    await h.handle(commandUpdate('/start', STRANGER_CHAT));

    expect(h.calls).toEqual([]);
  });

  it('свой чат ответ получает — проверка не вакуумная', async () => {
    const h = harness(profileRow());

    await h.handle(textUpdate(BTN.bookings, OWNER_CHAT));

    expect(h.calls.map((c) => c.method)).toEqual(['sendMessage']);
    expect(h.listBookings).toHaveBeenCalledWith('ilya');
  });

  it('группа с id владельца в allowlist — молчим (id группы это не человек)', async () => {
    // Сид кладёт TELEGRAM_CHAT_ID в profiles, а там с фазы 2 может стоять группа
    // отчётов: без этой проверки её участники получили бы права владельца.
    const h = harness(profileRow({ telegramChatId: String(GROUP_CHAT), isAdmin: true }));

    await h.handle(textUpdate(BTN.cancel, GROUP_CHAT, 'supergroup'));
    await h.handle(
      commandUpdate('/add_profile anna;Аня;Anna;anna@example.com;+995555111222;900112233', GROUP_CHAT, 'supergroup'),
    );

    expect(h.calls).toEqual([]);
    expect(h.upsert).not.toHaveBeenCalled();
  });
});

describe('installBot: админский гейт', () => {
  it('не-админ не получает ни списка профилей, ни ответа на /add_profile', async () => {
    const h = harness(profileRow({ isAdmin: false }));

    await h.handle(textUpdate(BTN.profiles, OWNER_CHAT));
    await h.handle(commandUpdate('/add_profile anna;Аня;Anna;anna@example.com;+995555111222;900112233', OWNER_CHAT));
    await h.handle(commandUpdate('/add_rule anna;20:00;Padel Court 3', OWNER_CHAT));

    expect(h.calls).toEqual([]);
    expect(h.list).not.toHaveBeenCalled();
    expect(h.upsert).not.toHaveBeenCalled();
  });

  it('админ те же команды выполняет', async () => {
    const h = harness(profileRow({ isAdmin: true }));

    await h.handle(textUpdate(BTN.profiles, OWNER_CHAT));
    await h.handle(commandUpdate('/add_profile anna;Аня;Anna;anna@example.com;+995555111222;900112233', OWNER_CHAT));

    expect(h.calls.map((c) => c.method)).toEqual(['sendMessage', 'sendMessage']);
    expect(h.list).toHaveBeenCalledTimes(1);
    expect(h.upsert).toHaveBeenCalledTimes(1);
  });
});
