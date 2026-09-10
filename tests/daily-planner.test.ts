// Тесты src/trigger/daily-planner.ts: чистые функции (отбор правил, delay,
// idempotency, форматирование) + оркестрация runDailyPlanner на фейковых
// PlannerDeps (без реального Supabase/Telegram/trigger.dev). Планировщик
// выключен по умолчанию — отдельно проверяем, что при settings.planner_enabled
// !== 'true' ран не трогает ни schedules/profiles/skips, ни Telegram, ни
// tasks.trigger.
import { describe, expect, it, vi } from 'vitest';
import { dropWatchWindow, weekdayOf } from '../src/core/scheduler.js';
import { formatPlannerPlan, parsePlannerPlan } from '../src/core/heartbeat-logic.js';

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
  PLANNER_DISABLED_PREFIX,
  PLANNER_LAST_PLAN_KEY,
  PLANNER_LAST_RUN_KEY,
  plannerLastRunValue,
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
// Планировщик почасовой: ран H:30 ставит дроп часа H. NOW — ран 20:30 Тбилиси
// 31.07 (ставит 20:00), NOW_2130 — следующий ран (ставит 21:00), NOW_1930 — ран,
// которого при одном кроне в 20:30 не существовало (ставит 19:00).
const NOW = new Date('2026-07-31T16:30:00.000Z');
const NOW_2130 = new Date('2026-07-31T17:30:00.000Z');
const NOW_1930 = new Date('2026-07-31T15:30:00.000Z');
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
type SettingsSetMock = ReturnType<typeof vi.fn<PlannerDeps['settings']['set']>>;

/**
 * settings в overrides можно задавать частично (обычно нужен только get):
 * недостающий set подставляется моком, иначе каждый тест про выключенный
 * планировщик тащил бы за собой заглушку отметки planner_last_run.
 */
type DepsOverrides = Partial<Omit<PlannerDeps, 'settings'>> & { settings?: Partial<PlannerDeps['settings']> };

/**
 * settings.get фейков: планировщик включён, остальные ключи — из `values`
 * (по умолчанию пусто). Одна строка 'true' на любой ключ не годится: для
 * planner_last_plan она была бы нечитаемым значением, которое ран не перезаписывает.
 */
function settingsGet(values: Record<string, string | null> = {}) {
  return vi.fn(async (key: string) => (key === 'planner_enabled' ? 'true' : (values[key] ?? null)));
}

/** План дня, который ран записал в settings (null — не записывал). */
function planWritten(deps: { settingsSetMock: SettingsSetMock }) {
  const call = deps.settingsSetMock.mock.calls.find(([key]) => key === PLANNER_LAST_PLAN_KEY);
  return call === undefined ? null : parsePlannerPlan(String(call[1]));
}

function fakeDeps(overrides: DepsOverrides = {}): PlannerDeps & {
  sendPreDropMock: SendPreDropMock;
  triggerDropMock: TriggerDropMock;
  settingsSetMock: SettingsSetMock;
} {
  const sendPreDropMock: SendPreDropMock = vi.fn<PlannerDeps['sendPreDrop']>();
  sendPreDropMock.mockImplementation(overrides.sendPreDrop ?? (async () => true));
  const triggerDropMock: TriggerDropMock = vi.fn<PlannerDeps['triggerDrop']>();
  triggerDropMock.mockImplementation(overrides.triggerDrop ?? (async () => undefined));
  const settingsSetMock: SettingsSetMock = vi.fn<PlannerDeps['settings']['set']>();
  settingsSetMock.mockImplementation(overrides.settings?.set ?? (async () => undefined));

  const deps: PlannerDeps = {
    schedules: { listEnabled: vi.fn(async () => [rule()]) },
    profiles: { getById: vi.fn(async (id: string) => profile({ id })) },
    skips: { isSkipped: vi.fn(async () => false) },
    ...overrides,
    settings: { get: overrides.settings?.get ?? settingsGet(), set: settingsSetMock },
    sendPreDrop: sendPreDropMock,
    triggerDrop: triggerDropMock,
  };
  // *Mock — тот же объект, что deps.sendPreDrop/triggerDrop/settings.set, чтобы
  // assert'ы по deps.*Mock никогда не расходились с тем, что реально дёрнул
  // runDailyPlanner.
  return Object.assign(deps, { sendPreDropMock, triggerDropMock, settingsSetMock });
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

  it('счастливый путь, ран 20:30: сообщение со всем планом + ОДИН триггер (20:00) с верными delay/idempotencyKey', async () => {
    const deps = fakeDeps();

    const summary = await runDailyPlanner(deps, NOW);

    expect(summary).toEqual({
      enabled: true,
      targetDate: DATE,
      messagesSent: 1,
      dropsTriggered: 1,
      skippedProfiles: [],
      errors: [],
    });

    expect(deps.sendPreDropMock).toHaveBeenCalledTimes(1);
    const [sentProfile, sentText, sentDate] = deps.sendPreDropMock.mock.calls[0]!;
    expect(sentProfile).toEqual(profile());
    expect(sentText).toContain(DATE);
    // В сообщении — весь оставшийся план сценария, а не только час этого рана.
    expect(sentText).toContain('20:00, 21:00');
    expect(sentDate).toBe(DATE);

    expect(deps.triggerDropMock).toHaveBeenCalledTimes(1);
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
  });

  it('ран 21:30 того же сценария: повторного сообщения нет, ОДИН триггер (21:00)', async () => {
    const deps = fakeDeps();

    const summary = await runDailyPlanner(deps, NOW_2130);

    expect(summary).toMatchObject({ messagesSent: 0, dropsTriggered: 1, errors: [] });
    expect(deps.sendPreDropMock).not.toHaveBeenCalled();
    expect(deps.triggerDropMock).toHaveBeenCalledTimes(1);
    const [payload2, opts2] = deps.triggerDropMock.mock.calls[0]!;
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

  it('регрессия: сценарий на 19:00 (пн–пт) ставится раном 19:30 — при одном кроне в 20:30 он не отрабатывал никогда', async () => {
    // Ровно сценарий второго профиля из боевой БД: 19:00, будни, все корты.
    const rules = [rule({ id: 'r-19', profileId: 'vera', times: ['19:00'], daysOfWeek: [1, 2, 3, 4, 5], mode: 'all' })];
    const deps = fakeDeps({ schedules: { listEnabled: vi.fn(async () => rules) } });

    const summary = await runDailyPlanner(deps, NOW_1930);

    expect(summary).toMatchObject({ messagesSent: 1, dropsTriggered: 1, errors: [] });
    const [payload, opts] = deps.triggerDropMock.mock.calls[0]!;
    expect(payload).toMatchObject({ profileId: 'vera', date: DATE, time: '19:00', live: true, force: true, mode: 'all' });
    expect(opts).toEqual({
      delay: dropTriggerDelay(DAY_T, '19:00'),
      idempotencyKey: 'drop-vera-2026-08-07-19:00-r-19',
      concurrencyKey: 'vera',
    });
  });

  it('режим и корты сценария уезжают в payload как есть (вечерняя вахта)', async () => {
    const rules = [rule({ id: 'watch', times: ['21:00'], courts: ['Padel Court 4', 'Padel Court 1'], mode: 'all' })];
    const deps = fakeDeps({ schedules: { listEnabled: vi.fn(async () => rules) } });

    await runDailyPlanner(deps, NOW_2130);

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

  it('сценарии на РАЗНЫЕ часы уходят каждый в свой ран, а сценарии разных профилей не смешиваются', async () => {
    const rules = [
      rule({ id: 'r1', profileId: 'ilya', times: ['20:00'], courts: ['Padel Court 3'] }),
      rule({ id: 'r2', profileId: 'ilya', times: ['21:00'], courts: ['Padel Court 4'] }),
      rule({ id: 'r3', profileId: 'anna', times: ['20:00'], courts: ['Padel Court 1'] }),
    ];
    const at2030 = fakeDeps({ schedules: { listEnabled: vi.fn(async () => rules) } });
    const at2130 = fakeDeps({ schedules: { listEnabled: vi.fn(async () => rules) } });

    const first = await runDailyPlanner(at2030, NOW);
    const second = await runDailyPlanner(at2130, NOW_2130);

    expect(first.dropsTriggered).toBe(2);
    expect(at2030.triggerDropMock.mock.calls.map(([p]) => [p.profileId, p.time, p.courts])).toEqual([
      ['ilya', '20:00', ['Padel Court 3']],
      ['anna', '20:00', ['Padel Court 1']],
    ]);
    expect(second.dropsTriggered).toBe(1);
    expect(at2130.triggerDropMock.mock.calls.map(([p]) => [p.profileId, p.time, p.courts])).toEqual([
      ['ilya', '21:00', ['Padel Court 4']],
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
    expect(summary.dropsTriggered).toBe(1);
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
    // ilya упал на своём единственном в этот час time (20:00); anna (второй
    // профиль) обработан полностью: её триггер прошёл.
    expect(triggerDropMock).toHaveBeenCalledTimes(2);
    expect(summary.dropsTriggered).toBe(1);
    expect(summary.messagesSent).toBe(2);
  });

  it('несколько времён одного правила — каждый час ставит СВОЙ ран, и только его', async () => {
    const rules = [rule({ times: ['20:00', '21:00', '22:00'] })];
    const at2230 = new Date('2026-07-31T18:30:00.000Z');
    const planned: string[] = [];
    for (const at of [NOW, NOW_2130, at2230]) {
      const deps = fakeDeps({ schedules: { listEnabled: vi.fn(async () => rules) } });
      const summary = await runDailyPlanner(deps, at);
      expect(summary.dropsTriggered).toBe(1);
      planned.push(deps.triggerDropMock.mock.calls[0]![0].time);
    }
    expect(planned).toEqual(['20:00', '21:00', '22:00']);
  });

  it('прошедший час — норма почасовой модели, а не ошибка: ран 20:30 молча пропускает 19:00 и не трогает 21:00', async () => {
    const deps = fakeDeps({ schedules: { listEnabled: vi.fn(async () => [rule({ times: ['19:00', '21:00'] })]) } });

    const summary = await runDailyPlanner(deps, NOW);

    expect(summary).toMatchObject({ messagesSent: 0, dropsTriggered: 0, errors: [] });
    expect(deps.sendPreDropMock).not.toHaveBeenCalled();
    expect(deps.triggerDropMock).not.toHaveBeenCalled();
  });

  it('pre-drop сообщение уходит один раз в день — перед ПЕРВЫМ дропом сценария, а не в каждый его час', async () => {
    const rules = [rule({ times: ['19:00', '21:00'] })];
    const at1930 = fakeDeps({ schedules: { listEnabled: vi.fn(async () => rules) } });
    const at2130 = fakeDeps({ schedules: { listEnabled: vi.fn(async () => rules) } });

    const first = await runDailyPlanner(at1930, NOW_1930);
    const second = await runDailyPlanner(at2130, NOW_2130);

    expect(first).toMatchObject({ messagesSent: 1, dropsTriggered: 1 });
    // В сообщении — весь план дня, включая час, который поставит другой ран.
    expect(String(at1930.sendPreDropMock.mock.calls[0]![1])).toContain('19:00, 21:00');
    expect(second).toMatchObject({ messagesSent: 0, dropsTriggered: 1 });
    expect(at2130.sendPreDropMock).not.toHaveBeenCalled();
  });

  it('все времена правила уже в прошлом — ни сообщения, ни триггеров, ни ошибок', async () => {
    const deps = fakeDeps({ schedules: { listEnabled: vi.fn(async () => [rule({ times: ['08:00', '19:00'] })]) } });

    const summary = await runDailyPlanner(deps, NOW);

    expect(summary).toMatchObject({ messagesSent: 0, dropsTriggered: 0, errors: [] });
    expect(deps.sendPreDropMock).not.toHaveBeenCalled();
  });
});

describe('splitTimesByDrop', () => {
  it('раскладывает времена относительно рана: прошедший час, свой час, будущий', () => {
    expect(splitTimesByDrop(['19:00', '20:00', '21:00'], DAY_T, NOW)).toEqual({
      past: ['19:00'],
      due: ['20:00'],
      later: ['21:00'],
    });
  });

  it('час прошёл, когда закрылось ОКНО дропа, а не когда прошёл момент отправки', () => {
    // Крон опоздал до 20:57 — дроп 20:00 всё ещё свой: окно закрывается в 21:03:30,
    // триггер с прошедшим delay выполняется немедленно и успевает в окно.
    const at2057 = dropTriggerDelay(DAY_T, '20:00');
    expect(splitTimesByDrop(['20:00'], DAY_T, at2057).due).toEqual(['20:00']);
    const deadline = dropWatchWindow(DAY_T, '20:00').deadline;
    expect(splitTimesByDrop(['20:00'], DAY_T, new Date(deadline.getTime() - 1)).due).toEqual(['20:00']);
    expect(splitTimesByDrop(['20:00'], DAY_T, deadline).past).toEqual(['20:00']);
  });

  it('горизонт рана — 60 минут: 20:30 не видит 21:00, а опоздавший до 20:58 видит (дубль отсечёт idempotencyKey)', () => {
    expect(splitTimesByDrop(['21:00'], DAY_T, NOW).later).toEqual(['21:00']);
    const at2058 = new Date(NOW.getTime() + 28 * 60_000);
    expect(splitTimesByDrop(['20:00', '21:00'], DAY_T, at2058).due).toEqual(['20:00', '21:00']);
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
  it('id и cron соответствуют контракту (каждый час в :30 UTC = :30 Тбилиси, ран H:30 ставит час H)', () => {
    const config = dailyPlannerTask as unknown as { id: string; cron: string; queue?: { concurrencyLimit?: number } };
    expect(config.id).toBe('daily-planner');
    expect(config.cron).toBe('30 * * * *');
    // План дня дописывается через read-merge-write: два рана одновременно
    // (крон + ручной Replay) затёрли бы друг другу слоты.
    expect(config.queue).toEqual({ concurrencyLimit: 1 });
  });
});

describe('planner_last_run: отметка «планировщик сегодня отработал»', () => {
  // Без этой отметки heartbeat не отличает «вечер спланирован, просто нечего
  // было бронировать» от «cron не тикнул / ран упал» — то есть от молчаливого
  // провала, ради которого heartbeat и существует.

  it('plannerLastRunValue: включённый — чистый тбилисский stamp', () => {
    expect(plannerLastRunValue(NOW, true)).toBe('2026-07-31T20:30:00.000+04:00');
  });

  it('plannerLastRunValue: выключенный — тот же stamp с префиксом disabled@', () => {
    expect(plannerLastRunValue(NOW, false)).toBe(`${PLANNER_DISABLED_PREFIX}2026-07-31T20:30:00.000+04:00`);
    // дата в отметке та же: heartbeat сверяет её с сегодняшним днём
    expect(plannerLastRunValue(NOW, false)).toContain('2026-07-31');
  });

  it('успешный ран пишет отметку ровно один раз', async () => {
    const deps = fakeDeps();

    await runDailyPlanner(deps, NOW);

    const lastRunCalls = deps.settingsSetMock.mock.calls.filter(([key]) => key === PLANNER_LAST_RUN_KEY);
    expect(lastRunCalls).toHaveLength(1);
    expect(deps.settingsSetMock).toHaveBeenCalledWith(PLANNER_LAST_RUN_KEY, plannerLastRunValue(NOW, true));
  });

  it('выключенный планировщик тоже отмечается — он отработал, просто не бронирует', async () => {
    const deps = fakeDeps({ settings: { get: vi.fn(async () => null) } });

    const summary = await runDailyPlanner(deps, NOW);

    expect(summary.enabled).toBe(false);
    expect(deps.settingsSetMock).toHaveBeenCalledWith(PLANNER_LAST_RUN_KEY, plannerLastRunValue(NOW, false));
  });

  it('отметка ставится ПОСЛЕ сообщений и триггеров, а не вместо них', async () => {
    const order: string[] = [];
    const deps = fakeDeps({
      sendPreDrop: async () => {
        order.push('message');
        return true;
      },
      triggerDrop: async () => {
        order.push('drop');
      },
      settings: {
        get: settingsGet(),
        set: async (key: string) => {
          order.push(key === PLANNER_LAST_PLAN_KEY ? 'plan' : 'mark');
        },
      },
    });

    await runDailyPlanner(deps, NOW);

    // План — тоже после дропов: в него попадает то, что реально поставлено.
    expect(order).toEqual(['message', 'drop', 'plan', 'mark']);
  });

  it('сбой записи отметки не роняет ран: сообщения и дропы уже ушли', async () => {
    const deps = fakeDeps({
      settings: {
        get: settingsGet(),
        set: async () => {
          throw new Error('PostgREST 503');
        },
      },
    });

    const summary = await runDailyPlanner(deps, NOW);

    expect(summary.dropsTriggered).toBe(1);
    expect(summary.errors).toEqual([]); // это не проблема профиля, а проблема отметки
  });

  it('ошибки по отдельным профилям отметке не мешают: сам ран отработал', async () => {
    const deps = fakeDeps({
      triggerDrop: async () => {
        throw new Error('trigger.dev 503');
      },
    });

    const summary = await runDailyPlanner(deps, NOW);

    expect(summary.errors.length).toBeGreaterThan(0);
    expect(deps.settingsSetMock).toHaveBeenCalledWith(PLANNER_LAST_RUN_KEY, plannerLastRunValue(NOW, true));
  });

  it('план дня записан вместе с отметкой: heartbeat сверяет квитанции с ним', async () => {
    const deps = fakeDeps();

    await runDailyPlanner(deps, NOW);

    const call = deps.settingsSetMock.mock.calls.find(([key]) => key === PLANNER_LAST_PLAN_KEY);
    expect(call).toBeDefined();
    const plan = parsePlannerPlan(String(call![1]));
    expect(plan).toEqual({
      date: DATE,
      at: '2026-07-31T20:30:00.000+04:00',
      slots: [{ profileId: 'ilya', time: '20:00' }],
    });
  });

  it('план дня копится по ранам: 21:30 дописывает 21:00 к записанному раном 20:30', async () => {
    const stored = formatPlannerPlan({
      date: DATE,
      at: '2026-07-31T20:30:00.000+04:00',
      slots: [{ profileId: 'ilya', time: '20:00' }],
    });
    const deps = fakeDeps({
      settings: { get: settingsGet({ [PLANNER_LAST_PLAN_KEY]: stored, [PLANNER_LAST_RUN_KEY]: '2026-07-31T20:30:00.000+04:00' }) },
    });

    await runDailyPlanner(deps, NOW_2130);

    expect(planWritten(deps)).toEqual({
      date: DATE,
      at: '2026-07-31T21:30:00.000+04:00',
      slots: [
        { profileId: 'ilya', time: '20:00' },
        { profileId: 'ilya', time: '21:00' },
      ],
    });
  });

  it('нечитаемое значение плана не перезаписывается: свой час не пишем, отметка рана ставится', async () => {
    // Иначе одна битая строка стёрла бы дропы прошлых часов; чинится руками.
    const deps = fakeDeps({ settings: { get: settingsGet({ [PLANNER_LAST_PLAN_KEY]: '{битый json' }) } });

    const summary = await runDailyPlanner(deps, NOW);

    expect(summary.dropsTriggered).toBe(1);
    expect(deps.settingsSetMock.mock.calls.map(([key]) => key)).toEqual([PLANNER_LAST_RUN_KEY]);
  });

  it('предыдущий включённый ран отметился, а его дропов в плане нет — план помечается неполным', async () => {
    // Ран 20:30 поставил 20:00 и записал отметку, но план записать не смог.
    const lastRun = '2026-07-31T20:30:00.000+04:00';
    const noPlan = fakeDeps({ settings: { get: settingsGet({ [PLANNER_LAST_RUN_KEY]: lastRun }) } });
    await runDailyPlanner(noPlan, NOW_2130);
    expect(planWritten(noPlan)).toEqual({
      date: DATE,
      at: '2026-07-31T21:30:00.000+04:00',
      slots: [{ profileId: 'ilya', time: '21:00' }],
      incomplete: true,
    });

    // То же, если план есть, но от более раннего рана (19:30): его слоты остаются.
    const stale = formatPlannerPlan({
      date: DATE,
      at: '2026-07-31T19:30:00.000+04:00',
      slots: [{ profileId: 'vera', time: '19:00' }],
    });
    const stalePlan = fakeDeps({
      settings: { get: settingsGet({ [PLANNER_LAST_RUN_KEY]: lastRun, [PLANNER_LAST_PLAN_KEY]: stale }) },
    });
    await runDailyPlanner(stalePlan, NOW_2130);
    expect(planWritten(stalePlan)).toEqual({
      date: DATE,
      at: '2026-07-31T21:30:00.000+04:00',
      slots: [
        { profileId: 'vera', time: '19:00' },
        { profileId: 'ilya', time: '21:00' },
      ],
      incomplete: true,
    });
  });

  it('план не помечается неполным, если он от того же рана, что отметка, отметка вчерашняя или от выключенного рана', async () => {
    const at2030 = '2026-07-31T20:30:00.000+04:00';
    const cases: Record<string, string | null>[] = [
      {
        [PLANNER_LAST_RUN_KEY]: at2030,
        [PLANNER_LAST_PLAN_KEY]: formatPlannerPlan({ date: DATE, at: at2030, slots: [{ profileId: 'ilya', time: '20:00' }] }),
      },
      { [PLANNER_LAST_RUN_KEY]: '2026-07-30T21:30:00.000+04:00' },
      { [PLANNER_LAST_RUN_KEY]: `disabled@${at2030}` },
    ];
    for (const values of cases) {
      const deps = fakeDeps({ settings: { get: settingsGet(values) } });
      await runDailyPlanner(deps, NOW_2130);
      expect(planWritten(deps)?.incomplete).toBeUndefined();
      expect(planWritten(deps)?.slots).toContainEqual({ profileId: 'ilya', time: '21:00' });
    }
  });

  it('флаг неполноты доезжает до конца дня', async () => {
    const at2030 = '2026-07-31T20:30:00.000+04:00';
    const stored = formatPlannerPlan({ date: DATE, at: at2030, slots: [{ profileId: 'ilya', time: '20:00' }], incomplete: true });
    const deps = fakeDeps({
      settings: { get: settingsGet({ [PLANNER_LAST_RUN_KEY]: at2030, [PLANNER_LAST_PLAN_KEY]: stored }) },
    });

    await runDailyPlanner(deps, NOW_2130);

    expect(planWritten(deps)).toMatchObject({
      incomplete: true,
      slots: [
        { profileId: 'ilya', time: '20:00' },
        { profileId: 'ilya', time: '21:00' },
      ],
    });
  });

  it('записанный план за другую дату (вчерашний) заменяется, а не дописывается', async () => {
    const stored = formatPlannerPlan({
      date: '2026-08-06',
      at: '2026-07-30T21:30:00.000+04:00',
      slots: [{ profileId: 'ilya', time: '21:00' }],
    });
    const deps = fakeDeps({ settings: { get: settingsGet({ [PLANNER_LAST_PLAN_KEY]: stored }) } });

    await runDailyPlanner(deps, NOW);

    expect(planWritten(deps)).toEqual({
      date: DATE,
      at: '2026-07-31T20:30:00.000+04:00',
      slots: [{ profileId: 'ilya', time: '20:00' }],
    });
  });

  it('записанный план не прочитан — свой час не пишем (не стирать прошлые часы), отметка рана всё равно ставится', async () => {
    const deps = fakeDeps({
      settings: {
        get: vi.fn(async (key: string) => {
          if (key === PLANNER_LAST_PLAN_KEY) throw new Error('PostgREST 500');
          return 'true';
        }),
      },
    });

    const summary = await runDailyPlanner(deps, NOW);

    expect(summary.dropsTriggered).toBe(1);
    expect(summary.errors).toEqual([]);
    expect(deps.settingsSetMock.mock.calls.map(([key]) => key)).toEqual([PLANNER_LAST_RUN_KEY]);
  });

  it('скипнутый профиль в план не попадает — сторож не ждёт по нему отчётов', async () => {
    const deps = fakeDeps({ skips: { isSkipped: vi.fn(async () => true) } });

    await runDailyPlanner(deps, NOW);

    const call = deps.settingsSetMock.mock.calls.find(([key]) => key === PLANNER_LAST_PLAN_KEY);
    // Пустой план — это ФАКТ «сегодня не ставили ничего», а не отсутствие плана:
    // снятый вечером скип уже не заставит heartbeat выдумать пропавшие отчёты.
    expect(parsePlannerPlan(String(call![1]))?.slots).toEqual([]);
  });

  it('сорвавшийся триггер всё равно попадает в план: несостоявшийся ран — как раз повод для тревоги', async () => {
    const deps = fakeDeps({
      triggerDrop: async () => {
        throw new Error('trigger.dev 503');
      },
    });

    await runDailyPlanner(deps, NOW);

    const call = deps.settingsSetMock.mock.calls.find(([key]) => key === PLANNER_LAST_PLAN_KEY);
    expect(parsePlannerPlan(String(call![1]))?.slots).toEqual([{ profileId: 'ilya', time: '20:00' }]);
  });

  it('сбой записи плана не роняет ран и не мешает отметке', async () => {
    const deps = fakeDeps({
      settings: {
        get: settingsGet(),
        set: vi.fn(async (key: string) => {
          if (key === PLANNER_LAST_PLAN_KEY) throw new Error('PostgREST 503');
        }),
      },
    });

    const summary = await runDailyPlanner(deps, NOW);

    expect(summary.dropsTriggered).toBe(1);
    expect(summary.errors).toEqual([]);
    expect(deps.settingsSetMock).toHaveBeenCalledWith(PLANNER_LAST_RUN_KEY, plannerLastRunValue(NOW, true));
  });

  it('выключенный планировщик план не пишет — вечер не планировался', async () => {
    const deps = fakeDeps({ settings: { get: vi.fn(async () => null) } });

    await runDailyPlanner(deps, NOW);

    expect(deps.settingsSetMock.mock.calls.map(([key]) => key)).toEqual([PLANNER_LAST_RUN_KEY]);
  });

  it('ран упал до конца — отметки нет, и heartbeat скажет об этом вслух', async () => {
    const deps = fakeDeps({
      schedules: {
        listEnabled: async () => {
          throw new Error('Supabase не отвечает');
        },
      },
    });

    await expect(runDailyPlanner(deps, NOW)).rejects.toThrow('Supabase не отвечает');
    expect(deps.settingsSetMock).not.toHaveBeenCalled();
  });
});
