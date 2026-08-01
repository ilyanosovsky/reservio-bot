// Тесты src/trigger/daily-planner.ts: чистые функции (отбор правил, delay,
// idempotency, форматирование) + оркестрация runDailyPlanner на фейковых
// PlannerDeps (без реального Supabase/Telegram/trigger.dev). Планировщик
// выключен по умолчанию — отдельно проверяем, что при settings.planner_enabled
// !== 'true' ран не трогает ни schedules/profiles/skips, ни Telegram, ни
// tasks.trigger.
import { describe, expect, it, vi } from 'vitest';
import { weekdayOf } from '../src/core/scheduler.js';

// dailyPlannerTask регистрируется через schedules.task при импорте модуля —
// подменяем SDK на «верни конфиг как есть», как в tests/book-drop.test.ts.
// run() дальше в этих тестах не вызывается (он тянет ../core/repos.js
// динамическим import — контракт другого агента, здесь его не поднимаем).
vi.mock('@trigger.dev/sdk', () => ({
  schedules: { task: (config: unknown) => config },
  tasks: { trigger: vi.fn() },
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), log: vi.fn() },
}));

const {
  dailyPlannerTask,
  dropIdempotencyKey,
  dropTriggerDelay,
  formatPreDropMessage,
  makeTriggerDrop,
  mergePlannedDrops,
  ruleAppliesOnDate,
  runDailyPlanner,
  selectEligibleRules,
  splitTimesByDrop,
} = await import('../src/trigger/daily-planner.js');
type PlannerDeps = import('../src/trigger/daily-planner.js').PlannerDeps;
type PlannerProfile = import('../src/trigger/daily-planner.js').PlannerProfile;
type PlannerRule = import('../src/trigger/daily-planner.js').PlannerRule;

// ---- фикстуры ----

const DATE = '2026-08-07'; // T+7 относительно NOW ниже
const NOW = new Date('2026-07-31T16:30:00.000Z'); // 20:30 Тбилиси 31.07 — момент крон-рана
const DAY_T = '2026-07-31'; // день наблюдения дропа = сегодня по Тбилиси

function profile(patch: Partial<PlannerProfile> = {}): PlannerProfile {
  return { id: 'ilya', label: 'Ilya', telegramChatId: '111', ...patch };
}

function rule(patch: Partial<PlannerRule> = {}): PlannerRule {
  return {
    id: 'rule-1',
    profileId: 'ilya',
    times: ['20:00', '21:00'],
    courts: ['Padel Court 3', 'Padel Court 2'],
    daysOfWeek: null,
    enabled: true,
    mode: 'priority',
    ...patch,
  };
}

describe('ruleAppliesOnDate', () => {
  it('null — каждый день', () => {
    expect(ruleAppliesOnDate(null, DATE)).toBe(true);
  });

  it('массив дней недели: совпадение и несовпадение', () => {
    const day = weekdayOf(DATE);
    expect(ruleAppliesOnDate([day], DATE)).toBe(true);
    expect(ruleAppliesOnDate([(day + 1) % 7], DATE)).toBe(false);
  });

  it('пустой массив — ни один день не подходит', () => {
    expect(ruleAppliesOnDate([], DATE)).toBe(false);
  });
});

describe('dropTriggerDelay', () => {
  it('H:57:00 дня T в таймзоне клуба (+04:00)', () => {
    expect(dropTriggerDelay(DAY_T, '20:00').toISOString()).toBe('2026-07-31T16:57:00.000Z');
  });

  it('час 23 не переползает на следующие сутки', () => {
    expect(dropTriggerDelay(DAY_T, '23:00').toISOString()).toBe('2026-07-31T19:57:00.000Z');
  });
});

describe('dropIdempotencyKey', () => {
  it('формат drop-{profileId}-{date}-{time}-{ruleId}', () => {
    expect(dropIdempotencyKey('ilya', DATE, '20:00', 'rule-1')).toBe('drop-ilya-2026-08-07-20:00-rule-1');
  });

  it('разные сценарии на один час дают РАЗНЫЕ ключи', () => {
    // Ключ описывает НАБОР схлопнутых сценариев (mergePlannedDrops): изменился
    // набор — изменился и ключ, иначе trigger.dev принял бы новый план за дубль
    // старого и вечер отработал бы по вчерашним кортам.
    const a = dropIdempotencyKey('ilya', DATE, '20:00', 'rule-1');
    const b = dropIdempotencyKey('ilya', DATE, '20:00', 'rule-2');
    expect(a).not.toBe(b);
  });

  it('ключ стабилен между ранами планировщика (защита от дубля не слабеет)', () => {
    expect(dropIdempotencyKey('ilya', DATE, '20:00', 'rule-1')).toBe(dropIdempotencyKey('ilya', DATE, '20:00', 'rule-1'));
  });
});

describe('mergePlannedDrops', () => {
  const req = (patch: Partial<import('../src/trigger/daily-planner.js').DropRequest> = {}) => ({
    profileId: 'ilya',
    time: '20:00',
    courts: ['Padel Court 3'],
    mode: 'priority' as const,
    ruleId: 'r1',
    ...patch,
  });

  it('одна заявка проходит как есть', () => {
    expect(mergePlannedDrops([req()])).toEqual([
      { profileId: 'ilya', time: '20:00', courts: ['Padel Court 3'], mode: 'priority', ruleIds: ['r1'] },
    ]);
  });

  it('общий (профиль, час): корты объединяются без дублей, порядок приоритета первого сохраняется', () => {
    const merged = mergePlannedDrops([
      req({ ruleId: 'r1', courts: ['Padel Court 3', 'Padel Court 4'] }),
      req({ ruleId: 'r2', courts: ['Padel Court 4', 'Padel Court 1'] }),
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.courts).toEqual(['Padel Court 3', 'Padel Court 4', 'Padel Court 1']);
    expect(merged[0]!.ruleIds).toEqual(['r1', 'r2']);
  });

  it('режим all побеждает: пропущенный корт не вернуть, лишнюю бронь отменить можно', () => {
    expect(mergePlannedDrops([req({ ruleId: 'r1' }), req({ ruleId: 'r2', mode: 'all' })])[0]!.mode).toBe('all');
    expect(mergePlannedDrops([req({ ruleId: 'r1', mode: 'all' }), req({ ruleId: 'r2' })])[0]!.mode).toBe('all');
  });

  it('разные часы и разные профили остаются отдельными дропами', () => {
    const merged = mergePlannedDrops([
      req({ time: '20:00' }),
      req({ time: '21:00' }),
      req({ profileId: 'anna', time: '20:00' }),
    ]);
    expect(merged.map((d) => [d.profileId, d.time])).toEqual([
      ['ilya', '20:00'],
      ['ilya', '21:00'],
      ['anna', '20:00'],
    ]);
  });
});

describe('formatPreDropMessage', () => {
  it('содержит дату, времена, корты и подпись профиля', () => {
    const text = formatPreDropMessage({ label: 'Ilya', date: DATE, times: ['20:00', '21:00'], courts: ['Padel Court 3', 'Padel Court 2'] });
    expect(text).toContain(DATE);
    expect(text).toContain('20:00, 21:00');
    expect(text).toContain('Padel Court 3 → Padel Court 2');
    expect(text).toContain('Ilya');
  });

  it('экранирует HTML-спецсимволы в подписи', () => {
    const text = formatPreDropMessage({ label: 'A & <B>', date: DATE, times: ['20:00'], courts: ['C'] });
    expect(text).toContain('A &amp; &lt;B&gt;');
    expect(text).not.toContain('<B>');
  });

  it('режим all: корты перечислены без стрелки приоритета + предупреждение про лишние брони', () => {
    // Стрелка «→» в этом режиме врала бы: бот берёт КАЖДЫЙ появившийся корт.
    const text = formatPreDropMessage({
      label: 'Ilya',
      date: DATE,
      times: ['20:00'],
      courts: ['Padel Court 4', 'Padel Court 1'],
      mode: 'all',
    });
    expect(text).toContain('Padel Court 4, Padel Court 1');
    expect(text).not.toContain('→');
    expect(text).toContain('отменишь вручную');
  });

  it('режим не задан — прежний текст с приоритетом (обратная совместимость)', () => {
    const text = formatPreDropMessage({ label: 'Ilya', date: DATE, times: ['20:00'], courts: ['A', 'B'] });
    expect(text).toContain('Корты (приоритет): A → B');
    expect(text).not.toContain('отменишь вручную');
  });
});

describe('selectEligibleRules', () => {
  it('счастливый путь: включённое правило, профиль с chat_id, день подходит, скипа нет', () => {
    const out = selectEligibleRules([rule()], new Map([['ilya', profile()]]), DATE, new Set());
    expect(out).toHaveLength(1);
    expect(out[0]!.profile.id).toBe('ilya');
  });

  it('выключенное правило пропущено', () => {
    const out = selectEligibleRules([rule({ enabled: false })], new Map([['ilya', profile()]]), DATE, new Set());
    expect(out).toHaveLength(0);
  });

  it('профиль без telegram_chat_id пропущен', () => {
    const out = selectEligibleRules([rule()], new Map([['ilya', profile({ telegramChatId: null })]]), DATE, new Set());
    expect(out).toHaveLength(0);
  });

  it('профиль не найден (getById вернул null) — пропущен', () => {
    const out = selectEligibleRules([rule()], new Map([['ilya', null]]), DATE, new Set());
    expect(out).toHaveLength(0);
  });

  it('день недели не подходит — пропущено', () => {
    const day = weekdayOf(DATE);
    const other = (day + 1) % 7;
    const out = selectEligibleRules([rule({ daysOfWeek: [other] })], new Map([['ilya', profile()]]), DATE, new Set());
    expect(out).toHaveLength(0);
  });

  it('день недели подходит явно', () => {
    const day = weekdayOf(DATE);
    const out = selectEligibleRules([rule({ daysOfWeek: [day] })], new Map([['ilya', profile()]]), DATE, new Set());
    expect(out).toHaveLength(1);
  });

  it('скип на дату — профиль пропущен', () => {
    const out = selectEligibleRules([rule()], new Map([['ilya', profile()]]), DATE, new Set(['ilya']));
    expect(out).toHaveLength(0);
  });

  it('несколько правил: обрабатывает только подходящие', () => {
    const rules = [
      rule({ id: 'r1', profileId: 'ilya' }),
      rule({ id: 'r2', profileId: 'anna', enabled: false }),
      rule({ id: 'r3', profileId: 'olya' }),
    ];
    const profiles = new Map<string, PlannerProfile | null>([
      ['ilya', profile({ id: 'ilya' })],
      ['anna', profile({ id: 'anna' })],
      ['olya', profile({ id: 'olya', telegramChatId: null })],
    ]);
    const out = selectEligibleRules(rules, profiles, DATE, new Set());
    expect(out.map((e) => e.rule.id)).toEqual(['r1']);
  });
});

// ---- runDailyPlanner: оркестрация на фейковых deps ----

type SendPreDropMock = ReturnType<typeof vi.fn<PlannerDeps['sendPreDrop']>>;
type TriggerDropMock = ReturnType<typeof vi.fn<PlannerDeps['triggerDrop']>>;

function fakeDeps(overrides: Partial<PlannerDeps> = {}): PlannerDeps & {
  sendPreDropMock: SendPreDropMock;
  triggerDropMock: TriggerDropMock;
} {
  const sendPreDropMock: SendPreDropMock = vi.fn<PlannerDeps['sendPreDrop']>();
  sendPreDropMock.mockImplementation(overrides.sendPreDrop ?? (async () => true));
  const triggerDropMock: TriggerDropMock = vi.fn<PlannerDeps['triggerDrop']>();
  triggerDropMock.mockImplementation(overrides.triggerDrop ?? (async () => undefined));

  const deps: PlannerDeps = {
    settings: { get: vi.fn(async () => 'true') },
    schedules: { listEnabled: vi.fn(async () => [rule()]) },
    profiles: { getById: vi.fn(async (id: string) => profile({ id })) },
    skips: { isSkipped: vi.fn(async () => false) },
    ...overrides,
    sendPreDrop: sendPreDropMock,
    triggerDrop: triggerDropMock,
  };
  // *Mock — тот же объект, что deps.sendPreDrop/triggerDrop, чтобы assert'ы по
  // deps.*Mock никогда не расходились с тем, что реально дёрнул runDailyPlanner.
  return Object.assign(deps, { sendPreDropMock, triggerDropMock });
}

describe('runDailyPlanner', () => {
  it('планировщик выключен -> пусто, ничего не читает и не триггерит', async () => {
    const settingsGet = vi.fn(async () => null);
    const listEnabled = vi.fn(async () => [rule()]);
    const deps = fakeDeps({ settings: { get: settingsGet }, schedules: { listEnabled } });

    const summary = await runDailyPlanner(deps, NOW);

    expect(summary).toEqual({ enabled: false, messagesSent: 0, dropsTriggered: 0, skippedProfiles: [], errors: [] });
    expect(listEnabled).not.toHaveBeenCalled();
    expect(deps.sendPreDropMock).not.toHaveBeenCalled();
    expect(deps.triggerDropMock).not.toHaveBeenCalled();
  });

  it('планировщик выключен при любом значении settings, кроме точно "true"', async () => {
    const deps = fakeDeps({ settings: { get: vi.fn(async () => 'TRUE') } });
    const summary = await runDailyPlanner(deps, NOW);
    expect(summary.enabled).toBe(false);
  });

  it('счастливый путь: сообщение + два триггера (20:00, 21:00) с верными delay/idempotencyKey', async () => {
    const deps = fakeDeps();

    const summary = await runDailyPlanner(deps, NOW);

    expect(summary).toEqual({
      enabled: true,
      targetDate: DATE,
      messagesSent: 1,
      dropsTriggered: 2,
      skippedProfiles: [],
      errors: [],
    });

    expect(deps.sendPreDropMock).toHaveBeenCalledTimes(1);
    const [sentProfile, sentText, sentDate] = deps.sendPreDropMock.mock.calls[0]!;
    expect(sentProfile).toEqual(profile());
    expect(sentText).toContain(DATE);
    expect(sentDate).toBe(DATE);

    expect(deps.triggerDropMock).toHaveBeenCalledTimes(2);
    const [payload1, opts1] = deps.triggerDropMock.mock.calls[0]!;
    // courts/mode обязаны быть в payload: без них book-drop.ts переспрашивает
    // правило у БД по времени и на профиле с несколькими сценариями может
    // выбрать чужой набор кортов.
    expect(payload1).toEqual({
      profileId: 'ilya',
      date: DATE,
      time: '20:00',
      live: true,
      force: true,
      courts: ['Padel Court 3', 'Padel Court 2'],
      mode: 'priority',
    });
    expect(opts1).toEqual({
      delay: dropTriggerDelay(DAY_T, '20:00'),
      idempotencyKey: 'drop-ilya-2026-08-07-20:00-rule-1',
      // очередь на профиль: дропы разных людей на одну секунду не должны
      // выстраиваться в затылок друг другу (concurrencyLimit book-slot-drop = 1)
      concurrencyKey: 'ilya',
    });

    const [payload2, opts2] = deps.triggerDropMock.mock.calls[1]!;
    expect(payload2).toEqual({
      profileId: 'ilya',
      date: DATE,
      time: '21:00',
      live: true,
      force: true,
      courts: ['Padel Court 3', 'Padel Court 2'],
      mode: 'priority',
    });
    expect(opts2).toEqual({
      delay: dropTriggerDelay(DAY_T, '21:00'),
      idempotencyKey: 'drop-ilya-2026-08-07-21:00-rule-1',
      concurrencyKey: 'ilya',
    });
  });

  it('режим и корты сценария уезжают в payload как есть (вечерняя вахта)', async () => {
    const rules = [rule({ id: 'watch', times: ['21:00'], courts: ['Padel Court 4', 'Padel Court 1'], mode: 'all' })];
    const deps = fakeDeps({ schedules: { listEnabled: vi.fn(async () => rules) } });

    await runDailyPlanner(deps, NOW);

    const [payload] = deps.triggerDropMock.mock.calls[0]!;
    expect(payload).toMatchObject({ time: '21:00', courts: ['Padel Court 4', 'Padel Court 1'], mode: 'all' });
  });

  it('два сценария профиля на ОДИН час схлопываются в ОДИН дроп с объединённым набором', async () => {
    // Регрессия: раньше на такой час уезжали ДВА рана. У book-slot-drop
    // concurrencyLimit 1 на concurrencyKey=profileId, поэтому второй ран ждал
    // бы конца пятиминутного окна первого, приходил в закрытое окно, не делал
    // ни одного getAvailability (корты второго сценария никто не сторожит) и
    // присылал второй ❌-отчёт за вечер — при инварианте «ровно одно сообщение».
    const rules = [
      rule({ id: 'r-prio', times: ['20:00'], courts: ['Padel Court 3'], mode: 'priority' }),
      rule({ id: 'r-all', times: ['20:00'], courts: ['Padel Court 4', 'Padel Court 1'], mode: 'all' }),
    ];
    const deps = fakeDeps({ schedules: { listEnabled: vi.fn(async () => rules) } });

    const summary = await runDailyPlanner(deps, NOW);

    expect(summary.dropsTriggered).toBe(1);
    expect(deps.triggerDropMock).toHaveBeenCalledTimes(1);
    const [payload, opts] = deps.triggerDropMock.mock.calls[0]!;
    // Корты обоих сценариев в вахте, порядок приоритета первого — впереди.
    expect(payload).toMatchObject({
      time: '20:00',
      courts: ['Padel Court 3', 'Padel Court 4', 'Padel Court 1'],
      // 'all' просил хотя бы один сценарий: лишнюю бронь владелец отменит,
      // пропущенный корт не вернуть.
      mode: 'all',
    });
    // Ключ идемпотентности стабилен и включает оба сценария.
    expect(opts.idempotencyKey).toBe('drop-ilya-2026-08-07-20:00-r-prio+r-all');
  });

  it('сценарии на РАЗНЫЕ часы не схлопываются, а сценарии разных профилей не смешиваются', async () => {
    const rules = [
      rule({ id: 'r1', profileId: 'ilya', times: ['20:00'], courts: ['Padel Court 3'] }),
      rule({ id: 'r2', profileId: 'ilya', times: ['21:00'], courts: ['Padel Court 4'] }),
      rule({ id: 'r3', profileId: 'anna', times: ['20:00'], courts: ['Padel Court 1'] }),
    ];
    const deps = fakeDeps({ schedules: { listEnabled: vi.fn(async () => rules) } });

    const summary = await runDailyPlanner(deps, NOW);

    expect(summary.dropsTriggered).toBe(3);
    expect(
      deps.triggerDropMock.mock.calls.map(([p]) => [p.profileId, p.time, p.courts]),
    ).toEqual([
      ['ilya', '20:00', ['Padel Court 3']],
      ['ilya', '21:00', ['Padel Court 4']],
      ['anna', '20:00', ['Padel Court 1']],
    ]);
  });

  it('дропы разных профилей получают РАЗНЫЕ concurrencyKey', async () => {
    // Иначе ран второго профиля дождался бы конца чужого пятиминутного окна и
    // не сделал бы ни одного опроса availability.
    const rules = [rule({ id: 'r1', profileId: 'ilya', times: ['20:00'] }), rule({ id: 'r2', profileId: 'anna', times: ['20:00'] })];
    const deps = fakeDeps({ schedules: { listEnabled: vi.fn(async () => rules) } });

    await runDailyPlanner(deps, NOW);

    const keys = deps.triggerDropMock.mock.calls.map(([, opts]: [unknown, { concurrencyKey: string }]) => opts.concurrencyKey);
    expect(keys).toEqual(['ilya', 'anna']);
  });

  it('скип на targetDate — профиль пропущен целиком, попадает в summary.skippedProfiles', async () => {
    const deps = fakeDeps({ skips: { isSkipped: vi.fn(async (_id: string, date: string) => date === DATE) } });

    const summary = await runDailyPlanner(deps, NOW);

    expect(summary.skippedProfiles).toEqual(['ilya']);
    expect(summary.messagesSent).toBe(0);
    expect(summary.dropsTriggered).toBe(0);
    expect(deps.sendPreDropMock).not.toHaveBeenCalled();
    expect(deps.triggerDropMock).not.toHaveBeenCalled();
  });

  it('выключенное правило не попадает в план', async () => {
    const deps = fakeDeps({ schedules: { listEnabled: vi.fn(async () => [rule({ enabled: false })]) } });
    const summary = await runDailyPlanner(deps, NOW);
    expect(summary.dropsTriggered).toBe(0);
    expect(summary.messagesSent).toBe(0);
  });

  it('день недели вне правила — профиль пропущен', async () => {
    const other = (weekdayOf(DATE) + 1) % 7;
    const deps = fakeDeps({ schedules: { listEnabled: vi.fn(async () => [rule({ daysOfWeek: [other] })]) } });
    const summary = await runDailyPlanner(deps, NOW);
    expect(summary.dropsTriggered).toBe(0);
  });

  it('sendPreDrop вернул false — это не фатально, дропы всё равно триггерятся', async () => {
    const deps = fakeDeps({ sendPreDrop: vi.fn(async () => false) });
    const summary = await runDailyPlanner(deps, NOW);
    expect(summary.messagesSent).toBe(0);
    expect(summary.dropsTriggered).toBe(2);
  });

  it('ошибка на одном профиле не останавливает обработку остальных', async () => {
    const rules = [rule({ id: 'r1', profileId: 'ilya' }), rule({ id: 'r2', profileId: 'anna' })];
    const triggerDropMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('trigger.dev недоступен'))
      .mockResolvedValue(undefined);
    const deps = fakeDeps({
      schedules: { listEnabled: vi.fn(async () => rules) },
      profiles: { getById: vi.fn(async (id: string) => profile({ id })) },
      triggerDrop: triggerDropMock,
    });

    const summary = await runDailyPlanner(deps, NOW);

    expect(summary.errors).toEqual(['ilya: trigger.dev недоступен']);
    // ilya упал на первом же time (20:00) — второй time того же профиля не пытаемся;
    // anna (второй профиль) обработан полностью: 2 успешных триггера.
    expect(triggerDropMock).toHaveBeenCalledTimes(3);
    expect(summary.dropsTriggered).toBe(2);
    expect(summary.messagesSent).toBe(2);
  });

  it('несколько времён одного правила — по одному триггеру на время, delay растёт вместе с часом', async () => {
    const deps = fakeDeps({ schedules: { listEnabled: vi.fn(async () => [rule({ times: ['20:00', '21:00', '22:00'] })]) } });
    const summary = await runDailyPlanner(deps, NOW);
    expect(summary.dropsTriggered).toBe(3);
    const delays = deps.triggerDropMock.mock.calls.map(([, opts]: [unknown, { delay: Date }]) => opts.delay.getTime());
    expect(delays).toEqual([...delays].sort((a, b) => a - b));
  });

  it('время, чей дроп сегодня уже прошёл, НЕ планируется и попадает в summary.errors', async () => {
    // Крон в 20:30, дроп слота 19:00 был бы в 19:57 — момент в прошлом.
    // tasks.trigger с прошедшим delay выполняется немедленно, ран приходит в
    // закрытое окно и возвращает Timeout: человек получал бы ❌ каждый вечер.
    const deps = fakeDeps({ schedules: { listEnabled: vi.fn(async () => [rule({ times: ['19:00', '21:00'] })]) } });

    const summary = await runDailyPlanner(deps, NOW);

    expect(summary.dropsTriggered).toBe(1);
    const times = deps.triggerDropMock.mock.calls.map(([payload]: [{ time: string }, unknown]) => payload.time);
    expect(times).toEqual(['21:00']);
    expect(summary.errors.join(' ')).toContain('19:00');
    // в pre-drop сообщении тоже только то, что реально будет забронировано
    expect(String(deps.sendPreDropMock.mock.calls[0]![1])).not.toContain('19:00');
  });

  it('все времена правила уже в прошлом — ни сообщения, ни триггеров', async () => {
    const deps = fakeDeps({ schedules: { listEnabled: vi.fn(async () => [rule({ times: ['08:00', '19:00'] })]) } });

    const summary = await runDailyPlanner(deps, NOW);

    expect(summary.dropsTriggered).toBe(0);
    expect(deps.sendPreDropMock).not.toHaveBeenCalled();
  });
});

describe('splitTimesByDrop', () => {
  it('делит времена по моменту отправки дропа относительно «сейчас»', () => {
    expect(splitTimesByDrop(['19:00', '20:00', '21:00'], DAY_T, NOW)).toEqual({
      planned: ['20:00', '21:00'],
      past: ['19:00'],
    });
  });

  it('дроп ровно в момент «сейчас» считается прошедшим (ждать уже нечего)', () => {
    const at2057 = dropTriggerDelay(DAY_T, '20:00');
    expect(splitTimesByDrop(['20:00'], DAY_T, at2057)).toEqual({ planned: [], past: ['20:00'] });
  });
});

describe('makeTriggerDrop: ключ идемпотентности ГЛОБАЛЬНЫЙ', () => {
  type TriggerFn = import('../src/trigger/daily-planner.js').TriggerDropFn;
  type CreateKeyFn = import('../src/trigger/daily-planner.js').CreateIdempotencyKeyFn;

  const opts = {
    delay: new Date('2026-07-31T16:57:00.000Z'),
    idempotencyKey: 'drop-ilya-2026-08-07-20:00',
    concurrencyKey: 'ilya',
  };
  const payload = { profileId: 'ilya', date: DATE, time: '20:00', live: true, force: true };

  it('строка прогоняется через createKey со scope global, а не уходит в trigger как есть', async () => {
    // Голая строка внутри таска скоупится ран-айди родителя (@trigger.dev/core:
    // injectScope('run')), поэтому Replay планировщика поставил бы ВТОРОЙ дроп
    // на тот же слот — две реальные брони при деградировавшем state.
    const createKey = vi.fn<CreateKeyFn>(async (key) => `global:${key}`);
    const trigger = vi.fn<TriggerFn>(async () => undefined);

    await makeTriggerDrop({ createKey, trigger })(payload, opts);

    expect(createKey).toHaveBeenCalledWith(opts.idempotencyKey, { scope: 'global' });
    const [id, sentPayload, sentOpts] = trigger.mock.calls[0]!;
    expect(id).toBe('book-slot-drop');
    expect(sentPayload).toEqual(payload);
    expect(sentOpts.idempotencyKey).toBe('global:drop-ilya-2026-08-07-20:00');
    expect(sentOpts.delay).toBe(opts.delay);
    expect(sentOpts.concurrencyKey).toBe('ilya');
  });

  it('отказ createKey не превращается в триггер без ключа', async () => {
    const trigger = vi.fn<TriggerFn>(async () => undefined);
    const createKey = vi.fn<CreateKeyFn>(async () => {
      throw new Error('trigger.dev 503');
    });

    await expect(makeTriggerDrop({ createKey, trigger })(payload, opts)).rejects.toThrow('trigger.dev 503');
    expect(trigger).not.toHaveBeenCalled();
  });
});

describe('dailyPlannerTask — регистрация', () => {
  it('id и cron соответствуют контракту (крон = 20:30 Тбилиси = 16:30 UTC)', () => {
    const config = dailyPlannerTask as unknown as { id: string; cron: string };
    expect(config.id).toBe('daily-planner');
    expect(config.cron).toBe('30 16 * * *');
  });
});
