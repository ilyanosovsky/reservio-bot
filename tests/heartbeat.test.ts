// Тесты сторожа наблюдаемости: чистые функции (src/core/heartbeat-logic.ts) и
// оркестрация runHeartbeat (src/trigger/heartbeat.ts) на фейковых зависимостях.
//
// Главное, что здесь проверяется: сторож молчит, когда вечер прошёл по плану, и
// НЕ молчит ни в одном из сценариев молчаливого провала — не отработал
// планировщик, нет квитанции по слоту, квитанция есть но отчёт не доехал в
// Telegram, умер процесс бота. И отдельно: если разбудить админов не удалось,
// ран обязан упасть, а не тихо вернуть «всё хорошо».
import { describe, expect, it, vi } from 'vitest';
import { tbilisiStamp, weekdayOf } from '../src/core/scheduler.js';
import {
  adminChatIds,
  botAliveProblem,
  dropIsDue,
  eveningWasPlanned,
  expectedFromPlan,
  expectedReceipts,
  formatHeartbeatAlert,
  formatPlannerPlan,
  parsePlannerPlan,
  parseTbilisiStamp,
  plannerRunMoment,
  plannerRunProblem,
  receiptProblems,
  BOT_STALE_MS,
  REPORT_GRACE_MS,
  type DropReceipt,
  type HeartbeatProfile,
} from '../src/core/heartbeat-logic.js';

// heartbeatTask регистрируется через schedules.task при импорте модуля (и то же
// делает daily-planner.ts, который heartbeat импортирует ради selectEligibleRules)
// — подменяем SDK на «верни конфиг как есть», как в tests/daily-planner.test.ts.
vi.mock('@trigger.dev/sdk', () => ({
  schedules: { task: (config: unknown) => config },
  task: (config: unknown) => config,
  tasks: { trigger: vi.fn() },
  idempotencyKeys: { create: vi.fn() },
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), log: vi.fn() },
}));

const { heartbeatTask, runHeartbeat } = await import('../src/trigger/heartbeat.js');
type HeartbeatDeps = import('../src/trigger/heartbeat.js').HeartbeatDeps;
type PlannerRule = import('../src/trigger/daily-planner.js').PlannerRule;

// ---- фикстуры ----

/** Крон сторожа: 22:12 Тбилиси 04.08 = 18:12 UTC. */
const NOW = new Date('2026-08-04T18:12:00.000Z');
const TODAY = '2026-08-04'; // день наблюдения дропов T
const DATE = '2026-08-11'; // дата игры T+7

function rule(patch: Partial<PlannerRule> = {}): PlannerRule {
  return {
    id: 'rule-1',
    profileId: 'ilya',
    times: ['20:00', '21:00'],
    courts: ['Padel Court 3', 'Padel Court 4'],
    daysOfWeek: null,
    enabled: true,
    mode: 'all',
    ...patch,
  };
}

function profile(patch: Partial<HeartbeatProfile> = {}): HeartbeatProfile {
  return { id: 'ilya', label: 'Ilya', telegramChatId: '111', isAdmin: true, ...patch };
}

function receipt(patch: Partial<DropReceipt> = {}): DropReceipt {
  return {
    profileId: 'ilya',
    date: DATE,
    time: '20:00',
    ok: true,
    telegramOk: true,
    createdAt: '2026-08-04T21:00:11.000+04:00',
    ...patch,
  };
}

/** Отметка времени в зоне клуба, сдвинутая от NOW на minutes минут назад. */
function stampAgo(minutes: number): string {
  return tbilisiStamp(new Date(NOW.getTime() - minutes * 60_000));
}

interface FakeWorld {
  settings: Record<string, string>;
  rules: PlannerRule[];
  profiles: HeartbeatProfile[];
  /** profileId, у которых стоит скип на дату игры. */
  skipped: string[];
  receipts: DropReceipt[];
}

/** Значение settings.planner_last_plan: те же слоты, что стоят в правилах фикстуры. */
function planValue(times: string[] = ['20:00', '21:00'], patch: { date?: string; profileId?: string } = {}): string {
  return formatPlannerPlan({
    date: patch.date ?? DATE,
    at: stampAgo(102),
    slots: times.map((time) => ({ profileId: patch.profileId ?? 'ilya', time })),
  });
}

function world(patch: Partial<FakeWorld> = {}): FakeWorld {
  return {
    settings: {
      planner_enabled: 'true',
      planner_last_run: stampAgo(102), // 20:30 Тбилиси того же дня
      // planner_last_plan в базовой фикстуре НЕТ намеренно: так проверяется
      // запасной путь (восстановление плана по живым правилам). Основной путь —
      // отдельный describe «план вечера из settings» ниже.
      // Хостинг бота уже поднят — иначе проверка живости выключена (см. тесты
      // «тумблер проверки живости» ниже).
      bot_alive_required: 'true',
      bot_alive_at: stampAgo(2),
    },
    rules: [rule()],
    profiles: [profile()],
    skipped: [],
    receipts: [receipt({ time: '20:00' }), receipt({ time: '21:00' })],
    ...patch,
  };
}

interface Spies {
  alertAdmins: ReturnType<typeof vi.fn>;
  listForDate: ReturnType<typeof vi.fn>;
  settingsGet: ReturnType<typeof vi.fn>;
}

function makeDeps(w: FakeWorld, over: Partial<HeartbeatDeps> = {}): { deps: HeartbeatDeps; spies: Spies } {
  const settingsGet = vi.fn(async (key: string) => w.settings[key] ?? null);
  const listForDate = vi.fn(async (date: string) => w.receipts.filter((r) => r.date === date));
  const alertAdmins = vi.fn(async (_text: string, chatIds: readonly string[]) => chatIds.length);
  const deps: HeartbeatDeps = {
    settings: { get: settingsGet },
    schedules: { listEnabled: async () => w.rules },
    profiles: { list: async () => w.profiles },
    skips: { isSkipped: async (profileId: string) => w.skipped.includes(profileId) },
    dropReports: { listForDate },
    alertAdmins,
    ...over,
  };
  return { deps, spies: { alertAdmins, listForDate, settingsGet } };
}

/** Текст единственного алерта, если он был отправлен. */
function alertText(spies: Spies): string {
  expect(spies.alertAdmins).toHaveBeenCalledTimes(1);
  return String(spies.alertAdmins.mock.calls[0]![0]);
}

// ------------------------------- чистые функции -------------------------------

describe('parseTbilisiStamp', () => {
  it('читает отметку с оффсетом клуба и её календарный день', () => {
    const parsed = parseTbilisiStamp('2026-08-04T20:30:00.123+04:00');
    expect(parsed?.date).toBe('2026-08-04');
    expect(parsed?.disabled).toBe(false);
    expect(parsed?.at.toISOString()).toBe('2026-08-04T16:30:00.123Z');
  });

  it('снимает префикс выключенного планировщика', () => {
    const parsed = parseTbilisiStamp('disabled@2026-08-04T20:30:00.000+04:00');
    expect(parsed?.disabled).toBe(true);
    expect(parsed?.date).toBe('2026-08-04');
  });

  it('мусор, пустая строка и отсутствующий ключ — null (сторож обязан поднять тревогу, а не поверить)', () => {
    expect(parseTbilisiStamp(null)).toBeNull();
    expect(parseTbilisiStamp('   ')).toBeNull();
    expect(parseTbilisiStamp('вчера')).toBeNull();
    // Чужая таймзона в отметке = кто-то писал её мимо tbilisiStamp: не доверяем.
    expect(parseTbilisiStamp('2026-08-04T20:30:00.000Z')).toBeNull();
  });
});

describe('plannerRunProblem', () => {
  it('сегодняшняя отметка — проблемы нет', () => {
    expect(plannerRunProblem(stampAgo(102), TODAY)).toBeNull();
  });

  it("отметка 'disabled@' сегодняшним днём тоже считается «отработал»", () => {
    expect(plannerRunProblem(`disabled@${stampAgo(102)}`, TODAY)).toBeNull();
  });

  it('вчерашняя отметка — планировщик сегодня не отработал', () => {
    const problem = plannerRunProblem('2026-08-03T20:30:00.000+04:00', TODAY);
    expect(problem).toContain('планировщик сегодня не отработал');
    expect(problem).toContain('2026-08-03');
  });

  it('ключа нет — отдельная формулировка про отсутствующую отметку', () => {
    expect(plannerRunProblem(null, TODAY)).toContain('нет вовсе');
  });

  it('нечитаемое значение — тоже находка', () => {
    expect(plannerRunProblem('ok', TODAY)).toContain('нечитаема');
  });
});

describe('plannerRunMoment', () => {
  it('сегодняшняя отметка — берём момент из неё (в т.ч. ручной ран в неурочный час)', () => {
    expect(plannerRunMoment('2026-08-04T21:30:00.000+04:00', TODAY).toISOString()).toBe('2026-08-04T17:30:00.000Z');
  });

  it("префикс 'disabled@' не мешает прочитать момент", () => {
    expect(plannerRunMoment('disabled@2026-08-04T20:30:00.000+04:00', TODAY).toISOString()).toBe(
      '2026-08-04T16:30:00.000Z',
    );
  });

  it('отметки нет или она не сегодняшняя — штатный крон 20:30 Тбилиси', () => {
    expect(plannerRunMoment(null, TODAY).toISOString()).toBe('2026-08-04T16:30:00.000Z');
    expect(plannerRunMoment('2026-08-03T20:30:00.000+04:00', TODAY).toISOString()).toBe('2026-08-04T16:30:00.000Z');
  });
});

describe('eveningWasPlanned', () => {
  // Ждать ли квитанции, решает ОТМЕТКА планировщика за сегодня, а не текущее
  // значение флага: флаг переключают руками в любой час, в том числе между
  // кроном планировщика (20:30) и кроном сторожа (22:12).

  it('планировщик отработал включённым, а флаг выключили позже — квитанции всё равно ждём', () => {
    // Поставленный в 20:30 ран отработает и в 21:57, даже если в 21:20 флаг
    // сняли: его отчёт обязан доехать до человека, иначе останется бронь, о
    // которой никто не знает.
    const decision = eveningWasPlanned(stampAgo(102), TODAY, false);
    expect(decision).toMatchObject({ ranToday: true, expectReceipts: true });
  });

  it("отметка 'disabled@' за сегодня — вечер не планировался, даже если флаг уже включён", () => {
    const decision = eveningWasPlanned(`disabled@${stampAgo(102)}`, TODAY, true);
    expect(decision).toMatchObject({ ranToday: true, expectReceipts: false });
    expect(decision.reason).toContain('disabled@');
  });

  it('сегодняшней отметки нет — ориентируемся на текущий флаг', () => {
    expect(eveningWasPlanned(null, TODAY, true)).toMatchObject({ ranToday: false, expectReceipts: true });
    expect(eveningWasPlanned(null, TODAY, false)).toMatchObject({ ranToday: false, expectReceipts: false });
  });

  it('вчерашняя отметка — то же, что её отсутствие', () => {
    expect(eveningWasPlanned('2026-08-03T20:30:00.000+04:00', TODAY, true)).toMatchObject({
      ranToday: false,
      expectReceipts: true,
    });
  });
});

describe('formatPlannerPlan / parsePlannerPlan', () => {
  const plan = {
    date: DATE,
    at: '2026-08-04T20:30:00.000+04:00',
    slots: [{ profileId: 'ilya', time: '20:00' }],
  };

  it('туда-обратно без потерь', () => {
    expect(parsePlannerPlan(formatPlannerPlan(plan))).toEqual(plan);
  });

  it('пустой план (все профили скипнуты) — это факт, а не отсутствие плана', () => {
    expect(parsePlannerPlan(formatPlannerPlan({ ...plan, slots: [] }))?.slots).toEqual([]);
  });

  it('мусор и чужая форма — null (сторож уйдёт на запасной путь, а не сверит с половиной)', () => {
    expect(parsePlannerPlan(null)).toBeNull();
    expect(parsePlannerPlan('   ')).toBeNull();
    expect(parsePlannerPlan('не json')).toBeNull();
    expect(parsePlannerPlan('[]')).toBeNull();
    expect(parsePlannerPlan('{"date":"вчера","at":"x","slots":[]}')).toBeNull();
    expect(parsePlannerPlan(`{"date":"${DATE}","at":"x"}`)).toBeNull();
    expect(parsePlannerPlan(`{"date":"${DATE}","at":"x","slots":[{"time":"20:00"}]}`)).toBeNull();
  });
});

describe('expectedFromPlan', () => {
  const labelOf = (id: string): string => (id === 'ilya' ? 'Ilya' : id);

  it('берёт только часы, чей дроп уже прошёл, и не плодит дублей', () => {
    const expected = expectedFromPlan(
      [
        { profileId: 'ilya', time: '20:00' },
        { profileId: 'ilya', time: '20:00' },
        { profileId: 'ilya', time: '22:00' },
      ],
      DATE,
      labelOf,
      NOW,
    );
    expect(expected).toEqual([{ profileId: 'ilya', label: 'Ilya', date: DATE, time: '20:00' }]);
  });

  it('профиль, удалённый после планирования, называется своим id — молчать про его слот нельзя', () => {
    const expected = expectedFromPlan([{ profileId: 'ghost', time: '20:00' }], DATE, labelOf, NOW);
    expect(expected[0]?.label).toBe('ghost');
  });
});

describe('botAliveProblem', () => {
  it('свежая отметка — бот жив', () => {
    expect(botAliveProblem(stampAgo(2), NOW)).toBeNull();
  });

  it('граница 15 минут: ровно на грани — жив, чуть старше — находка', () => {
    const edge = tbilisiStamp(new Date(NOW.getTime() - BOT_STALE_MS));
    expect(botAliveProblem(edge, NOW)).toBeNull();
    const stale = tbilisiStamp(new Date(NOW.getTime() - BOT_STALE_MS - 1_000));
    const problem = botAliveProblem(stale, NOW);
    expect(problem).toContain('не подаёт признаков жизни');
    expect(problem).toContain(stale);
  });

  it('отметки нет вовсе — находка', () => {
    expect(botAliveProblem(null, NOW)).toContain('нет вовсе');
  });

  it('нечитаемая отметка — находка', () => {
    expect(botAliveProblem('alive', NOW)).toContain('нечитаема');
  });

  it('отметка из будущего (часы хоста убежали) тревогу не поднимает', () => {
    expect(botAliveProblem(stampAgo(-30), NOW)).toBeNull();
  });
});

describe('dropIsDue', () => {
  it('к 22:12 дропы 20:00 и 21:00 уже прошли, 22:00 — ещё нет', () => {
    expect(dropIsDue(TODAY, '20:00', NOW)).toBe(true);
    expect(dropIsDue(TODAY, '21:00', NOW)).toBe(true);
    expect(dropIsDue(TODAY, '22:00', NOW)).toBe(false);
    expect(dropIsDue(TODAY, '23:00', NOW)).toBe(false);
  });

  it('отсечка — закрытие окна дропа плюс запас на отчёт', () => {
    // Окно слота 21:00 закрывается в 22:03:30 Тбилиси = 18:03:30 UTC.
    const closes = new Date('2026-08-04T18:03:30.000Z').getTime();
    expect(dropIsDue(TODAY, '21:00', new Date(closes + REPORT_GRACE_MS))).toBe(true);
    expect(dropIsDue(TODAY, '21:00', new Date(closes + REPORT_GRACE_MS - 1))).toBe(false);
  });

  it('мусорное время в правиле — квитанции не ждём (дроп по нему не ставился)', () => {
    expect(dropIsDue(TODAY, '25:99', NOW)).toBe(false);
    expect(dropIsDue(TODAY, 'вечером', NOW)).toBe(false);
  });
});

describe('expectedReceipts', () => {
  const eligible = (times: string[], patch: Partial<PlannerRule> = {}) => [
    { rule: rule({ times, ...patch }), profile: profile() },
  ];

  it('берёт только те часы, чей дроп уже прошёл', () => {
    const expected = expectedReceipts(eligible(['20:00', '21:00', '22:00']), DATE, NOW);
    expect(expected.map((e) => e.time)).toEqual(['20:00', '21:00']);
    expect(expected[0]).toEqual({ profileId: 'ilya', label: 'Ilya', date: DATE, time: '20:00' });
  });

  it('два сценария профиля на один час = ОДНА ожидаемая квитанция (планировщик схлопывает их в один ран)', () => {
    const expected = expectedReceipts(
      [
        { rule: rule({ id: 'r1', times: ['20:00'] }), profile: profile() },
        { rule: rule({ id: 'r2', times: ['20:00', '21:00'] }), profile: profile() },
      ],
      DATE,
      NOW,
    );
    expect(expected.map((e) => e.time)).toEqual(['20:00', '21:00']);
  });

  it('разные профили на один час — две квитанции', () => {
    const expected = expectedReceipts(
      [
        { rule: rule({ times: ['20:00'] }), profile: profile() },
        { rule: rule({ profileId: 'dasha', times: ['20:00'] }), profile: profile({ id: 'dasha', label: 'Даша' }) },
      ],
      DATE,
      NOW,
    );
    expect(expected.map((e) => `${e.profileId} ${e.time}`)).toEqual(['ilya 20:00', 'dasha 20:00']);
  });
});

describe('receiptProblems', () => {
  const expected = [{ profileId: 'ilya', label: 'Ilya', date: DATE, time: '20:00' }];

  it('квитанции нет — находка с часом и профилем', () => {
    expect(receiptProblems(expected, [])).toEqual([
      expect.stringContaining('нет отчёта по 20:00 (профиль Ilya)'),
    ]);
  });

  it('квитанция за другой слот/профиль/дату не засчитывается', () => {
    const strangers = [
      receipt({ time: '21:00' }),
      receipt({ profileId: 'dasha' }),
      receipt({ date: '2026-08-10' }),
    ];
    expect(receiptProblems(expected, strangers)).toHaveLength(1);
  });

  it('telegram_ok=false — отчёт не доехал до человека', () => {
    expect(receiptProblems(expected, [receipt({ telegramOk: false })])).toEqual([
      'отчёт по 20:00 не доставлен в Telegram (профиль Ilya)',
    ]);
  });

  it('провал самой брони находкой не считается: про него человеку уже написали', () => {
    expect(receiptProblems(expected, [receipt({ ok: false, telegramOk: true })])).toEqual([]);
  });

  it('несколько квитанций на слот (Replay рана): достаточно одной доставленной', () => {
    expect(receiptProblems(expected, [receipt({ telegramOk: false }), receipt({ telegramOk: true })])).toEqual([]);
  });
});

describe('adminChatIds', () => {
  it('только админы с чатом, без дублей', () => {
    expect(
      adminChatIds([
        profile({ id: 'ilya', telegramChatId: '111' }),
        profile({ id: 'dasha', telegramChatId: '222', isAdmin: false }),
        profile({ id: 'admin2', telegramChatId: '111' }),
        profile({ id: 'nochat', telegramChatId: null }),
        profile({ id: 'blank', telegramChatId: '  ' }),
      ]),
    ).toEqual(['111']);
  });

  it('админов нет — пустой список', () => {
    expect(adminChatIds([profile({ isAdmin: false })])).toEqual([]);
  });
});

describe('formatHeartbeatAlert', () => {
  it('каждая находка — отдельной строкой, HTML экранирован', () => {
    const text = formatHeartbeatAlert({
      at: '2026-08-04T22:12:00.000+04:00',
      targetDate: DATE,
      problems: ['нет отчёта по 20:00 (профиль Ilya)', 'корт <b>&</b>'],
    });
    const lines = text.split('\n');
    expect(lines[0]).toContain('Heartbeat');
    expect(lines[1]).toContain(DATE);
    expect(lines[2]).toBe('• нет отчёта по 20:00 (профиль Ilya)');
    expect(lines[3]).toBe('• корт &lt;b&gt;&amp;&lt;/b&gt;');
    expect(text).toContain('Runbook');
  });
});

// -------------------------------- runHeartbeat --------------------------------

describe('runHeartbeat: вечер прошёл по плану', () => {
  it('молчит и не шлёт ничего', async () => {
    const { deps, spies } = makeDeps(world());
    const summary = await runHeartbeat(deps, NOW);
    expect(summary.problems).toEqual([]);
    expect(summary.targetDate).toBe(DATE);
    expect(summary.plannerEnabled).toBe(true);
    expect(summary.expected).toEqual([
      { profileId: 'ilya', time: '20:00' },
      { profileId: 'ilya', time: '21:00' },
    ]);
    expect(summary.alertedChats).toBe(0);
    expect(spies.alertAdmins).not.toHaveBeenCalled();
    expect(summary.checks.every((c) => c.status !== 'problem')).toBe(true);
  });

  it('скип на дату игры снимает ожидания (дропов в этот день не было)', async () => {
    const { deps, spies } = makeDeps(world({ skipped: ['ilya'], receipts: [] }));
    const summary = await runHeartbeat(deps, NOW);
    expect(summary.expected).toEqual([]);
    expect(summary.problems).toEqual([]);
    expect(spies.alertAdmins).not.toHaveBeenCalled();
  });

  it('час, который планировщик не мог поставить (дроп прошёл до крона 20:30), ожиданий не создаёт', async () => {
    // Правило на 19:00: момент отправки 19:57 прошёл ещё до крона планировщика,
    // дропа не было — ждать по такому часу квитанцию значит будить админов зря.
    const { deps, spies } = makeDeps(world({ rules: [rule({ times: ['19:00', '20:00'] })] }));
    const summary = await runHeartbeat(deps, NOW);
    expect(summary.expected).toEqual([{ profileId: 'ilya', time: '20:00' }]);
    expect(summary.problems).toEqual([]);
    expect(spies.alertAdmins).not.toHaveBeenCalled();
  });

  it('планировщик отработал позже обычного — часы, чей дроп он уже пропустил, не ждём', async () => {
    const w = world({ rules: [rule({ times: ['20:00', '21:00'] })], receipts: [receipt({ time: '21:00' })] });
    // Ручной ран планировщика в 21:30: слот 20:00 (отправка в 20:57) он пропустил.
    w.settings['planner_last_run'] = '2026-08-04T21:30:00.000+04:00';
    const { deps } = makeDeps(w);
    const summary = await runHeartbeat(deps, NOW);
    expect(summary.expected).toEqual([{ profileId: 'ilya', time: '21:00' }]);
    expect(summary.problems).toEqual([]);
  });

  it('правило на другой день недели ожиданий не создаёт', async () => {
    const otherDay = (weekdayOf(DATE) + 1) % 7;
    const { deps } = makeDeps(world({ rules: [rule({ daysOfWeek: [otherDay] })], receipts: [] }));
    const summary = await runHeartbeat(deps, NOW);
    expect(summary.expected).toEqual([]);
    expect(summary.problems).toEqual([]);
  });

  it('мусорное время в правиле сторожа не роняет: остальные часы проверяются как обычно', async () => {
    const { deps } = makeDeps(world({ rules: [rule({ times: ['вечером', '20:00', '21:00'] })] }));
    const summary = await runHeartbeat(deps, NOW);
    expect(summary.expected).toEqual([
      { profileId: 'ilya', time: '20:00' },
      { profileId: 'ilya', time: '21:00' },
    ]);
    expect(summary.problems).toEqual([]);
  });

  it('профиль без chat_id не бронируется планировщиком — квитанций с него не ждём', async () => {
    const { deps } = makeDeps(world({ profiles: [profile({ telegramChatId: null })], receipts: [] }));
    const summary = await runHeartbeat(deps, NOW).catch((err: Error) => err);
    // Админ-чатов не осталось, но и находок нет — ран проходит молча.
    expect(summary).not.toBeInstanceOf(Error);
    expect((summary as Awaited<ReturnType<typeof runHeartbeat>>).problems).toEqual([]);
  });
});

describe('runHeartbeat: находки', () => {
  it('нет квитанции по слоту — одно сообщение админам', async () => {
    const { deps, spies } = makeDeps(world({ receipts: [receipt({ time: '20:00' })] }));
    const summary = await runHeartbeat(deps, NOW);
    expect(summary.problems).toEqual([expect.stringContaining('нет отчёта по 21:00 (профиль Ilya)')]);
    expect(summary.alertedChats).toBe(1);
    expect(alertText(spies)).toContain('нет отчёта по 21:00');
    expect(spies.alertAdmins.mock.calls[0]![1]).toEqual(['111']);
  });

  it('квитанция есть, но отчёт не доехал в Telegram', async () => {
    const w = world({ receipts: [receipt({ time: '20:00' }), receipt({ time: '21:00', telegramOk: false })] });
    const { deps, spies } = makeDeps(w);
    const summary = await runHeartbeat(deps, NOW);
    expect(summary.problems).toEqual(['отчёт по 21:00 не доставлен в Telegram (профиль Ilya)']);
    expect(alertText(spies)).toContain('не доставлен в Telegram');
  });

  it('планировщик сегодня не отработал', async () => {
    const w = world();
    w.settings['planner_last_run'] = '2026-08-03T20:30:00.000+04:00';
    const { deps, spies } = makeDeps(w);
    const summary = await runHeartbeat(deps, NOW);
    expect(summary.problems).toEqual([expect.stringContaining('планировщик сегодня не отработал')]);
    expect(spies.alertAdmins).toHaveBeenCalledTimes(1);
  });

  it('несколько находок уезжают ОДНИМ сообщением', async () => {
    const w = world({ receipts: [] });
    w.settings['planner_last_run'] = '2026-08-03T20:30:00.000+04:00';
    w.settings['bot_alive_at'] = stampAgo(40);
    const { deps, spies } = makeDeps(w);
    const summary = await runHeartbeat(deps, NOW);
    expect(summary.problems).toHaveLength(4); // планировщик + бот + два слота
    const text = alertText(spies);
    expect(text).toContain('планировщик сегодня не отработал');
    expect(text).toContain('не подаёт признаков жизни');
    expect(text).toContain('нет отчёта по 20:00');
    expect(text).toContain('нет отчёта по 21:00');
  });

  it('два сценария на один час дают ОДНУ строку находки', async () => {
    const w = world({
      rules: [rule({ id: 'r1', times: ['20:00'] }), rule({ id: 'r2', times: ['20:00'] })],
      receipts: [],
    });
    const { deps } = makeDeps(w);
    const summary = await runHeartbeat(deps, NOW);
    expect(summary.problems).toEqual([expect.stringContaining('нет отчёта по 20:00')]);
  });
});

describe('runHeartbeat: живость бота не зависит от планировщика', () => {
  it('планировщик выключен — отчёты не проверяем, но мёртвого бота находим', async () => {
    const w = world({ receipts: [] });
    w.settings['planner_enabled'] = 'false';
    // Выключенный планировщик всё равно отмечается — с префиксом disabled@.
    w.settings['planner_last_run'] = `disabled@${stampAgo(102)}`;
    w.settings['bot_alive_at'] = stampAgo(60);
    const { deps, spies } = makeDeps(w);
    const summary = await runHeartbeat(deps, NOW);
    expect(summary.plannerEnabled).toBe(false);
    expect(summary.problems).toEqual([expect.stringContaining('не подаёт признаков жизни')]);
    expect(spies.listForDate).not.toHaveBeenCalled();
    expect(summary.checks.filter((c) => c.status === 'skipped').map((c) => c.name)).toEqual(['drop_reports']);
    expect(spies.alertAdmins).toHaveBeenCalledTimes(1);
  });

  it('планировщик выключен и сегодня не отмечался — обе его проверки пропущены', async () => {
    const w = world({ receipts: [] });
    w.settings['planner_enabled'] = 'false';
    delete w.settings['planner_last_run'];
    const { deps, spies } = makeDeps(w);
    const summary = await runHeartbeat(deps, NOW);
    expect(summary.problems).toEqual([]);
    expect(summary.checks.filter((c) => c.status === 'skipped').map((c) => c.name)).toEqual([
      'planner_last_run',
      'drop_reports',
    ]);
    expect(spies.alertAdmins).not.toHaveBeenCalled();
  });

  it('планировщик выключен и бот жив — полная тишина', async () => {
    const w = world({ receipts: [] });
    w.settings['planner_enabled'] = 'false';
    w.settings['planner_last_run'] = `disabled@${stampAgo(102)}`;
    const { deps, spies } = makeDeps(w);
    const summary = await runHeartbeat(deps, NOW);
    expect(summary.problems).toEqual([]);
    expect(spies.alertAdmins).not.toHaveBeenCalled();
  });

  it('отметки живости нет вовсе — тоже находка', async () => {
    const w = world();
    delete w.settings['bot_alive_at'];
    const { deps } = makeDeps(w);
    const summary = await runHeartbeat(deps, NOW);
    expect(summary.problems).toEqual([expect.stringContaining('нет вовсе')]);
  });
});

describe('runHeartbeat: флаг планировщика переключили после крона', () => {
  it('выключили в 21:20 — недоставленный отчёт по уже поставленному рану всё равно находим', async () => {
    // Худший сценарий ложного молчания: ран отработал и забронировал корт, его
    // отчёт не доехал, а сторож промолчал бы, увидев planner_enabled='false'.
    const w = world({ receipts: [receipt({ time: '20:00' }), receipt({ time: '21:00', telegramOk: false })] });
    w.settings['planner_enabled'] = 'false'; // снят вручную уже после крона
    const { deps, spies } = makeDeps(w);
    const summary = await runHeartbeat(deps, NOW);
    expect(summary.problems).toEqual(['отчёт по 21:00 не доставлен в Telegram (профиль Ilya)']);
    expect(spies.alertAdmins).toHaveBeenCalledTimes(1);
  });

  it('включили в 21:00 (отметка сегодня с disabled@) — квитанций не ждём, алерта нет', async () => {
    // Зеркальный случай: вечер активации флага. Дропов не ставилось, и требовать
    // по ним отчёты — два бессмысленных алерта в первый же вечер.
    const w = world({ receipts: [] });
    w.settings['planner_enabled'] = 'true';
    w.settings['planner_last_run'] = `disabled@${stampAgo(102)}`;
    const { deps, spies } = makeDeps(w);
    const summary = await runHeartbeat(deps, NOW);
    expect(summary.problems).toEqual([]);
    expect(summary.expected).toEqual([]);
    expect(spies.listForDate).not.toHaveBeenCalled();
    expect(spies.alertAdmins).not.toHaveBeenCalled();
  });
});

describe('runHeartbeat: план вечера берётся из settings, а не из живых правил', () => {
  // Расписание и скипы владелец правит ВЕСЬ вечер: первая кнопка меню «⏭ Скип»
  // — ровно дата T+7. Сверять квитанции с состоянием правил на 22:12 значит
  // ловить ложные «нет отчёта» после каждой такой правки.

  it('скип сняли в 21:00 — сторож молчит: дропов в этот вечер не ставилось', async () => {
    const listEnabled = vi.fn(async () => [rule()]);
    const isSkipped = vi.fn(async () => false); // скип уже снят к моменту проверки
    const w = world({ receipts: [] });
    w.settings['planner_last_plan'] = planValue([]); // в 20:30 профиль был скипнут
    const { deps, spies } = makeDeps(w, { schedules: { listEnabled }, skips: { isSkipped } });
    const summary = await runHeartbeat(deps, NOW);
    expect(summary.expected).toEqual([]);
    expect(summary.problems).toEqual([]);
    expect(spies.alertAdmins).not.toHaveBeenCalled();
    // Живые правила и скипы при наличии плана не читаются вовсе.
    expect(listEnabled).not.toHaveBeenCalled();
    expect(isSkipped).not.toHaveBeenCalled();
  });

  it('новый сценарий завели в 21:30 — ждём только то, что реально поставлено', async () => {
    const w = world({
      // В живых правилах уже два часа, а планировался только один.
      rules: [rule({ times: ['20:00', '21:00'] })],
      receipts: [receipt({ time: '20:00' })],
    });
    w.settings['planner_last_plan'] = planValue(['20:00']);
    const { deps, spies } = makeDeps(w);
    const summary = await runHeartbeat(deps, NOW);
    expect(summary.expected).toEqual([{ profileId: 'ilya', time: '20:00' }]);
    expect(summary.problems).toEqual([]);
    expect(spies.alertAdmins).not.toHaveBeenCalled();
  });

  it('поставленный дроп не отчитался — находка приходит по плану, а не по правилам', async () => {
    const w = world({ rules: [], receipts: [] }); // правила успели удалить
    w.settings['planner_last_plan'] = planValue(['20:00', '21:00']);
    const { deps } = makeDeps(w);
    const summary = await runHeartbeat(deps, NOW);
    expect(summary.problems).toEqual([
      expect.stringContaining('нет отчёта по 20:00 (профиль Ilya)'),
      expect.stringContaining('нет отчёта по 21:00 (профиль Ilya)'),
    ]);
  });

  it('час, чей дроп ещё впереди, из плана не ждём', async () => {
    const w = world({ receipts: [receipt({ time: '20:00' }), receipt({ time: '21:00' })] });
    w.settings['planner_last_plan'] = planValue(['20:00', '21:00', '23:00']);
    const { deps } = makeDeps(w);
    expect((await runHeartbeat(deps, NOW)).problems).toEqual([]);
  });

  it('план на другую дату или нечитаемый — запасной путь по живым правилам, помеченный в output', async () => {
    for (const value of [planValue(['20:00'], { date: '2026-08-10' }), '{битый json']) {
      const w = world({ receipts: [] });
      w.settings['planner_last_plan'] = value;
      const { deps } = makeDeps(w);
      const summary = await runHeartbeat(deps, NOW);
      expect(summary.checks.find((c) => c.name === 'planner_last_plan')?.status).toBe('skipped');
      // Ожидания восстановлены по правилам фикстуры (20:00 и 21:00).
      expect(summary.expected).toHaveLength(2);
    }
  });

  it('план не прочитался из-за сбоя Supabase — тоже запасной путь, причина в detail', async () => {
    const w = world();
    const settingsGet = vi.fn(async (key: string) => {
      if (key === 'planner_last_plan') throw new Error('PostgREST 500');
      return w.settings[key] ?? null;
    });
    const { deps } = makeDeps(w, { settings: { get: settingsGet } });
    const summary = await runHeartbeat(deps, NOW);
    expect(summary.problems).toEqual([]);
    expect(summary.checks.find((c) => c.name === 'planner_last_plan')?.detail).toContain('PostgREST 500');
  });
});

describe('runHeartbeat: тумблер проверки живости бота', () => {
  // Пока процесс бота не на хостинге (PLAN.md → фаза 4), он живёт на ноутбуке
  // владельца: включённая по умолчанию проверка алертила бы КАЖДУЮ ночь, в том
  // числе после идеально отработавшего вечера, — и алерты сторожа приучились бы
  // смахивать не читая.

  it('bot_alive_required не задан — проверка пропущена, отметки может не быть вовсе', async () => {
    const w = world();
    delete w.settings['bot_alive_required'];
    delete w.settings['bot_alive_at'];
    const { deps, spies } = makeDeps(w);
    const summary = await runHeartbeat(deps, NOW);
    expect(summary.problems).toEqual([]);
    expect(summary.checks.find((c) => c.name === 'bot_alive')?.status).toBe('skipped');
    expect(spies.alertAdmins).not.toHaveBeenCalled();
  });

  it('bot_alive_required не задан — протухшая отметка тоже молчит', async () => {
    const w = world();
    delete w.settings['bot_alive_required'];
    w.settings['bot_alive_at'] = stampAgo(600);
    const { deps } = makeDeps(w);
    expect((await runHeartbeat(deps, NOW)).problems).toEqual([]);
  });

  it('включённый тумблер возвращает проверку: мёртвый бот — находка', async () => {
    const w = world();
    w.settings['bot_alive_required'] = 'true';
    w.settings['bot_alive_at'] = stampAgo(60);
    const { deps } = makeDeps(w);
    expect((await runHeartbeat(deps, NOW)).problems).toEqual([
      expect.stringContaining('не подаёт признаков жизни'),
    ]);
  });

  it('значение не строго "true" тумблером не считается', async () => {
    const w = world();
    w.settings['bot_alive_required'] = 'TRUE';
    delete w.settings['bot_alive_at'];
    const { deps } = makeDeps(w);
    expect((await runHeartbeat(deps, NOW)).problems).toEqual([]);
  });
});

describe('runHeartbeat: отказ самих проверок — тоже находка', () => {
  it('квитанции не прочитались: говорим об этом, а не выдумываем «нет отчёта» по каждому слоту', async () => {
    const { deps, spies } = makeDeps(world(), {
      dropReports: {
        listForDate: async () => {
          throw new Error('Supabase вернул HTTP 500');
        },
      },
    });
    const summary = await runHeartbeat(deps, NOW);
    expect(summary.problems).toHaveLength(1);
    expect(summary.problems[0]).toContain('квитанции за 2026-08-11 не прочитаны');
    expect(alertText(spies)).toContain('HTTP 500');
  });

  it('правила расписания не прочитались — план вечера сверить не с чем', async () => {
    const { deps } = makeDeps(world(), {
      schedules: {
        listEnabled: async () => {
          throw new Error('нет таблицы schedule_rules');
        },
      },
    });
    const summary = await runHeartbeat(deps, NOW);
    expect(summary.problems).toEqual([expect.stringContaining('правила расписания не прочитаны')]);
  });

  it('скип не проверился — отдельная строка (иначе получилось бы ложное «нет отчёта»)', async () => {
    const { deps } = makeDeps(world(), {
      skips: {
        isSkipped: async () => {
          throw new Error('таймаут Supabase');
        },
      },
    });
    const summary = await runHeartbeat(deps, NOW);
    expect(summary.problems).toEqual([expect.stringContaining('скип профиля "ilya" на 2026-08-11 не проверен')]);
  });

  it('настройки не прочитались — планировщик считается выключенным, но находка есть', async () => {
    const { deps } = makeDeps(world(), {
      settings: {
        get: async () => {
          throw new Error('Supabase отклонил ключ');
        },
      },
    });
    const summary = await runHeartbeat(deps, NOW);
    expect(summary.plannerEnabled).toBe(false);
    // Тумблер живости при отказе чтения считается ВКЛЮЧЁННЫМ: ошибиться в
    // сторону тревоги безопаснее, чем молча выключить проверку из-за сбоя.
    expect(summary.problems).toEqual([
      expect.stringContaining('planner_enabled не прочитана'),
      expect.stringContaining('bot_alive_at не прочитана'),
      expect.stringContaining('planner_last_run не прочитана'),
    ]);
  });
});

describe('runHeartbeat: алерт обязан дойти', () => {
  it('никому не доставили — ран падает с перечислением находок', async () => {
    const { deps } = makeDeps(world({ receipts: [] }), { alertAdmins: async () => 0 });
    await expect(runHeartbeat(deps, NOW)).rejects.toThrow(/не доставлен ни одному админу[\s\S]*нет отчёта по 20:00/);
  });

  it('админов с чатом нет — ран падает, отправку даже не пробуем', async () => {
    const { deps, spies } = makeDeps(
      world({ receipts: [], profiles: [profile({ isAdmin: false })] }),
    );
    await expect(runHeartbeat(deps, NOW)).rejects.toThrow(/админ-чатов: 0/);
    expect(spies.alertAdmins).not.toHaveBeenCalled();
  });

  it('отправка упала с исключением — ран падает, ошибка попадает в текст', async () => {
    const { deps } = makeDeps(world({ receipts: [] }), {
      alertAdmins: async () => {
        throw new Error('Telegram недоступен');
      },
    });
    await expect(runHeartbeat(deps, NOW)).rejects.toThrow(/ошибка отправки: Telegram недоступен/);
  });

  it('доставили части админов — ран успешен, в сводке число чатов', async () => {
    const w = world({
      receipts: [],
      profiles: [profile(), profile({ id: 'dasha', label: 'Даша', telegramChatId: '222' })],
    });
    const { deps } = makeDeps(w, { alertAdmins: async () => 1 });
    const summary = await runHeartbeat(deps, NOW);
    expect(summary.alertedChats).toBe(1);
  });
});

describe('heartbeatTask', () => {
  it('крон 22:12 Тбилиси (18:12 UTC) — после обоих вечерних дропов и их отчётов', () => {
    const config = heartbeatTask as unknown as { id: string; cron: string };
    expect(config.id).toBe('heartbeat');
    expect(config.cron).toBe('12 18 * * *');
  });
});
