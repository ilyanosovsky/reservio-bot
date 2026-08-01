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
import { RULE_MODE_LABEL } from '../src/bot/format.js';
import type { ProfileRow, ScheduleRuleInput, ScheduleRuleRow } from '../src/core/repos.js';

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

interface ScheduleMocks {
  listByProfile: ReturnType<typeof vi.fn>;
  upsert: ReturnType<typeof vi.fn>;
  setEnabled: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
}

interface BotHarness {
  calls: ApiCall[];
  deps: BotDeps;
  listBookings: ReturnType<typeof vi.fn>;
  list: ReturnType<typeof vi.fn>;
  upsert: ReturnType<typeof vi.fn>;
  schedules: ScheduleMocks;
  handle(update: Update): Promise<void>;
}

/** Бот, собранный ровно как в проде (installBot), но с фейковыми зависимостями. */
function harness(profile: ProfileRow | null, rules: ScheduleRuleRow[] = []): BotHarness {
  const { api, calls } = recordingApi();
  const listBookings = vi.fn(async () => []);
  const list = vi.fn(async () => (profile === null ? [] : [profile]));
  const upsert = vi.fn(async () => {});
  const schedules: ScheduleMocks = {
    listByProfile: vi.fn(async () => rules),
    upsert: vi.fn(async () => {}),
    setEnabled: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
  };
  const deps = {
    profiles: { getByChatId: vi.fn(async () => profile), getById: vi.fn(async () => null), list, upsert },
    schedules,
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
    schedules,
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

/** Нажатие inline-кнопки: сообщение мастера, к которому она прикреплена, уже в чате. */
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

describe('installBot: диспетчер callback-кнопок', () => {
  // Кнопка «⬅️ Назад» первого шага проходит весь путь: parse → switch → хендлер.
  // Без этого теста выпавший case выглядел бы нормально (спиннер гаснет), но
  // экран не перерисовывался бы — молчаливый провал, худший баг проекта.

  it('«Назад» мастера «Слоты» гасит спиннер И перерисовывает ТО ЖЕ сообщение', async () => {
    const h = harness(profileRow());

    await h.handle(callbackUpdate('sl~b', OWNER_CHAT));

    expect(h.calls.map((c) => c.method)).toEqual(['answerCallbackQuery', 'editMessageText']);
    const editCall = h.calls[1]!;
    expect(editCall.payload['text']).toContain('Слоты');
    expect(editCall.payload['text']).toContain('выбери дату');
    // Новое сообщение не шлём: sendMessage в списке вызовов отсутствует.
    expect(h.calls.some((c) => c.method === 'sendMessage')).toBe(false);
  });

  it('«Назад» мастера «Бронировать» перерисовывает своё сообщение', async () => {
    const h = harness(profileRow());

    await h.handle(callbackUpdate('bk~b', OWNER_CHAT));

    expect(h.calls.map((c) => c.method)).toEqual(['answerCallbackQuery', 'editMessageText']);
    expect(h.calls[1]!.payload['text']).toContain('Бронь');
  });

  it('неизвестная кнопка — только гашение спиннера, без сообщений в чат', async () => {
    const h = harness(profileRow());

    await h.handle(callbackUpdate('нечто~непонятное', OWNER_CHAT));

    expect(h.calls.map((c) => c.method)).toEqual(['answerCallbackQuery']);
  });

  it('кнопка от чужого чата — полная тишина', async () => {
    const h = harness(null);

    await h.handle(callbackUpdate('bk~b', STRANGER_CHAT));

    expect(h.calls).toEqual([]);
  });
});

describe('installBot: конструктор расписаний', () => {
  // Кнопки мастера проходят весь путь: parse → switch диспетчера → хендлер.
  // Выпавший case выглядел бы нормально (спиннер гаснет), но экран не менялся
  // бы — молчаливый провал, худший баг проекта (CLAUDE.md).

  const scheduleRule = (over: Partial<ScheduleRuleRow> = {}): ScheduleRuleRow => ({
    id: 'r-1',
    profileId: 'ilya',
    times: ['20:00', '21:00'],
    courts: ['Padel Court 3'],
    daysOfWeek: null,
    enabled: true,
    mode: 'priority',
    label: 'Вечер',
    ...over,
  });

  /** Кнопки последнего исходящего сообщения — по ним видно, что предлагает экран. */
  function buttonsOf(call: ApiCall): { text: string; callback_data?: string }[] {
    const markup = call.payload['reply_markup'] as { inline_keyboard?: { text: string; callback_data?: string }[][] };
    return (markup?.inline_keyboard ?? []).flat();
  }

  it('список сценариев предлагает правку, удаление и нового', async () => {
    const h = harness(profileRow(), [scheduleRule()]);

    await h.handle(textUpdate(BTN.schedule, OWNER_CHAT));

    const send = h.calls[0]!;
    expect(send.method).toBe('sendMessage');
    expect(send.payload['text']).toContain('Вечер');
    expect(buttonsOf(send).map((b) => b.callback_data)).toEqual([
      'rule~r-1',
      'rw~ed~r-1',
      'rw~rm~r-1',
      'rw~d~0~0~0~p~',
    ]);
  });

  it('«➕ Новый сценарий» открывает шаг 1 правкой того же сообщения', async () => {
    const h = harness(profileRow());

    await h.handle(callbackUpdate('rw~d~0~0~0~p~', OWNER_CHAT));

    expect(h.calls.map((c) => c.method)).toEqual(['answerCallbackQuery', 'editMessageText']);
    const text = h.calls[1]!.payload['text'] as string;
    expect(text).toContain('шаг 1/5');
    expect(text).toContain('выбери дни недели');
    expect(h.calls.some((c) => c.method === 'sendMessage')).toBe(false);
  });

  it('галочка дня перерисовывает шаг с уже переключённым битом', async () => {
    const h = harness(profileRow());

    // пн = бит 1 -> маска 2
    await h.handle(callbackUpdate('rw~d~2~0~0~p~', OWNER_CHAT));

    const edit = h.calls[1]!;
    expect(edit.payload['text']).toContain('Отмечено: пн');
    // Повторный тап по «пн» обязан снимать галочку: кнопка несёт маску 0.
    expect(buttonsOf(edit).map((b) => b.callback_data)).toContain('rw~d~0~0~0~p~');
  });

  it('«Готово» с пустым выбором не пускает дальше и говорит почему', async () => {
    const h = harness(profileRow());

    await h.handle(callbackUpdate('rw~t~0~0~0~p~', OWNER_CHAT));

    expect(h.calls[0]!.method).toBe('answerCallbackQuery');
    expect(h.calls[0]!.payload['text']).toContain('хотя бы один день');
    expect(h.calls[1]!.payload['text']).toContain('шаг 1/5');
  });

  it('сохранение нового сценария пишет в репозиторий ровно выбранное', async () => {
    const h = harness(profileRow());

    // дни 7f = каждый день, времена 0x300000 = 20:00 и 21:00, корты 4 = Padel Court 3
    await h.handle(callbackUpdate('rw~s~7f~300000~4~a~', OWNER_CHAT));

    expect(h.schedules.upsert).toHaveBeenCalledTimes(1);
    expect(h.schedules.upsert.mock.calls[0]?.[0]).toEqual({
      profileId: 'ilya',
      times: ['20:00', '21:00'],
      courts: ['Padel Court 3'],
      daysOfWeek: null,
      mode: 'all',
      // Автоимя в колонку НЕ пишется: оно производная от времён и кортов, и
      // после правки список показывал бы старую подпись (ruleTitle сам
      // подставит «20:00+21:00 · C3», пока имя не задано человеком).
      label: '',
      enabled: true,
    });
    const last = h.calls[h.calls.length - 1]!;
    expect(last.payload['text']).toContain('создан');
    // В сообщении имя всё-таки есть — автоимя, посчитанное по свежему содержимому.
    expect(last.payload['text']).toContain('20:00+21:00 · C3');
  });

  it('повторный тап «Сохранить» не плодит близнеца — обновляется тот же сценарий', async () => {
    // Кнопка мастера stateless: у нового сценария id в callback_data пустой,
    // поэтому второй тап (сеть подтормозила) уходил бы во второй INSERT. Два
    // одинаковых включённых сценария = два pre-drop сообщения и лишний ран.
    const saved: ScheduleRuleRow[] = [];
    const h = harness(profileRow(), saved);
    // Фейковый репозиторий ведёт себя как настоящий upsert: с id — обновление.
    h.schedules.upsert.mockImplementation(async (input: ScheduleRuleInput) => {
      const row = { ...input, id: input.id ?? 'r-new' } as ScheduleRuleRow;
      const at = saved.findIndex((r) => r.id === row.id);
      if (at < 0) saved.push(row);
      else saved[at] = row;
    });

    await h.handle(callbackUpdate('rw~s~7f~300000~4~a~', OWNER_CHAT));
    await h.handle(callbackUpdate('rw~s~7f~300000~4~a~', OWNER_CHAT));

    expect(h.schedules.upsert).toHaveBeenCalledTimes(2);
    // Второй вызов — обновление найденного близнеца, а не вставка.
    expect(h.schedules.upsert.mock.calls[0]?.[0]).not.toHaveProperty('id');
    expect(h.schedules.upsert.mock.calls[1]?.[0]).toMatchObject({ id: 'r-new' });
    expect(saved).toHaveLength(1);
  });

  it('правка обновляет подпись сценария: список показывает новые времена и корты', async () => {
    // Сохранённое автоимя заморозило бы старую подпись, и владелец выключал бы
    // не тот сценарий — он тапает по названию.
    const rules: ScheduleRuleRow[] = [scheduleRule({ label: '', times: ['20:00'], courts: ['Padel Court 3'] })];
    const h = harness(profileRow(), rules);
    h.schedules.upsert.mockImplementation(async (input: ScheduleRuleInput) => {
      rules[0] = { ...(rules[0] as ScheduleRuleRow), ...input };
    });

    // времена 0x180000 = 19:00 и 20:00, корты 8 = Padel Court 4
    await h.handle(callbackUpdate('rw~s~7f~180000~8~p~r-1', OWNER_CHAT));

    expect(h.schedules.upsert.mock.calls[0]?.[0]).toMatchObject({ id: 'r-1', label: '' });
    const last = h.calls[h.calls.length - 1]!;
    expect(last.payload['text']).toContain('19:00+20:00 · C4');
    expect(last.payload['text']).not.toContain('20:00 · C3');
  });

  it('правка сохраняет id, вкл/выкл, имя и порядок приоритета кортов', async () => {
    // Корты правимого сценария C3→C1, галочки те же: битмаска отдала бы их как
    // C1,C3 и молча перевернула приоритет.
    const h = harness(profileRow(), [
      scheduleRule({ enabled: false, courts: ['Padel Court 3', 'Padel Court 1'] }),
    ]);

    // корты 5 = биты 0 и 2 = Padel Court 1 и Padel Court 3
    await h.handle(callbackUpdate('rw~s~7f~300000~5~p~r-1', OWNER_CHAT));

    expect(h.schedules.upsert.mock.calls[0]?.[0]).toMatchObject({
      id: 'r-1',
      enabled: false,
      label: 'Вечер',
      courts: ['Padel Court 3', 'Padel Court 1'],
    });
    expect(h.calls[h.calls.length - 1]!.payload['text']).toContain('обновлён');
  });

  it('чужой id сценария не переписывается, даже если приехал в кнопке', async () => {
    const h = harness(profileRow(), [scheduleRule()]);

    await h.handle(callbackUpdate('rw~s~7f~300000~4~p~r-999', OWNER_CHAT));

    expect(h.schedules.upsert).not.toHaveBeenCalled();
    expect(h.calls[h.calls.length - 1]!.payload['text']).toContain('нет');
  });

  it('час вне 07:00–23:00 из /add_rule можно снять: мастер рисует для него кнопку', async () => {
    // Регрессия: кнопок мастер рисовал только 07:00–23:00, поэтому отмеченный
    // 06:00 нельзя было снять — правка молча возвращала его в базу, и профиль
    // каждый день получал ❌-отчёт по бессмысленному дропу в 05:57.
    const h = harness(profileRow(), [scheduleRule({ times: ['06:00', '20:00'] })]);

    await h.handle(callbackUpdate('rw~ed~r-1', OWNER_CHAT));

    const screen = h.calls.filter((c) => c.method === 'editMessageText').at(-1)!;
    // Шаг 1 (дни) → «Готово» ведёт на шаг времён; жмём его, как человек.
    const done = buttonsOf(screen).find((b) => b.text.includes('Готово'))!;
    await h.handle(callbackUpdate(done.callback_data!, OWNER_CHAT));

    const times = h.calls.filter((c) => c.method === 'editMessageText').at(-1)!;
    expect(times.payload['text']).toContain('06:00');
    const six = buttonsOf(times).find((b) => b.text.includes('06:00'));
    expect(six, 'кнопка 06:00 обязана быть на экране').toBeDefined();
    // Тап по ней снимает бит: в callback_data остаётся только 20:00 (0x100000).
    expect(six!.callback_data).toContain('~100000~');
  });

  it('выключение и удаление сценария честно предупреждают про «⏭ Скип»', async () => {
    // Дроп, поставленный планировщиком в 20:30, эти кнопки не отменяют:
    // book-slot-drop перечитывает только скипы.
    const h = harness(profileRow(), [scheduleRule()]);

    await h.handle(callbackUpdate('rule~r-1', OWNER_CHAT));
    expect(h.calls[1]!.payload['text']).toContain('Скип');

    await h.handle(callbackUpdate('rw~rm~r-1', OWNER_CHAT));
    expect(h.calls.at(-1)!.payload['text']).toContain('Скип');
  });

  it('удаление спрашивает подтверждение и только потом трогает базу', async () => {
    const h = harness(profileRow(), [scheduleRule()]);

    await h.handle(callbackUpdate('rw~rm~r-1', OWNER_CHAT));
    expect(h.schedules.remove).not.toHaveBeenCalled();
    expect(h.calls[1]!.payload['text']).toContain('Удалить сценарий?');
    expect(buttonsOf(h.calls[1]!).map((b) => b.callback_data)).toEqual(['rw~ok~r-1', 'rw~l']);

    await h.handle(callbackUpdate('rw~ok~r-1', OWNER_CHAT));
    expect(h.schedules.remove).toHaveBeenCalledWith('r-1', 'ilya');
  });

  it('удаление чужого id до базы не доходит', async () => {
    const h = harness(profileRow(), [scheduleRule()]);

    await h.handle(callbackUpdate('rw~ok~r-999', OWNER_CHAT));

    expect(h.schedules.remove).not.toHaveBeenCalled();
  });

  it('тумблер сценария переключает enabled и перерисовывает список', async () => {
    const h = harness(profileRow(), [scheduleRule()]);

    await h.handle(callbackUpdate('rule~r-1', OWNER_CHAT));

    expect(h.schedules.setEnabled).toHaveBeenCalledWith('r-1', false);
    expect(h.calls[0]!.method).toBe('answerCallbackQuery');
    expect(h.calls[1]!.payload['text']).toContain('⛔');
  });

  it('«Назад» с первого шага возвращает к списку сценариев', async () => {
    const h = harness(profileRow(), [scheduleRule()]);

    await h.handle(callbackUpdate('rw~l', OWNER_CHAT));

    expect(h.calls.map((c) => c.method)).toEqual(['answerCallbackQuery', 'editMessageText']);
    expect(h.calls[1]!.payload['text']).toContain('Вечер');
  });

  it('весь мастер проходится по кнопкам, которые бот рисует сам', async () => {
    // Самый ценный тест конструктора: он не подсовывает callback_data руками, а
    // жмёт ровно то, что видит человек. Разъехавшиеся кодировщик и разборщик
    // (или потерянный case диспетчера) обрывают проход на первом же шаге.
    const h = harness(profileRow());
    const lastEdit = (): ApiCall => h.calls.filter((c) => c.method === 'editMessageText').at(-1)!;
    const click = async (match: string): Promise<void> => {
      const button = buttonsOf(lastEdit()).find((b) => b.text.includes(match));
      expect(button, `кнопка «${match}» на экране: ${JSON.stringify(buttonsOf(lastEdit()))}`).toBeDefined();
      await h.handle(callbackUpdate(button!.callback_data!, OWNER_CHAT));
    };

    await h.handle(textUpdate(BTN.schedule, OWNER_CHAT));
    const start = buttonsOf(h.calls[0]!).find((b) => b.text.includes('Новый сценарий'))!;
    await h.handle(callbackUpdate(start.callback_data!, OWNER_CHAT));

    await click('пн');
    await click('Готово');
    await click('20:00');
    await click('21:00');
    await click('Готово');
    await click('Padel Court 3');
    await click('Готово');
    await click(RULE_MODE_LABEL.all);
    expect(lastEdit().payload['text']).toContain('шаг 5/5');
    await click('Сохранить');

    expect(h.schedules.upsert).toHaveBeenCalledTimes(1);
    expect(h.schedules.upsert.mock.calls[0]?.[0]).toMatchObject({
      profileId: 'ilya',
      times: ['20:00', '21:00'],
      courts: ['Padel Court 3'],
      daysOfWeek: [1],
      mode: 'all',
    });
  });

  it('«Назад» с любого шага возвращает на предыдущий, не теряя выбранное', async () => {
    const h = harness(profileRow());
    const lastEdit = (): ApiCall => h.calls.filter((c) => c.method === 'editMessageText').at(-1)!;

    // Шаг кортов с уже выбранными днями (пн) и временами (20:00).
    await h.handle(callbackUpdate('rw~c~2~100000~0~p~', OWNER_CHAT));
    const back = buttonsOf(lastEdit()).find((b) => b.text.includes('Назад'))!;
    expect(back.callback_data).toBe('rw~t~2~100000~0~p~');

    await h.handle(callbackUpdate(back.callback_data!, OWNER_CHAT));
    const text = lastEdit().payload['text'] as string;
    expect(text).toContain('шаг 2/5');
    expect(text).toContain('пн');
    expect(text).toContain('20:00');
  });

  it('кнопка мастера от чужого чата — полная тишина', async () => {
    const h = harness(null);

    await h.handle(callbackUpdate('rw~s~7f~300000~4~p~', STRANGER_CHAT));

    expect(h.calls).toEqual([]);
    expect(h.schedules.upsert).not.toHaveBeenCalled();
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
