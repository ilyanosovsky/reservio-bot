// Таск trigger.dev "heartbeat" — сторож инварианта наблюдаемости.
// Крон '12 19 * * *' (UTC) = 23:12 Asia/Tbilisi (+04:00, круглый год без DST):
// вечерние дропы (…, 19:59, 20:59, 21:59, 22:59) к этому моменту закрыты,
// отчёты отправлены, квитанции записаны. Часы после 23:00 сторож не ждёт
// (dropIsDue). До 18.09.2026 крон был в 22:12 — слот 22:00 (сценарий
// владельца «21:00+22:00») он не проверил бы никогда.
//
// Зачем он есть. CLAUDE.md: «КАЖДЫЙ вечер в Telegram уходит ровно одно сообщение
// — успех / ошибка / пропущено по команде. Молчаливый провал — худший баг этого
// проекта». Вечерний ран держит этот инвариант только пока он ЖИВ: если крон
// планировщика не тикнул, воркер умер, Supabase лежал или Telegram не принял
// сообщение — сказать об этом некому, и вечер тихо пропадает. Сторож закрывает
// ровно эту дыру: он сверяет ПЛАН вечера (те же schedule_rules + скипы, что у
// планировщика) с КВИТАНЦИЯМИ (drop_reports, их пишет book-drop.ts после
// доставки отчёта) и, если что-то не сошлось, шлёт ОДНО сообщение админам.
// Всё сошлось — сторож молчит: тишина здесь и есть «зелёный».
//
// Что проверяется (детали и разбор каждого алерта — docs/wiki/Runbook.md):
//   1. planner_last_run сегодняшним днём — планировщик вообще отработал;
//   2. по каждому ожидавшемуся слоту есть квитанция в drop_reports;
//   3. у квитанции telegram_ok = true — отчёт реально доехал до человека;
//   4. bot_alive_at не старше 15 минут — процесс Telegram-бота жив.
// Пункты 2–3 имеют смысл, только если день РЕАЛЬНО планировался. Первый
// источник правды — записанный план дня (settings.planner_last_plan): это
// список ранов, которые почасовой планировщик (ран в H:30 ставит дропы часа H)
// реально поставил, и если в нём есть слоты — квитанции по ним обязаны быть,
// что бы ни говорил флаг planner_enabled сейчас (его переключают руками в любой
// час, в том числе между ранами планировщика). Плана нет — решает сегодняшняя
// отметка planner_last_run: с префиксом 'disabled@' — последний ран отработал
// выключенным, без префикса — включённым (см. eveningWasPlanned). Пункт 4 от
// планировщика не зависит вовсе, но включается явным тумблером
// bot_alive_required: пока процесс бота живёт на ноутбуке владельца, а не на
// хостинге, эта проверка алертила бы каждую ночь.
//
// Восстановление плана из живых schedule_rules/skips осталось запасным путём:
// расписание и скипы владелец правит и вечером (снял скип с даты T+7 в 21:00 —
// и сторож ждал бы квитанции по дропам, которых никто не ставил).
//
// Отдельный принцип: отказ любой из проверок (не прочитались настройки,
// правила, квитанции) сам становится находкой. Сторож, который молча не смог
// ничего проверить и отрапортовал «всё чисто», хуже отсутствующего сторожа.
// Если находки есть, а доставить их не удалось НИ ОДНОМУ админу — ран падает
// (throw): FAILED в дашборде trigger.dev остаётся последним следом проблемы.
// Ретраев у тасков проекта нет (trigger.config.ts: maxAttempts 1), поэтому
// повторных алертов из-за падения не будет.
//
// Приватность: в алерт, логи и output рана не попадают ни chat_id, ни токены,
// ни контакты профиля — только label профиля, времена слотов и тексты находок
// (чужие тексты ошибок проходят через redactSecrets).
//
// Изоляция от репозиториев: вся логика — чистые функции (src/core/heartbeat-
// logic.ts) плюс runHeartbeat(deps, now) на структурных интерфейсах. Реальные
// Supabase-репозитории подключаются динамическим import() внутри buildDeps(),
// которая зовётся только из боевого run() — тесты работают на фейковых deps.

import { logger, schedules } from '@trigger.dev/sdk';
import { sendTelegram, type TelegramTarget } from '../core/notify.js';
import { targetDate, tbilisiDateOf, tbilisiStamp } from '../core/scheduler.js';
import {
  adminChatIds,
  botAliveProblem,
  eveningWasPlanned,
  expectedFromPlan,
  expectedReceipts,
  formatHeartbeatAlert,
  mergeExpectedReceipts,
  parsePlannerPlan,
  planLagsBehindRun,
  plannerRunProblem,
  receiptProblems,
  BOT_ALIVE_KEY,
  BOT_ALIVE_REQUIRED_KEY,
  BOT_ALIVE_REQUIRED_VALUE,
  PLANNER_ENABLED_KEY,
  PLANNER_ENABLED_VALUE,
  PLANNER_LAST_PLAN_KEY,
  PLANNER_LAST_RUN_KEY,
  type DropReceipt,
  type ExpectedReceipt,
  type HeartbeatProfile,
} from '../core/heartbeat-logic.js';
// Правила применимости дня и отбор профилей берём У ПЛАНИРОВЩИКА, а не пишем
// заново: две копии этих правил разъедутся, и сторож начнёт будить админов
// из-за собственной ошибки.
import { selectEligibleRules, type PlannerProfile, type PlannerRule } from './daily-planner.js';

/** Имена env, значения которых не должны попасть в лог/алерт/output ни при какой ошибке. */
const SECRET_ENV_NAMES = ['SUPABASE_SERVICE_ROLE_KEY', 'TELEGRAM_BOT_TOKEN', 'CLIENT_NAME', 'CLIENT_EMAIL', 'CLIENT_PHONE'];

/** Попытки доставки алерта в один чат — как в book-drop.ts: 429/502 не должны стоить нам сообщения. */
const DELIVER_ATTEMPTS = 3;
const DELIVER_PAUSE_MS = 1_500;

// ------------------------------- типы рана ---------------------------------

/** Одна проверка сторожа в output рана. */
export interface HeartbeatCheck {
  name: string;
  status: 'ok' | 'problem' | 'skipped';
  detail?: string;
}

export interface HeartbeatSummary {
  /** Момент проверки в зоне клуба. */
  at: string;
  /** Дата игры (T+7), про которую шёл вечер. */
  targetDate: string;
  plannerEnabled: boolean;
  checks: HeartbeatCheck[];
  problems: string[];
  /** Ожидавшиеся квитанции — без chat_id и контактов. */
  expected: Array<{ profileId: string; time: string }>;
  /** Скольким админ-чатам ушёл алерт (сами id не выводим — персональные данные). */
  alertedChats: number;
}

export interface HeartbeatDeps {
  settings: { get(key: string): Promise<string | null> };
  schedules: { listEnabled(): Promise<PlannerRule[]> };
  profiles: { list(): Promise<HeartbeatProfile[]> };
  skips: { isSkipped(profileId: string, date: string): Promise<boolean> };
  dropReports: { listForDate(date: string): Promise<DropReceipt[]> };
  /** Шлёт готовый текст в перечисленные чаты; возвращает, скольким реально доставлено. */
  alertAdmins(text: string, chatIds: readonly string[]): Promise<number>;
}

// ------------------------------ вспомогательное -----------------------------

function describeError(err: unknown): string {
  if (err instanceof Error) {
    const { status, code } = err as Error & { status?: number; code?: string };
    return [err.message, status === undefined ? null : `status=${status}`, code ? `code=${code}` : null]
      .filter((p): p is string => p !== null && p !== '')
      .join(' ');
  }
  return String(err);
}

/** Чужой текст ошибки любит цитировать URL с ключом или контакт профиля — вырезаем значения. */
function redactSecrets(text: string): string {
  let out = text;
  for (const name of SECRET_ENV_NAMES) {
    const value = process.env[name];
    // короткие значения не режем: слишком велик шанс задеть обычный текст
    if (value !== undefined && value.length >= 8) out = out.split(value).join(`[${name}]`);
  }
  return out;
}

/** Кусок чужого текста в находке: длинная ошибка не должна вытеснить остальные строки алерта. */
const DETAIL_LIMIT = 200;

function clampDetail(text: string): string {
  return text.length <= DETAIL_LIMIT ? text : `${text.slice(0, DETAIL_LIMIT)}…`;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// --------------------------- оркестрация (I/O) ------------------------------

/**
 * Сверяет план вечера с квитанциями и, если что-то не сошлось, будит админов.
 *
 * Бросает исключение РОВНО В ОДНОМ случае: находки есть, а доставить их не
 * удалось никому — тогда единственным следом остаётся FAILED-ран в дашборде.
 * Отказ отдельной проверки исключением не считается: он превращается в находку
 * и уезжает в том же сообщении.
 */
export async function runHeartbeat(deps: HeartbeatDeps, now: Date): Promise<HeartbeatSummary> {
  const at = tbilisiStamp(now);
  const today = tbilisiDateOf(now); // календарный день Тбилиси = день наблюдения дропов T
  const date = targetDate(now); // T+7 — дата игры, про которую шёл вечер

  const checks: HeartbeatCheck[] = [];
  const problems: string[] = [];

  /** Результат проверки: null — чисто, строка — находка (она же попадает в алерт). */
  const record = (name: string, problem: string | null, okDetail?: string): void => {
    if (problem === null) {
      checks.push({ name, status: 'ok', ...(okDetail === undefined || okDetail === '' ? {} : { detail: okDetail }) });
      return;
    }
    checks.push({ name, status: 'problem', detail: problem });
    problems.push(problem);
  };

  const skipCheck = (name: string, why: string): void => {
    checks.push({ name, status: 'skipped', detail: why });
  };

  /** Чтение, которое не имеет права уронить сторожа: отказ возвращается текстом. */
  const read = async <T>(fallback: T, fn: () => Promise<T>): Promise<{ value: T; error: string | null }> => {
    try {
      return { value: await fn(), error: null };
    } catch (err) {
      return { value: fallback, error: clampDetail(redactSecrets(describeError(err))) };
    }
  };

  /**
   * Запасной способ узнать план дня, когда записанного плана нет: собрать его
   * заново по живым правилам — ТОЙ ЖЕ логикой отбора, что у планировщика
   * (selectEligibleRules). Планировщик почасовой, так что ждём квитанцию по
   * КАЖДОМУ уже закрывшемуся часу правила: ран, который его не поставил, — и
   * есть повод для тревоги. Слабое место способа в том, что правила и скипы
   * могли поменяться в течение дня (сценарий на 19:00, заведённый в 20:00,
   * даст ложное «нет отчёта по 19:00»), поэтому он именно запасной.
   */
  async function rebuildExpected(): Promise<ExpectedReceipt[]> {
    const rulesRead = await read<PlannerRule[]>([], () => deps.schedules.listEnabled());
    if (rulesRead.error !== null) {
      record('schedule_rules', `правила расписания не прочитаны: ${rulesRead.error} — план вечера сверить не с чем`);
    }

    const profilesById = new Map<string, PlannerProfile | null>(profilesRead.value.map((p) => [p.id, p]));
    const ruleProfileIds = [...new Set(rulesRead.value.map((r) => r.profileId))];
    const skipped = new Set<string>();
    for (const profileId of ruleProfileIds) {
      const isSkipped = await read(false, () => deps.skips.isSkipped(profileId, date));
      if (isSkipped.error !== null) {
        // Непрочитанный скип может превратиться в ложное «нет отчёта»: честнее
        // сказать об этом отдельной строкой, чем молча посчитать день игровым.
        record('skips', `скип профиля "${profileId}" на ${date} не проверен: ${isSkipped.error}`);
      } else if (isSkipped.value) {
        skipped.add(profileId);
      }
    }

    // Мусорное время в правиле (не HH:MM) сторожа не роняет: dropIsDue внутри
    // expectedReceipts такой час просто не ждёт — планировщик по нему дроп тоже
    // не поставил бы.
    const eligible = selectEligibleRules(rulesRead.value, profilesById, date, skipped);
    return expectedReceipts(eligible, date, now);
  }

  // ---- 1. включён ли планировщик ----
  const flag = await read<string | null>(null, () => deps.settings.get(PLANNER_ENABLED_KEY));
  if (flag.error !== null) {
    record('planner_enabled', `настройка ${PLANNER_ENABLED_KEY} не прочитана: ${flag.error}`);
  }
  const plannerEnabled = flag.value === PLANNER_ENABLED_VALUE;

  // ---- 2. жив ли Telegram-бот (не зависит от планировщика, но включается явно) ----
  // Fallback при отказе чтения — «проверять»: ошибиться в сторону тревоги
  // безопаснее, чем молча выключить проверку из-за сбоя Supabase (сам сбой
  // приедет отдельной строкой — bot_alive_at по той же причине не прочитается).
  const aliveRequired = await read<string | null>(BOT_ALIVE_REQUIRED_VALUE, () =>
    deps.settings.get(BOT_ALIVE_REQUIRED_KEY),
  );
  if (aliveRequired.value !== BOT_ALIVE_REQUIRED_VALUE) {
    skipCheck(
      'bot_alive',
      `${BOT_ALIVE_REQUIRED_KEY} ≠ '${BOT_ALIVE_REQUIRED_VALUE}': процесс бота ещё не на постоянном хостинге, ` +
        'проверка живости выключена (включать шагом деплоя — Runbook → «Heartbeat»)',
    );
  } else {
    const alive = await read<string | null>(null, () => deps.settings.get(BOT_ALIVE_KEY));
    if (alive.error !== null) {
      record('bot_alive', `отметка ${BOT_ALIVE_KEY} не прочитана: ${alive.error}`);
    } else {
      record('bot_alive', botAliveProblem(alive.value, now), alive.value ?? '');
    }
  }

  // ---- 3. профили: и адресаты алерта, и подписи в плане вечера ----
  const profilesRead = await read<HeartbeatProfile[]>([], () => deps.profiles.list());
  if (profilesRead.error !== null) {
    record('profiles', `список профилей не прочитан: ${profilesRead.error}`);
  }
  const chatIds = adminChatIds(profilesRead.value);

  // ---- 4. отработал ли планировщик и планировался ли вечер ----
  // Отметку читаем ВСЕГДА (а не только при включённом флаге): именно она, а не
  // текущее значение planner_enabled, говорит, ставились ли сегодня дропы —
  // флаг могли переключить руками уже после крона планировщика.
  const lastRun = await read<string | null>(null, () => deps.settings.get(PLANNER_LAST_RUN_KEY));
  const evening = eveningWasPlanned(lastRun.value, today, plannerEnabled);
  if (lastRun.error !== null) {
    record(PLANNER_LAST_RUN_KEY, `отметка ${PLANNER_LAST_RUN_KEY} не прочитана: ${lastRun.error}`);
  } else if (!plannerEnabled && !evening.ranToday) {
    // Планировщик выключен и сегодня не отмечался: бронировать было нечего,
    // будить админов не за что.
    skipCheck(PLANNER_LAST_RUN_KEY, `${PLANNER_ENABLED_KEY} ≠ '${PLANNER_ENABLED_VALUE}': планировщик выключен`);
  } else {
    record(PLANNER_LAST_RUN_KEY, plannerRunProblem(lastRun.value, today), lastRun.value ?? '');
  }

  // ---- 5. план дня против квитанций ----
  // Записанный план читаем ВСЕГДА, до решения «ждать ли квитанции»: планировщик
  // почасовой, флаг могли выключить между его ранами — последняя отметка тогда
  // с префиксом 'disabled@', а дропы прошлых часов поставлены и обязаны
  // отчитаться. План с поставленными слотами — факт, и он сильнее флага.
  const planRead = await read<string | null>(null, () => deps.settings.get(PLANNER_LAST_PLAN_KEY));
  const plan = parsePlannerPlan(planRead.value);
  const todaysPlan = plan !== null && plan.date === date ? plan : null;
  const labelOf = (profileId: string): string => profilesRead.value.find((p) => p.id === profileId)?.label ?? profileId;

  // Плану верят только целому: он прочитался, догнал последний включённый ран
  // (ран пишет план и отметку из одного `now` — planLagsBehindRun) и не помечен
  // планировщиком как неполный. Иначе это находка, а не тихий запасной путь:
  // ран поставил дропы, которых в плане нет, и сверять квитанции по одному
  // такому списку значило бы промолчать про них.
  const integrityProblem: string | null =
    planRead.error !== null
      ? `план дня не прочитан: ${planRead.error}`
      : planLagsBehindRun(todaysPlan, lastRun.value, today)
        ? todaysPlan === null
          ? `план дня не записан, хотя планировщик сегодня отработал включённым (отметка ${lastRun.value ?? ''})`
          : `план дня отстал от последнего рана планировщика (план от ${todaysPlan.at}, отметка ${lastRun.value ?? ''}) — ран не записал свои дропы`
        : todaysPlan?.incomplete === true
          ? 'план дня помечен планировщиком как неполный — один из ранов не записал свои дропы'
          : null;

  let expected: ExpectedReceipt[] = [];
  let receiptsExpected = true;
  if (integrityProblem !== null) {
    // Слоты плана — нижняя граница; остальное восстанавливаем по живым правилам.
    record(PLANNER_LAST_PLAN_KEY, `${integrityProblem} — квитанции сверены и по живым правилам расписания`);
    expected = mergeExpectedReceipts(
      todaysPlan === null ? [] : expectedFromPlan(todaysPlan.slots, date, labelOf, now),
      await rebuildExpected(),
    );
  } else if (todaysPlan !== null && (todaysPlan.slots.length > 0 || evening.expectReceipts)) {
    // Основной путь — ЗАПИСАННЫЙ планировщиком план: сверяем квитанции с тем,
    // что реально было поставлено, а не с состоянием расписания на 23:12
    // (скипы и сценарии владелец правит и вечером — см. PLANNER_LAST_PLAN_KEY).
    expected = expectedFromPlan(todaysPlan.slots, date, labelOf, now);
    checks.push({
      name: PLANNER_LAST_PLAN_KEY,
      status: 'ok',
      detail: `план от ${todaysPlan.at}: поставлено ${todaysPlan.slots.length}, отчитаться должны ${expected.length}`,
    });
  } else if (!evening.expectReceipts) {
    receiptsExpected = false;
    skipCheck('drop_reports', evening.reason);
  } else {
    // Запасной путь: плана за эту дату нет, а включённого рана сегодня не было
    // (деплой старее, планировщик не тикал — об этом скажет своя находка).
    // Восстанавливаем план по живым правилам и честно помечаем это в output.
    skipCheck(
      PLANNER_LAST_PLAN_KEY,
      plan === null
        ? 'записанного плана дня нет (или он нечитаем) — восстанавливаем по живым правилам расписания'
        : `записанный план на другую дату (${plan.date}, а нужна ${date}) — восстанавливаем по живым правилам`,
    );
    expected = await rebuildExpected();
  }

  if (receiptsExpected) {
    const receipts = await read<DropReceipt[]>([], () => deps.dropReports.listForDate(date));
    if (receipts.error !== null) {
      // Сверять не с чем: без этой оговорки сторож выдал бы «нет отчёта» по
      // каждому слоту и спрятал настоящую причину.
      record('drop_reports', `квитанции за ${date} не прочитаны: ${receipts.error} (ожидалось отчётов: ${expected.length})`);
    } else {
      const found = receiptProblems(expected, receipts.value);
      if (found.length === 0) {
        record('drop_reports', null, `ожидалось ${expected.length}, квитанций ${receipts.value.length}`);
      } else {
        checks.push({ name: 'drop_reports', status: 'problem', detail: found.join(' · ') });
        problems.push(...found);
      }
    }
  }

  const summary: HeartbeatSummary = {
    at,
    targetDate: date,
    plannerEnabled,
    checks,
    problems,
    expected: expected.map((e) => ({ profileId: e.profileId, time: e.time })),
    alertedChats: 0,
  };

  if (problems.length === 0) {
    logger.info(`heartbeat: всё чисто — проверок ${checks.length}, дата игры ${date}, ожидалось отчётов ${expected.length}`);
    return summary;
  }

  logger.warn(`heartbeat: находок ${problems.length}: ${problems.join(' | ')}`);
  const text = formatHeartbeatAlert({ at, targetDate: date, problems });

  let delivered = 0;
  let sendError: string | null = null;
  if (chatIds.length > 0) {
    try {
      delivered = await deps.alertAdmins(text, chatIds);
    } catch (err) {
      sendError = clampDetail(redactSecrets(describeError(err)));
    }
  }
  summary.alertedChats = delivered;

  if (delivered === 0) {
    // Последняя линия обороны: если сторож не смог никого разбудить, он обязан
    // хотя бы упасть — красный ран в дашборде заметнее тишины.
    throw new Error(
      `Heartbeat: находок ${problems.length}, но алерт не доставлен ни одному админу ` +
        `(админ-чатов: ${chatIds.length}${sendError === null ? '' : `, ошибка отправки: ${sendError}`}). ` +
        `Находки: ${problems.join(' · ')}`,
    );
  }

  logger.info(`heartbeat: алерт доставлен в ${delivered} из ${chatIds.length} админ-чат(ов)`);
  return summary;
}

// -------------------------- боевая обвязка (I/O) ---------------------------

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Не задана обязательная переменная окружения ${name} (см. .env.example)`);
  }
  return value;
}

/** Доставка в один чат с ретраями. sendTelegram не бросает и не раскрывает токен. */
async function deliver(target: TelegramTarget, text: string): Promise<boolean> {
  for (let attempt = 1; attempt <= DELIVER_ATTEMPTS; attempt += 1) {
    if (await sendTelegram(target, text)) return true;
    logger.warn(`heartbeat: алерт не ушёл (попытка ${attempt}/${DELIVER_ATTEMPTS})`);
    if (attempt < DELIVER_ATTEMPTS) await sleep(DELIVER_PAUSE_MS);
  }
  return false;
}

/**
 * Реальные зависимости: Supabase-репозитории (динамический import — см. шапку)
 * и Telegram по TELEGRAM_BOT_TOKEN. Глобальный TELEGRAM_CHAT_ID сторож не
 * использует: адресаты — админ-профили из БД (у каждого свой чат).
 */
async function buildDeps(): Promise<HeartbeatDeps> {
  const { ProfilesRepo, SchedulesRepo, SkipsRepo, SettingsRepo, DropReportsRepo } = await import('../core/repos.js');
  const opts = { url: requireEnv('SUPABASE_URL'), serviceKey: requireEnv('SUPABASE_SERVICE_ROLE_KEY') };
  const botToken = process.env.TELEGRAM_BOT_TOKEN?.trim() ?? '';

  return {
    settings: new SettingsRepo(opts),
    schedules: new SchedulesRepo(opts),
    profiles: new ProfilesRepo(opts),
    skips: new SkipsRepo(opts),
    dropReports: new DropReportsRepo(opts),
    alertAdmins: async (text, chatIds) => {
      if (botToken === '') {
        logger.error('heartbeat: TELEGRAM_BOT_TOKEN не задан — алерт отправить некуда, находки остались в логах рана');
        return 0;
      }
      let sent = 0;
      for (const chatId of chatIds) {
        if (await deliver({ botToken, chatId }, text)) sent += 1;
      }
      return sent;
    },
  };
}

export const heartbeatTask = schedules.task({
  id: 'heartbeat',
  cron: '12 19 * * *', // UTC; = 23:12 Asia/Tbilisi (+04:00, без DST)
  run: async (payload) => {
    const deps = await buildDeps();
    return runHeartbeat(deps, payload.timestamp);
  },
});
