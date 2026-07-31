// Тесты репозиториев бота (profiles / schedule_rules / skips / settings).
// Никаких сетевых запросов: fetch всегда замокан, к реальному Supabase тесты
// не ходят (и не должны — ключа в CI нет). Проверяем то, что не ловится
// типами: форму запроса к PostgREST (эндпоинт, фильтры, on_conflict, Prefer),
// маппинг snake_case <-> camelCase, поведение на кривой схеме, понятные ошибки
// и то, что service-ключ не утекает наружу.

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ProfilesRepo,
  SchedulesRepo,
  SettingsRepo,
  SkipsRepo,
  SupabaseRepoError,
  type ProfileRow,
} from '../src/core/repos.js';

const URL_BASE = 'https://kbwmrqoxjlydmwyxirqm.supabase.co';
const KEY = 'sb_secret_TESTKEY_do_not_leak';

const PROFILE_SELECT = 'id,label,name,email,phone,telegram_chat_id,is_admin';
const RULE_SELECT = 'id,profile_id,times,courts,days_of_week,enabled';

function profileRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'ilya',
    label: 'Илья',
    name: 'Ilya N',
    email: 'ilya@example.com',
    phone: '+995500000000',
    telegram_chat_id: '111222333',
    is_admin: true,
    ...overrides,
  };
}

function profile(overrides: Partial<ProfileRow> = {}): ProfileRow {
  return {
    id: 'ilya',
    label: 'Илья',
    name: 'Ilya N',
    email: 'ilya@example.com',
    phone: '+995500000000',
    telegramChatId: '111222333',
    isAdmin: true,
    ...overrides,
  };
}

function ruleRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '8b0f2f38-0c1b-4a1f-9a2e-2f4e0f7a1c11',
    profile_id: 'ilya',
    times: ['20:00', '21:00'],
    courts: ['Padel Court 3', 'Padel Court 2'],
    days_of_week: null,
    enabled: true,
    ...overrides,
  };
}

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
  params: URLSearchParams;
  path: string;
}

/** Мок fetch: отдаёт заготовленные ответы по очереди, пишет все вызовы. */
function fetchStub(...responses: Array<Response | (() => Response)>) {
  const calls: Call[] = [];
  let i = 0;
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const href = String(url);
    calls.push({
      url: href,
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
      params: new URL(href).searchParams,
      path: new URL(href).pathname,
    });
    const next = responses[Math.min(i, responses.length - 1)];
    i += 1;
    return typeof next === 'function' ? next() : next;
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const opts = (fn: typeof fetch, url = URL_BASE) => ({ url, serviceKey: KEY, fetchFn: fn });

/** Ошибка отвергнутого промиса; успешное завершение — сам провал теста. */
function rejection(p: Promise<unknown>): Promise<Error> {
  return p.then(
    () => {
      throw new Error('ожидалась ошибка, но промис завершился успешно');
    },
    (err: unknown) => (err instanceof Error ? err : new Error(String(err))),
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('репозитории: конструктор', () => {
  it('пустой url — понятная ошибка про SUPABASE_URL', () => {
    expect(() => new ProfilesRepo({ url: '  ', serviceKey: KEY })).toThrow(/SUPABASE_URL/);
  });

  it('пустой ключ — понятная ошибка про SUPABASE_SERVICE_ROLE_KEY', () => {
    expect(() => new SchedulesRepo({ url: URL_BASE, serviceKey: '' })).toThrow(/SUPABASE_SERVICE_ROLE_KEY/);
  });

  it('каждый репозиторий ходит в свою таблицу; хвостовой слэш в url не мешает', async () => {
    const { fn, calls } = fetchStub(() => jsonRes([]));
    const o = opts(fn, `${URL_BASE}/`);
    await new ProfilesRepo(o).list();
    await new SchedulesRepo(o).listEnabled();
    await new SkipsRepo(o).isSkipped('ilya', '2026-08-06');
    await new SettingsRepo(o).get('planner_enabled');

    expect(calls.map((c) => c.path)).toEqual([
      '/rest/v1/profiles',
      '/rest/v1/schedule_rules',
      '/rest/v1/skips',
      '/rest/v1/settings',
    ]);
  });

  it('шлёт apikey и Authorization: Bearer с service-ключом', async () => {
    const { fn, calls } = fetchStub(jsonRes([]));
    await new ProfilesRepo(opts(fn)).list();

    expect(calls[0]!.headers['apikey']).toBe(KEY);
    expect(calls[0]!.headers['Authorization']).toBe(`Bearer ${KEY}`);
  });
});

describe('ProfilesRepo', () => {
  it('getByChatId: GET с eq.-фильтром по telegram_chat_id и limit=1', async () => {
    const { fn, calls } = fetchStub(jsonRes([profileRow()]));
    await new ProfilesRepo(opts(fn)).getByChatId('111222333');

    const call = calls[0]!;
    expect(call.method).toBe('GET');
    expect(call.params.get('telegram_chat_id')).toBe('eq.111222333');
    expect(call.params.get('limit')).toBe('1');
    expect(call.params.get('select')).toBe(PROFILE_SELECT);
    expect(call.body).toBeUndefined();
  });

  it('getByChatId: маппит строку в ProfileRow без потерь', async () => {
    const { fn } = fetchStub(jsonRes([profileRow()]));
    expect(await new ProfilesRepo(opts(fn)).getByChatId('111222333')).toEqual(profile());
  });

  it('getByChatId: чужой чат -> null (бот промолчит)', async () => {
    const { fn } = fetchStub(jsonRes([]));
    expect(await new ProfilesRepo(opts(fn)).getByChatId('999')).toBeNull();
  });

  it('getByChatId: пустой chat_id -> null без запроса в сеть', async () => {
    const { fn, calls } = fetchStub(jsonRes([profileRow()]));
    expect(await new ProfilesRepo(opts(fn)).getByChatId('  ')).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('telegram_chat_id null -> telegramChatId null (профиль без доступа к боту)', async () => {
    const { fn } = fetchStub(jsonRes([profileRow({ telegram_chat_id: null })]));
    const got = await new ProfilesRepo(opts(fn)).getByChatId('111222333');
    expect(got?.telegramChatId).toBeNull();
  });

  it('is_admin: админом считается только строгое true', async () => {
    const { fn } = fetchStub(
      () => jsonRes([profileRow({ is_admin: false })]),
      () => jsonRes([profileRow({ is_admin: null })]),
      () => jsonRes([profileRow({ is_admin: 'true' })]),
    );
    const repo = new ProfilesRepo(opts(fn));

    expect((await repo.getById('ilya'))?.isAdmin).toBe(false);
    expect((await repo.getById('ilya'))?.isAdmin).toBe(false);
    // строка 'true' из кривой схемы — не админ: наименьшие права
    expect((await repo.getById('ilya'))?.isAdmin).toBe(false);
  });

  it('getById: eq. по id, limit=1', async () => {
    const { fn, calls } = fetchStub(jsonRes([profileRow()]));
    await new ProfilesRepo(opts(fn)).getById('nina');
    expect(calls[0]!.params.get('id')).toBe('eq.nina');
    expect(calls[0]!.params.get('limit')).toBe('1');
  });

  it('list: без фильтров, с сортировкой по id', async () => {
    const { fn, calls } = fetchStub(jsonRes([profileRow(), profileRow({ id: 'nina', is_admin: false })]));
    const all = await new ProfilesRepo(opts(fn)).list();

    expect(calls[0]!.params.get('order')).toBe('id.asc');
    expect(calls[0]!.params.has('id')).toBe(false);
    expect(all).toHaveLength(2);
    expect(all[1]!.id).toBe('nina');
    expect(all[1]!.isAdmin).toBe(false);
  });

  it('upsert: POST с on_conflict=id и Prefer merge-duplicates+representation', async () => {
    const { fn, calls } = fetchStub(jsonRes([profileRow()], 201));
    await new ProfilesRepo(opts(fn)).upsert(profile());

    const call = calls[0]!;
    expect(call.method).toBe('POST');
    expect(call.params.get('on_conflict')).toBe('id');
    expect(call.headers['Prefer']).toContain('resolution=merge-duplicates');
    expect(call.headers['Prefer']).toContain('return=representation');
    expect(call.headers['Content-Type']).toBe('application/json');
  });

  it('upsert: тело — snake_case, без camelCase и без created_at', async () => {
    const { fn, calls } = fetchStub(jsonRes([profileRow()], 201));
    await new ProfilesRepo(opts(fn)).upsert(profile());

    expect(calls[0]!.body).toEqual(profileRow());
    const keys = Object.keys(calls[0]!.body as object);
    expect(keys).not.toContain('telegramChatId');
    expect(keys).not.toContain('isAdmin');
    // created_at не шлём: на вставке его ставит default, при обновлении он должен уцелеть
    expect(keys).not.toContain('created_at');
  });

  it('upsert: 2xx без строки в ответе — не считается успехом', async () => {
    const { fn } = fetchStub(jsonRes([], 201));
    await expect(new ProfilesRepo(opts(fn)).upsert(profile())).rejects.toThrow(/не подтверждена/);
  });

  it('upsert: занятый chat_id (23505) -> человеческая ошибка, а не текст Postgres', async () => {
    const { fn } = fetchStub(
      jsonRes({ code: '23505', message: 'duplicate key value violates unique constraint' }, 409),
    );
    const err = await rejection(new ProfilesRepo(opts(fn)).upsert(profile()));
    expect(err.message).toMatch(/chat_id уже привязан/);
    expect((err as SupabaseRepoError).code).toBe('23505');
  });

  it('битая колонка -> ошибка про разъехавшуюся схему со ссылкой на миграцию', async () => {
    const { fn } = fetchStub(jsonRes([profileRow({ email: 42 })]));
    await expect(new ProfilesRepo(opts(fn)).list()).rejects.toThrow(
      /email.*20260731110000_bot_core\.sql/s,
    );
  });
});

describe('SchedulesRepo', () => {
  it('listByProfile: фильтр по profile_id и стабильный порядок', async () => {
    const { fn, calls } = fetchStub(jsonRes([ruleRow()]));
    await new SchedulesRepo(opts(fn)).listByProfile('ilya');

    expect(calls[0]!.params.get('profile_id')).toBe('eq.ilya');
    expect(calls[0]!.params.get('select')).toBe(RULE_SELECT);
    expect(calls[0]!.params.get('order')).toBe('created_at.asc,id.asc');
  });

  it('маппит jsonb-колонки в массивы, days_of_week null = каждый день', async () => {
    const { fn } = fetchStub(jsonRes([ruleRow()]));
    const [rule] = await new SchedulesRepo(opts(fn)).listByProfile('ilya');

    expect(rule).toEqual({
      id: '8b0f2f38-0c1b-4a1f-9a2e-2f4e0f7a1c11',
      profileId: 'ilya',
      times: ['20:00', '21:00'],
      courts: ['Padel Court 3', 'Padel Court 2'],
      daysOfWeek: null,
      enabled: true,
    });
  });

  it('days_of_week [1,3] читается как числа', async () => {
    const { fn } = fetchStub(jsonRes([ruleRow({ days_of_week: [1, 3] })]));
    const [rule] = await new SchedulesRepo(opts(fn)).listByProfile('ilya');
    expect(rule!.daysOfWeek).toEqual([1, 3]);
  });

  it('listEnabled: только enabled=is.true, порядок по профилю', async () => {
    const { fn, calls } = fetchStub(jsonRes([ruleRow(), ruleRow({ profile_id: 'nina' })]));
    const rules = await new SchedulesRepo(opts(fn)).listEnabled();

    expect(calls[0]!.params.get('enabled')).toBe('is.true');
    expect(calls[0]!.params.get('order')).toBe('profile_id.asc,created_at.asc,id.asc');
    expect(rules).toHaveLength(2);
  });

  it('enabled: правило включено только при строгом true', async () => {
    const { fn } = fetchStub(jsonRes([ruleRow({ enabled: null })]));
    const [rule] = await new SchedulesRepo(opts(fn)).listByProfile('ilya');
    expect(rule!.enabled).toBe(false);
  });

  it('times не массив -> ошибка про схему, а не молчаливое «правило без времён»', async () => {
    const { fn } = fetchStub(jsonRes([ruleRow({ times: '20:00' })]));
    await expect(new SchedulesRepo(opts(fn)).listEnabled()).rejects.toThrow(/times/);
  });

  it('пустой times -> ошибка (такое правило ничего не забронирует)', async () => {
    const { fn } = fetchStub(jsonRes([ruleRow({ times: [] })]));
    await expect(new SchedulesRepo(opts(fn)).listEnabled()).rejects.toThrow(/пустой массив/);
  });

  it('день недели вне 0–6 -> ошибка про схему', async () => {
    const { fn } = fetchStub(jsonRes([ruleRow({ days_of_week: [7] })]));
    await expect(new SchedulesRepo(opts(fn)).listEnabled()).rejects.toThrow(/0–6/);
  });

  it('setEnabled: PATCH по id с телом {enabled}', async () => {
    const { fn, calls } = fetchStub(jsonRes([ruleRow({ enabled: false })]));
    await new SchedulesRepo(opts(fn)).setEnabled('8b0f2f38-0c1b-4a1f-9a2e-2f4e0f7a1c11', false);

    const call = calls[0]!;
    expect(call.method).toBe('PATCH');
    expect(call.params.get('id')).toBe('eq.8b0f2f38-0c1b-4a1f-9a2e-2f4e0f7a1c11');
    expect(call.body).toEqual({ enabled: false });
    expect(call.headers['Prefer']).toContain('return=representation');
  });

  it('setEnabled по несуществующему id -> понятная ошибка, а не тихий no-op', async () => {
    const { fn } = fetchStub(jsonRes([]));
    await expect(new SchedulesRepo(opts(fn)).setEnabled('нет-такого', true)).rejects.toThrow(/не найдено/);
  });

  it('upsert без id: обычная вставка, id генерирует БД', async () => {
    const { fn, calls } = fetchStub(jsonRes([ruleRow()], 201));
    await new SchedulesRepo(opts(fn)).upsert({
      profileId: 'nina',
      times: ['19:00'],
      courts: ['Padel Court 1'],
      daysOfWeek: [2, 4],
      enabled: true,
    });

    const call = calls[0]!;
    expect(call.method).toBe('POST');
    expect(call.params.has('on_conflict')).toBe(false);
    expect(call.body).toEqual({
      profile_id: 'nina',
      times: ['19:00'],
      courts: ['Padel Court 1'],
      days_of_week: [2, 4],
      enabled: true,
    });
    expect(Object.keys(call.body as object)).not.toContain('id');
  });

  it('upsert с id: on_conflict=id, id в теле', async () => {
    const { fn, calls } = fetchStub(jsonRes([ruleRow()], 200));
    await new SchedulesRepo(opts(fn)).upsert({
      id: '8b0f2f38-0c1b-4a1f-9a2e-2f4e0f7a1c11',
      profileId: 'ilya',
      times: ['20:00', '21:00'],
      courts: ['Padel Court 3', 'Padel Court 2'],
      daysOfWeek: null,
      enabled: true,
    });

    expect(calls[0]!.params.get('on_conflict')).toBe('id');
    expect(calls[0]!.body).toEqual(ruleRow());
  });
});

describe('SkipsRepo', () => {
  it('isSkipped: eq.-фильтры по профилю и дате, limit=1', async () => {
    const { fn, calls } = fetchStub(jsonRes([{ date: '2026-08-06' }]));
    expect(await new SkipsRepo(opts(fn)).isSkipped('ilya', '2026-08-06')).toBe(true);

    const call = calls[0]!;
    expect(call.params.get('profile_id')).toBe('eq.ilya');
    expect(call.params.get('date')).toBe('eq.2026-08-06');
    expect(call.params.get('limit')).toBe('1');
  });

  it('isSkipped: нет строки -> false', async () => {
    const { fn } = fetchStub(jsonRes([]));
    expect(await new SkipsRepo(opts(fn)).isSkipped('ilya', '2026-08-06')).toBe(false);
  });

  it('add: upsert по (profile_id,date) — повторный скип не ошибка', async () => {
    const { fn, calls } = fetchStub(jsonRes([{ profile_id: 'ilya', date: '2026-08-06' }], 201));
    await new SkipsRepo(opts(fn)).add('ilya', '2026-08-06');

    const call = calls[0]!;
    expect(call.method).toBe('POST');
    expect(call.params.get('on_conflict')).toBe('profile_id,date');
    expect(call.headers['Prefer']).toContain('resolution=merge-duplicates');
    expect(call.body).toEqual({ profile_id: 'ilya', date: '2026-08-06' });
  });

  it('remove: DELETE по профилю и дате; отсутствующий скип не ошибка', async () => {
    const { fn, calls } = fetchStub(new Response(null, { status: 204 }));
    await expect(new SkipsRepo(opts(fn)).remove('ilya', '2026-08-06')).resolves.toBeUndefined();

    const call = calls[0]!;
    expect(call.method).toBe('DELETE');
    expect(call.params.get('profile_id')).toBe('eq.ilya');
    expect(call.params.get('date')).toBe('eq.2026-08-06');
  });

  it('listUpcoming: gte по дате отсечки, отсортировано, только даты', async () => {
    const { fn, calls } = fetchStub(jsonRes([{ date: '2026-08-01' }, { date: '2026-08-06' }]));
    const dates = await new SkipsRepo(opts(fn)).listUpcoming('ilya', '2026-08-01');

    expect(calls[0]!.params.get('date')).toBe('gte.2026-08-01');
    expect(calls[0]!.params.get('order')).toBe('date.asc');
    expect(dates).toEqual(['2026-08-01', '2026-08-06']);
  });

  it('listUpcoming без даты отсечки: «сегодня» берётся в зоне клуба, не сервера', async () => {
    // TZ тестов — America/New_York (vitest.config.ts). 21:30 UTC 31 июля в
    // Батуми — уже 1 августа: отсечка обязана быть тбилисской.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-31T21:30:00Z'));

    const { fn, calls } = fetchStub(jsonRes([]));
    await new SkipsRepo(opts(fn)).listUpcoming('ilya');

    expect(calls[0]!.params.get('date')).toBe('gte.2026-08-01');
  });
});

describe('SettingsRepo', () => {
  it('get: eq. по ключу, возвращает значение', async () => {
    const { fn, calls } = fetchStub(jsonRes([{ value: 'true' }]));
    expect(await new SettingsRepo(opts(fn)).get('planner_enabled')).toBe('true');

    expect(calls[0]!.params.get('key')).toBe('eq.planner_enabled');
    expect(calls[0]!.params.get('select')).toBe('value');
    expect(calls[0]!.params.get('limit')).toBe('1');
  });

  it('get: ключа нет -> null (планировщик считается выключенным)', async () => {
    const { fn } = fetchStub(jsonRes([]));
    expect(await new SettingsRepo(opts(fn)).get('planner_enabled')).toBeNull();
  });

  it('get: значение не строка -> null, а не мусор наружу', async () => {
    const { fn } = fetchStub(jsonRes([{ value: 1 }]));
    expect(await new SettingsRepo(opts(fn)).get('planner_enabled')).toBeNull();
  });

  it('set: upsert по key', async () => {
    const { fn, calls } = fetchStub(jsonRes([{ key: 'planner_enabled', value: 'true' }], 201));
    await new SettingsRepo(opts(fn)).set('planner_enabled', 'true');

    const call = calls[0]!;
    expect(call.params.get('on_conflict')).toBe('key');
    expect(call.body).toEqual({ key: 'planner_enabled', value: 'true' });
  });
});

describe('репозитории: ошибки', () => {
  it('нет таблицы (PGRST205) -> ошибка со ссылкой на миграцию', async () => {
    const { fn } = fetchStub(
      jsonRes(
        { code: 'PGRST205', message: "Could not find the table 'public.profiles' in the schema cache" },
        404,
      ),
    );
    await expect(new ProfilesRepo(opts(fn)).getByChatId('111222333')).rejects.toThrow(
      /20260731110000_bot_core\.sql/,
    );
  });

  it('нет колонки (PGRST204) -> та же подсказка про миграцию', async () => {
    const { fn } = fetchStub(jsonRes({ code: 'PGRST204', message: "Could not find the 'is_admin' column" }, 400));
    await expect(new ProfilesRepo(opts(fn)).upsert(profile())).rejects.toThrow(/20260731110000_bot_core\.sql/);
  });

  it('нет уникального индекса под on_conflict (42P10) -> подсказка про миграцию', async () => {
    const { fn } = fetchStub(jsonRes({ code: '42P10', message: 'no unique or exclusion constraint' }, 400));
    await expect(new SkipsRepo(opts(fn)).add('ilya', '2026-08-06')).rejects.toThrow(
      /20260731110000_bot_core\.sql/,
    );
  });

  it('401 -> ошибка про SUPABASE_SERVICE_ROLE_KEY, без самого ключа в тексте', async () => {
    const { fn } = fetchStub(jsonRes({ message: 'Invalid API key' }, 401));
    const err = await rejection(new SettingsRepo(opts(fn)).get('planner_enabled'));

    expect(err).toBeInstanceOf(SupabaseRepoError);
    expect(err.message).toMatch(/SUPABASE_SERVICE_ROLE_KEY/);
    expect((err as SupabaseRepoError).status).toBe(401);
    expect(err.message).not.toContain(KEY);
  });

  it('403 обрабатывается как проблема ключа (гранты отозваны у anon)', async () => {
    const { fn } = fetchStub(jsonRes({ message: 'permission denied for table profiles' }, 403));
    await expect(new ProfilesRepo(opts(fn)).list()).rejects.toThrow(/SUPABASE_SERVICE_ROLE_KEY/);
  });

  it('прочий HTTP-фейл: статус и текст PostgREST видны в сообщении', async () => {
    const { fn } = fetchStub(jsonRes({ code: '23514', message: 'violates check constraint' }, 400));
    await expect(
      new SchedulesRepo(opts(fn)).upsert({
        profileId: 'ilya',
        times: ['20:00'],
        courts: ['Padel Court 3'],
        daysOfWeek: null,
        enabled: true,
      }),
    ).rejects.toThrow(/HTTP 400 23514 — violates check constraint/);
  });

  it('ключ вырезается, даже если сервер вернул его эхом', async () => {
    const { fn } = fetchStub(new Response(`boom ${KEY} boom`, { status: 500 }));
    const err = await rejection(new ProfilesRepo(opts(fn)).list());

    expect(err.message).not.toContain(KEY);
    expect(err.message).toContain('***');
  });

  it('ключ никогда не попадает в URL — только в заголовки', async () => {
    const { fn, calls } = fetchStub(() => jsonRes([profileRow()], 201));
    const repo = new ProfilesRepo(opts(fn));
    await repo.upsert(profile());
    await repo.getById('ilya');

    expect(calls).toHaveLength(2);
    for (const call of calls) expect(call.url).not.toContain(KEY);
  });

  it('ответ не массив -> понятная ошибка, а не молчаливый null', async () => {
    const { fn } = fetchStub(jsonRes({ unexpected: true }));
    await expect(new ProfilesRepo(opts(fn)).list()).rejects.toThrow(/массив строк/);
  });

  it('сетевая ошибка -> понятный throw без утечки ключа', async () => {
    const fn = vi.fn(async () => {
      throw new TypeError(`fetch failed for key ${KEY}`);
    }) as unknown as typeof fetch;

    const err = await rejection(new SkipsRepo(opts(fn)).isSkipped('ilya', '2026-08-06'));

    expect(err.message).toMatch(/не выполнен/);
    expect(err.message).not.toContain(KEY);
  });

  it('таймаут 5 с: запрос прерывается и падает понятной ошибкой', async () => {
    const fn = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted.', 'AbortError'));
          });
        }),
    ) as unknown as typeof fetch;

    vi.useFakeTimers();
    const pending = new ProfilesRepo(opts(fn)).getByChatId('111222333');
    const assertion = expect(pending).rejects.toThrow(/таймаут/);

    await vi.advanceTimersByTimeAsync(5_000);
    await assertion;
  });
});
