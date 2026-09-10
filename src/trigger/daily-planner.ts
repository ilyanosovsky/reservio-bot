// Таск trigger.dev "daily-planner" — ЕДИНСТВЕННОЕ место в проекте, где cron
// разрешён (schedules.task), но САМ ПЛАНИРОВЩИК ВЫКЛЮЧЕН ПО УМОЛЧАНИЮ.
//
// Активация — только вручную, установкой settings.planner_enabled = 'true'
// (Supabase, таблица settings) по явному одобрению пользователя (включено
// 04.08.2026, docs/wiki/Runbook.md → «Планировщик»). Пока флаг не 'true',
// run() читает settings и молча выходит — cron тикает, но ничего не бронирует
// и никому не пишет.
//
// Модель — ПОЧАСОВАЯ. Слот часа H дня T+7 открывается в H:59 дня T (CLAUDE.md
// → дроп-модель), поэтому крон тикает КАЖДЫЙ час в :30 Тбилиси (= :30 UTC:
// оффсет +04:00 целый и без DST), и ран часа H:30 ставит дропы РОВНО на час H —
// те времена правил, чей момент отправки (H:57) попадает в ближайшие 60 минут
// (splitTimesByDrop → due). Часы, чьё окно уже закрылось, — past (их ничего не
// ждёт), более поздние — later (их поставит свой ран). До 10.09.2026 крон был
// один, в 20:30, и любой час раньше 20:00 он молча пропускал — так сценарий
// второго профиля на 19:00 не отработал ни разу, а узнать об этом было неоткуда.
//
// Что делает включённый ран часа H:30:
//   1) считает целевую дату игры T+7 (scheduler.targetDate) относительно
//      момента запуска (payload.timestamp, а не Date.now() — детерминизм);
//   2) берёт включённые schedule_rule, чей профиль имеет telegram_chat_id,
//      чьё daysOfWeek допускает T+7 и для кого нет skip на T+7;
//   3) шлёт профилю pre-drop сообщение (план: дата/ВСЕ оставшиеся на сегодня
//      времена сценария/корты) с inline-кнопками «Пропустить» (callback_data
//      'skip:{date}', ловит src/bot/handlers — пишет skip) и «Бронируем»
//      (callback_data 'noop' — ровно CB_NOOP из src/bot/parse.ts, бот гасит
//      спиннер и ничего не делает). Сообщение уходит ОДИН раз в день на
//      сценарий — в ран перед его ПЕРВЫМ дропом (past пуст, due не пуст):
//      сценарий «20:00+21:00» получает одно сообщение в 20:30, как и раньше,
//      а не по одному на каждый час;
//   4) на каждый (профиль, час) из due планирует src/trigger/book-drop.ts через
//      tasks.trigger('book-slot-drop', ..., { delay, idempotencyKey,
//      concurrencyKey }) — delay = H:57:00 дня T (+04:00), idempotencyKey =
//      'drop-{profileId}-{date}-{time}-{ruleIds}' — повторный ран (Replay,
//      опоздавший крон, зацепивший и следующий час) не создаёт дубль дропа.
//      Несколько сценариев профиля на ОДИН час схлопываются в ОДИН ран
//      (mergePlannedDrops): у book-slot-drop concurrencyLimit 1 на
//      concurrencyKey=profileId, поэтому два рана на один час выстроились бы в
//      затылок — второй пришёл бы в уже закрытое окно, не сделал бы ни одного
//      опроса и прислал бы второй ❌-отчёт. В payload уезжают courts и mode
//      ИМЕННО ЭТИХ правил: выбор сценария делается здесь, а не повторно в
//      book-drop.ts по времени.
//      Ключ идемпотентности обязан быть ГЛОБАЛЬНЫМ: голая строка,
//      переданная из тела таска, скоупится ран-айди родителя (см. makeTriggerDrop).
//      concurrencyKey = profileId: у book-slot-drop concurrencyLimit 1, и без
//      ключа дроп второго профиля ждал бы, пока первый досидит своё пятиминутное
//      окно, — то есть не сделал бы ни одного опроса.
//      Триггерим с force:true: критерий «этот день недели ок» уже проверен
//      здесь по данным Supabase (schedule_rules) — book-drop.ts второй раз
//      сверяет это по правилу профиля и без force кинул бы отказ;
//   5) дописывает поставленные дропы в settings.planner_last_plan
//      ({date, at, slots:[{profileId,time}]}) — план ДНЯ копится по ранам
//      (mergePlannerPlan: тот же date → объединение слотов, новый date —
//      замена целиком); по нему heartbeat в 22:12 сверяет квитанции. Живые
//      schedule_rules для этого не годятся — владелец правит их и вечером
//      (снятый в 21:00 скип на T+7 заставил бы сторожа ждать отчёты по
//      дропам, которых никто не ставил);
//   6) в конце УСПЕШНОГО рана ставит settings.planner_last_run = тбилисский
//      stamp (у выключенного планировщика — он же с префиксом 'disabled@').
//      По этой отметке heartbeat в 22:12 понимает, что cron сегодня реально
//      тикал: без неё «день не спланирован» никак не отличить от «всё
//      спланировано, просто нечего было бронировать».
//
// Следствие почасовой модели для правок расписания: выключенный или удалённый
// сценарий перестаёт бронировать со СЛЕДУЮЩЕГО часа; дроп текущего часа, если
// его ран уже поставлен (в H:30), отменяет только «⏭ Скип» на дату игры —
// book-drop.ts перечитывает скипы перед окном.
//
// Изоляция от src/core/repos.ts: он живёт в отдельном контракте фазы 3 и на
// момент написания этого файла может ещё не существовать на диске (агенты
// пишут параллельно). Поэтому вся логика выбора/расчёта — чистые функции и
// runDailyPlanner(deps, now), принимающие ЛОКАЛЬНО объявленные структурные
// интерфейсы (PlannerProfile/PlannerRule/PlannerDeps) — TypeScript проверяет
// их совместимость с реальными ProfilesRepo/SchedulesRepo/SkipsRepo/
// SettingsRepo по форме, без импорта типов. Реальный repos.ts подключается
// ТОЛЬКО динамическим import() внутри buildDeps(), которая вызывается лишь из
// боевого run() — тесты этого файла (runDailyPlanner напрямую, с фейковыми
// deps) его не задевают и не требуют присутствия repos.ts на диске.

import { idempotencyKeys, logger, schedules, tasks } from '@trigger.dev/sdk';
import type { BookSlotDropPayload } from './book-drop.js';
import { dropDayOf, dropWatchWindow, slotStartISO, targetDate, tbilisiStamp, weekdayOf } from '../core/scheduler.js';
// Ключи таблицы settings живут в ОДНОМ месте (core/heartbeat-logic.ts): их
// читает сторож наблюдаемости, и разъехавшаяся строка означала бы, что вечер
// планируется, а heartbeat считает планировщик мёртвым. Модуль чистый (тянет
// только core/scheduler.js) — обвязке планировщика он ничего лишнего не приносит.
import {
  formatPlannerPlan,
  mergePlannerPlan,
  parsePlannerPlan,
  planLagsBehindRun,
  PLANNER_DISABLED_PREFIX,
  PLANNER_ENABLED_KEY,
  PLANNER_ENABLED_VALUE,
  PLANNER_LAST_PLAN_KEY,
  PLANNER_LAST_RUN_KEY,
} from '../core/heartbeat-logic.js';

export { PLANNER_DISABLED_PREFIX, PLANNER_LAST_PLAN_KEY, PLANNER_LAST_RUN_KEY };

/** Сколько минут до конца часа H шлём book-slot-drop дню T: H:57:00 +04:00. */
const TRIGGER_LEAD_MINUTES = 57;

/**
 * Горизонт одного рана планировщика. Крон тикает в H:30, момент отправки дропа
 * часа H — H:57, следующего часа — (H+1):57, то есть через 87 минут: 60 минут
 * берут свой час и не задевают соседний даже при кроне, опоздавшем на полчаса.
 * А если задели (ручной Replay в конце часа) — от дубля защищает глобальный
 * idempotencyKey (см. makeTriggerDrop).
 */
const PLAN_HORIZON_MS = 60 * 60_000;

// ---- структурные типы (зеркалят src/core/repos.ts, но не импортируют его) ----

/** Подмножество ProfileRow, нужное планировщику: адресат и подпись сообщения. */
export interface PlannerProfile {
  id: string;
  label: string;
  telegramChatId: string | null;
}

/** Зеркало ScheduleRuleRow (см. контракт src/core/repos.ts). */
export interface PlannerRule {
  id: string;
  profileId: string;
  times: string[];
  courts: string[];
  daysOfWeek: number[] | null;
  enabled: boolean;
  /**
   * 'priority' — первый доступный корт по приоритету; 'all' — вечерняя вахта,
   * бронируем КАЖДЫЙ появившийся корт набора. Планировщик обязан знать режим:
   * он уезжает в payload дропа (см. runDailyPlanner) — иначе book-drop.ts
   * доставал бы его из БД сам и на профиле с НЕСКОЛЬКИМИ сценариями мог взять
   * чужой (там выбор идёт по времени: первое включённое правило с этим часом).
   */
  mode: 'priority' | 'all';
}

export interface PlannerTriggerOptions {
  /** Момент отправки рана дропа: H:57:00 дня T. */
  delay: Date;
  /** 'drop-{profileId}-{date}-{time}-{ruleIds}'; глобальный скоуп обеспечивает makeTriggerDrop. */
  idempotencyKey: string;
  /**
   * Ключ очереди — profileId. У book-slot-drop concurrencyLimit 1: без
   * отдельной очереди на профиль дроп второго профиля дождался бы конца чужого
   * пятиминутного окна и не сделал бы ни одного опроса availability.
   */
  concurrencyKey: string;
}

export interface PlannerDeps {
  /** set — только для отметки PLANNER_LAST_RUN_KEY (см. markPlannerRun). */
  settings: { get(key: string): Promise<string | null>; set(key: string, value: string): Promise<void> };
  schedules: { listEnabled(): Promise<PlannerRule[]> };
  profiles: { getById(id: string): Promise<PlannerProfile | null> };
  skips: { isSkipped(profileId: string, date: string): Promise<boolean> };
  /** true — сообщение реально ушло; false — не ушло (не роняет ран, только лог-предупреждение). */
  sendPreDrop(profile: PlannerProfile, text: string, date: string): Promise<boolean>;
  triggerDrop(payload: BookSlotDropPayload, opts: PlannerTriggerOptions): Promise<void>;
}

export interface PlannerRunSummary {
  enabled: boolean;
  targetDate?: string;
  messagesSent: number;
  dropsTriggered: number;
  skippedProfiles: string[];
  /** Человекочитаемые проблемы по отдельным профилям — один профиль не должен ронять весь ран. */
  errors: string[];
}

// ---------------------------- чистые функции ----------------------------

/** null = каждый день (единственное отличие от src/core/profiles.ts: там undefined, тут null из jsonb). */
export function ruleAppliesOnDate(daysOfWeek: number[] | null, date: string): boolean {
  if (daysOfWeek === null) return true;
  return daysOfWeek.includes(weekdayOf(date));
}

/**
 * Момент отправки book-slot-drop: H:57:00 дня T (+04:00) — за ~1.5 мин до
 * начала окна наблюдения дропа (H:58:30, см. scheduler.dropWatchWindow),
 * с запасом на холодный старт воркера trigger.dev.
 */
export function dropTriggerDelay(dayT: string, time: string): Date {
  const hourStart = new Date(slotStartISO(dayT, time)); // H:00:00+04:00 дня T
  return new Date(hourStart.getTime() + TRIGGER_LEAD_MINUTES * 60_000);
}

/**
 * Ключ идемпотентности триггера дропа: повторный ран планировщика не плодит дубль.
 *
 * ruleId в ключе обязателен с 01.08.2026. Сценарии профиля живут в БД и могут
 * меняться в течение дня, а ключ обязан оставаться стабильным между ранами
 * планировщика (ruleId — uuid из БД), так что защита от дубля не слабеет.
 * Для схлопнутых сценариев сюда приезжает их общий идентификатор
 * (`ruleIds.join('+')`, см. mergePlannedDrops): на один (профиль, дату, час)
 * приходится ровно один ран — двум ранам на один час всё равно не дал бы
 * работать concurrencyLimit 1 у book-slot-drop.
 */
export function dropIdempotencyKey(profileId: string, date: string, time: string, ruleId: string): string {
  return `drop-${profileId}-${date}-${time}-${ruleId}`;
}

/** Заявка на дроп от ОДНОГО сценария — вход mergePlannedDrops. */
export interface DropRequest {
  profileId: string;
  time: string;
  courts: string[];
  mode: 'priority' | 'all';
  ruleId: string;
}

/** Итоговый план одного рана book-slot-drop: (профиль, час) + объединённый набор. */
export interface PlannedDrop extends Omit<DropRequest, 'ruleId'> {
  /** Сценарии, схлопнутые в этот дроп, в порядке появления. */
  ruleIds: string[];
}

/**
 * Схлопывает заявки, попавшие на один и тот же (профиль, час), в ОДИН дроп.
 *
 * Почему это обязательно: у book-slot-drop `queue.concurrencyLimit = 1`, а
 * concurrencyKey = profileId. Два рана профиля на один час выстроились бы в
 * очередь, и второй стартовал бы только после того, как первый досидит своё
 * пятиминутное окно, — то есть пришёл бы в уже закрытое окно, не сделал бы ни
 * одного getAvailability (корты второго сценария не сторожил бы НИКТО) и
 * прислал бы второй, бессмысленный ❌-отчёт за вечер. Инвариант CLAUDE.md —
 * «каждый вечер ровно одно сообщение».
 *
 * Набор кортов — объединение в порядке появления (в 'priority' это порядок
 * приоритета: корты первого сценария остаются впереди). Режим — 'all', если его
 * просил хотя бы один сценарий: лишнюю бронь владелец отменит руками, а
 * пропущенный корт не вернуть (CLAUDE.md → стратегия вечера).
 */
export function mergePlannedDrops(requests: readonly DropRequest[]): PlannedDrop[] {
  const byKey = new Map<string, PlannedDrop>();
  for (const req of requests) {
    // Разделитель — пробел: он не встречается ни в id профиля
    // (^[a-z0-9][a-z0-9_-]{1,31}$), ни в HH:MM, поэтому ключи разных пар
    // (профиль, час) склеиться не могут.
    const key = `${req.profileId} ${req.time}`;
    const merged = byKey.get(key);
    if (merged === undefined) {
      byKey.set(key, {
        profileId: req.profileId,
        time: req.time,
        courts: [...req.courts],
        mode: req.mode,
        ruleIds: [req.ruleId],
      });
      continue;
    }
    for (const court of req.courts) {
      if (!merged.courts.includes(court)) merged.courts.push(court);
    }
    if (req.mode === 'all') merged.mode = 'all';
    if (!merged.ruleIds.includes(req.ruleId)) merged.ruleIds.push(req.ruleId);
  }
  return [...byKey.values()];
}

/** Времена одного правила, разложенные относительно момента рана `now`. */
export interface TimesByDrop {
  /**
   * Окно дропа уже закрылось: ставить нечего, и это НЕ ошибка — так для рана
   * 21:30 выглядит час 20:00, который поставил ран 20:30.
   */
  past: string[];
  /** Момент отправки (H:57) попадает в горизонт этого рана — ставим сейчас. */
  due: string[];
  /** Дроп дальше горизонта — его поставит свой ран в H:30. */
  later: string[];
}

/**
 * Раскладка времён правила по часам: чей дроп ставит ЭТОТ ран (due), чей уже
 * прошёл (past) и чей ещё впереди (later).
 *
 * «Прошёл» считается по закрытию окна наблюдения (dropWatchWindow.deadline),
 * а не по моменту отправки: крон, опоздавший на несколько минут, всё ещё
 * обязан поставить свой час — триггер с прошедшим delay выполняется
 * немедленно, а окно ещё открыто. Ран, пришедший после закрытия окна, час
 * молча пропускает: ставить его значило бы прислать человеку ❌ Timeout по
 * дропу, который никто не ловил.
 */
export function splitTimesByDrop(times: string[], dayT: string, now: Date): TimesByDrop {
  const out: TimesByDrop = { past: [], due: [], later: [] };
  const nowMs = now.getTime();
  const horizonMs = nowMs + PLAN_HORIZON_MS;
  for (const time of times) {
    const sendAt = dropTriggerDelay(dayT, time).getTime();
    const closesAt = dropWatchWindow(dayT, time).deadline.getTime();
    if (closesAt <= nowMs) out.past.push(time);
    else if (sendAt <= horizonMs) out.due.push(time);
    else out.later.push(time);
  }
  return out;
}

/**
 * Отбор правил, которые планировщик реально должен обработать сегодня.
 * Чистая функция — вся асинхронность (чтение профилей/скипов) сделана ДО неё.
 */
export function selectEligibleRules(
  rules: PlannerRule[],
  profilesById: ReadonlyMap<string, PlannerProfile | null>,
  date: string,
  skippedProfileIds: ReadonlySet<string>,
): Array<{ rule: PlannerRule; profile: PlannerProfile }> {
  const out: Array<{ rule: PlannerRule; profile: PlannerProfile }> = [];
  for (const rule of rules) {
    if (!rule.enabled) continue;
    const profile = profilesById.get(rule.profileId);
    if (!profile || !profile.telegramChatId) continue;
    if (!ruleAppliesOnDate(rule.daysOfWeek, date)) continue;
    if (skippedProfileIds.has(rule.profileId)) continue;
    out.push({ rule, profile });
  }
  return out;
}

/**
 * Значение отметки «планировщик отработал»: тбилисский stamp, а у выключенного
 * планировщика — он же с префиксом 'disabled@'. Дата в отметке — дата ЗАПУСКА
 * (день T), heartbeat сверяет именно её с сегодняшним днём.
 */
export function plannerLastRunValue(now: Date, enabled: boolean): string {
  const stamp = tbilisiStamp(now);
  return enabled ? stamp : `${PLANNER_DISABLED_PREFIX}${stamp}`;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Текст pre-drop сообщения профилю. Без секретов и контактов — только план. */
export function formatPreDropMessage(input: {
  label: string;
  date: string;
  times: string[];
  courts: string[];
  /** Не задан — 'priority' (старые вызыватели и правила без режима). */
  mode?: 'priority' | 'all';
}): string {
  const { label, date, times, courts } = input;
  const mode = input.mode ?? 'priority';
  // Строку про корты пишем по режиму: в 'all' стрелка «→» врала бы про
  // приоритет, тогда как вечером бот берёт КАЖДЫЙ появившийся корт набора.
  const courtsLine =
    mode === 'all'
      ? `Корты (ловим все): ${courts.map(esc).join(', ')}`
      : `Корты (приоритет): ${courts.map(esc).join(' → ')}`;
  return [
    `📅 <b>План на ${esc(date)}</b> — ${esc(label)}`,
    `Времена: ${times.map(esc).join(', ')}`,
    courtsLine,
    ...(mode === 'all' ? ['Лишние брони на разных кортах отменишь вручную (не позже чем за час до игры).'] : []),
    'Бронируем сегодня, в момент дропа каждого слота. Если игра не нужна — жми «Пропустить».',
  ].join('\n');
}

// -------------------------- оркестрация (I/O) --------------------------

/**
 * Отметка «планировщик сегодня отработал» — best-effort: её отказ не имеет
 * права уронить ран, который уже разослал сообщения и поставил дропы. Цена
 * потерянной отметки — ложная тревога heartbeat'а, цена упавшего рана — вечер.
 */
async function markPlannerRun(deps: PlannerDeps, now: Date, enabled: boolean): Promise<void> {
  try {
    await deps.settings.set(PLANNER_LAST_RUN_KEY, plannerLastRunValue(now, enabled));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(
      `daily-planner: отметка ${PLANNER_LAST_RUN_KEY} не записана (${message}) — heartbeat решит, ` +
        'что планировщик сегодня не отработал',
    );
  }
}

/**
 * Записанный план дня — то, ЧТО планировщик реально поставил. Читает его
 * heartbeat в 22:12: без этой записи ему пришлось бы восстанавливать план из
 * живых schedule_rules/skips, а владелец правит их и вечером (снял скип с даты
 * T+7 в 21:00 — и сторож ждал бы квитанции по дропам, которых не было).
 *
 * Планировщик почасовой, поэтому план КОПИТСЯ: ран часа H дописывает свои дропы
 * к уже записанным (mergePlannerPlan), а первый ран нового дня T — с новым
 * date — начинает план заново. Записанное не прочиталось или нечитаемо (не
 * JSON, чужая форма) — свой кусок НЕ пишем: перезапись стёрла бы дропы прошлых
 * часов, а сторож, не найдя плана за эту дату, уходит на восстановление по
 * живым правилам. Нечитаемое значение чинится руками (удалить ключ).
 *
 * Потерянный кусок не должен пропасть молча: если предыдущий включённый ран
 * сегодня отметился (planner_last_run), а план старше его отметки — тот ран
 * дропы поставил, но записать не смог. Тогда план помечается `incomplete`
 * (planLagsBehindRun), флаг доезжает до конца дня, и сторож сверяет квитанции
 * ещё и по живым правилам, а не только по неполному списку.
 *
 * В план попадают ВСЕ схлопнутые дропы, включая те, чей triggerDrop сорвался:
 * несостоявшийся ран — ровно тот случай, о котором сторож обязан сказать вслух,
 * а не тот, который надо от него спрятать.
 *
 * Best-effort, как и отметка планировщика: цена потерянной записи — запасной
 * путь у сторожа, цена упавшего рана — час дропа.
 */
async function markPlannerPlan(
  deps: PlannerDeps,
  date: string,
  dayT: string,
  now: Date,
  drops: readonly PlannedDrop[],
): Promise<void> {
  let rawPlan: string | null;
  let lastRun: string | null;
  try {
    [rawPlan, lastRun] = await Promise.all([
      deps.settings.get(PLANNER_LAST_PLAN_KEY),
      deps.settings.get(PLANNER_LAST_RUN_KEY),
    ]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(
      `daily-planner: записанный план дня не прочитан (${message}) — свой час не дописываем, ` +
        'чтобы не стереть дропы прошлых часов; heartbeat сверит квитанции с тем, что записано',
    );
    return;
  }
  const existing = parsePlannerPlan(rawPlan);
  if (existing === null && rawPlan !== null && rawPlan.trim() !== '') {
    logger.error(
      `daily-planner: значение ${PLANNER_LAST_PLAN_KEY} нечитаемо — свой час не дописываем, чтобы не стереть ` +
        'дропы прошлых часов; удали ключ в settings, следующий ран запишет план заново',
    );
    return;
  }

  // Предыдущий включённый ран отметился, а его дропов в плане нет — план неполный.
  const lags = planLagsBehindRun(existing !== null && existing.date === date ? existing : null, lastRun, dayT);
  if (lags) {
    logger.warn(
      `daily-planner: план дня отстал от отметки ${PLANNER_LAST_RUN_KEY} — предыдущий ран не записал свои дропы; ` +
        'помечаем план как неполный, heartbeat сверит квитанции и по живым правилам',
    );
  }
  const next = {
    date,
    at: tbilisiStamp(now),
    slots: drops.map((d) => ({ profileId: d.profileId, time: d.time })),
    ...(lags ? { incomplete: true } : {}),
  };
  try {
    await deps.settings.set(PLANNER_LAST_PLAN_KEY, formatPlannerPlan(mergePlannerPlan(existing, next)));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(
      `daily-planner: план дня не записан (${message}) — heartbeat будет восстанавливать его по живым правилам`,
    );
  }
}

/**
 * Собирает план на targetDate(now) и запускает его: pre-drop сообщения +
 * отложенные триггеры book-slot-drop. Ошибка на одном профиле не должна
 * остановить остальных — каждый профиль обрабатывается в своём try/catch.
 */
export async function runDailyPlanner(deps: PlannerDeps, now: Date): Promise<PlannerRunSummary> {
  const summary: PlannerRunSummary = {
    enabled: false,
    messagesSent: 0,
    dropsTriggered: 0,
    skippedProfiles: [],
    errors: [],
  };

  const plannerEnabled = await deps.settings.get(PLANNER_ENABLED_KEY);
  if (plannerEnabled !== PLANNER_ENABLED_VALUE) {
    logger.info('планировщик выключен');
    // Выключенный планировщик тоже отработал: heartbeat не должен принимать
    // осознанное «сегодня не бронируем» за несработавший cron.
    await markPlannerRun(deps, now, false);
    return summary;
  }
  summary.enabled = true;

  const date = targetDate(now); // T+7 — день игры
  const dayT = dropDayOf(date); // день наблюдения дропа (= сегодня по Тбилиси)
  summary.targetDate = date;

  const rules = await deps.schedules.listEnabled();
  const profileIds = [...new Set(rules.map((r) => r.profileId))];

  const profileEntries = await Promise.all(
    profileIds.map(async (id): Promise<readonly [string, PlannerProfile | null]> => [id, await deps.profiles.getById(id)]),
  );
  const profilesById = new Map(profileEntries);

  const skipEntries = await Promise.all(
    profileIds.map(async (id): Promise<readonly [string, boolean]> => [id, await deps.skips.isSkipped(id, date)]),
  );
  const skippedProfileIds = new Set(skipEntries.filter(([, isSkipped]) => isSkipped).map(([id]) => id));
  summary.skippedProfiles = [...skippedProfileIds];

  const eligible = selectEligibleRules(rules, profilesById, date, skippedProfileIds);
  logger.info(
    `daily-planner: ран ${tbilisiStamp(now)} — дата игры ${date}, правил ${rules.length}, подходящих сценариев ${eligible.length}`,
  );

  /** Заявки на дропы: копятся по всем сценариям и схлопываются ПОСЛЕ цикла. */
  const requests: DropRequest[] = [];

  for (const { rule, profile } of eligible) {
    try {
      const { past, due, later } = splitTimesByDrop(rule.times, dayT, now);
      if (due.length === 0) {
        // Не час этого сценария: прошедшие часы уже ничего не ждут, будущие
        // поставит их собственный ран. Это штатный исход почти каждого рана.
        logger.info(`daily-planner: сценарий ${rule.id} (${rule.profileId}) — в этот час дропов нет`);
        continue;
      }

      // Pre-drop сообщение — ОДИН раз в день на сценарий, в ран перед его первым
      // дропом: past пуст, значит ни один час сценария сегодня ещё не прошёл. В
      // сообщении — все оставшиеся на сегодня времена, а не только этот час:
      // человек видит план целиком, как видел его при одном кроне в 20:30.
      if (past.length === 0) {
        const text = formatPreDropMessage({
          label: profile.label,
          date,
          times: [...due, ...later],
          courts: rule.courts,
          mode: rule.mode,
        });
        const sent = await deps.sendPreDrop(profile, text, date);
        if (sent) {
          summary.messagesSent += 1;
        } else {
          logger.warn(`daily-planner: pre-drop сообщение профилю "${rule.profileId}" не ушло`);
        }
      }

      for (const time of due) {
        requests.push({
          profileId: rule.profileId,
          time,
          courts: rule.courts,
          mode: rule.mode,
          ruleId: rule.id,
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`daily-planner: профиль "${rule.profileId}" — ${message}`);
      summary.errors.push(`${rule.profileId}: ${message}`);
    }
  }

  // Дропы ставим ПОСЛЕ разбора всех сценариев: несколько сценариев профиля на
  // один час обязаны уехать ОДНИМ раном (см. mergePlannedDrops) — иначе второй
  // ран простоит в очереди до конца окна и ничего не забронирует.
  const drops = mergePlannedDrops(requests);
  if (drops.length < requests.length) {
    logger.info(`daily-planner: сценарии на общий час схлопнуты — дропов ${drops.length} вместо ${requests.length}`);
  }

  /** Профили, у которых триггер уже сорвался: их оставшиеся дропы не пытаем. */
  const brokenProfiles = new Set<string>();
  for (const drop of drops) {
    if (brokenProfiles.has(drop.profileId)) continue;
    try {
      const delay = dropTriggerDelay(dayT, drop.time);
      const idempotencyKey = dropIdempotencyKey(drop.profileId, date, drop.time, drop.ruleIds.join('+'));
      // courts/mode передаём ЯВНО: план вечера принимается здесь, и дроп
      // обязан отработать именно те сценарии, которые сюда попали. Если их не
      // слать, book-drop.ts достаёт правило из БД сам — по времени, беря
      // первое включённое подходящее, — и на профиле с несколькими
      // сценариями это может оказаться чужой набор кортов и чужой режим.
      await deps.triggerDrop(
        {
          profileId: drop.profileId,
          date,
          time: drop.time,
          live: true,
          force: true,
          courts: drop.courts,
          mode: drop.mode,
        },
        { delay, idempotencyKey, concurrencyKey: drop.profileId },
      );
      summary.dropsTriggered += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`daily-planner: профиль "${drop.profileId}" — ${message}`);
      summary.errors.push(`${drop.profileId}: ${message}`);
      brokenProfiles.add(drop.profileId);
    }
  }

  // План пишем ПОСЛЕ постановки дропов и ДО отметки о ране: heartbeat сверяет
  // квитанции именно с этим списком, а не с расписанием на момент своей проверки.
  await markPlannerPlan(deps, date, dayT, now, drops);

  // Отметка ставится в конце УСПЕШНОГО рана: если планировщик рухнул раньше
  // (не отвечает Supabase, отвалился trigger.dev), отметки за сегодня не будет
  // — и heartbeat в 22:12 скажет об этом вслух. Ошибки по отдельным профилям
  // (summary.errors) отметке не мешают: ран как таковой отработал.
  await markPlannerRun(deps, now, true);

  return summary;
}

// ------------------------- боевая обвязка (I/O) -------------------------

const TELEGRAM_API_BASE = 'https://api.telegram.org';
const SEND_TIMEOUT_MS = 5_000;

interface InlineButton {
  text: string;
  callback_data: string;
}

/**
 * Отправка сообщения с inline-клавиатурой. Не бросает исключений и не логирует
 * botToken (он часть URL) — тот же инвариант приватности, что в core/notify.ts;
 * своя копия здесь, чтобы не трогать notify.ts (не моя зона в этой фазе).
 */
async function sendTelegramWithKeyboard(
  target: { botToken: string; chatId: string },
  text: string,
  buttons: InlineButton[],
  fetchFn: typeof fetch = globalThis.fetch,
): Promise<boolean> {
  const url = `${TELEGRAM_API_BASE}/bot${target.botToken}/sendMessage`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
  try {
    const res = await fetchFn(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: target.chatId,
        text,
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [buttons] },
      }),
      signal: controller.signal,
    });
    return res.ok;
  } catch {
    // err намеренно не читаем: сетевая/AbortError-ошибка может содержать url с токеном.
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Не задана обязательная переменная окружения ${name} (см. .env.example)`);
  }
  return value;
}

/** Подпись tasks.trigger в объёме, нужном планировщику (и подменяемая в тестах). */
export type TriggerDropFn = (
  id: string,
  payload: BookSlotDropPayload,
  options: { delay: Date; idempotencyKey: string; concurrencyKey: string },
) => Promise<unknown>;

/** Подпись idempotencyKeys.create — ровно то, чем мы пользуемся. */
export type CreateIdempotencyKeyFn = (key: string, options: { scope: 'global' }) => Promise<string>;

/**
 * Отправка book-slot-drop с ПРАВИЛЬНЫМ скоупом идемпотентности.
 *
 * Голая строка в tasks.trigger превращается в ключ со scope 'run'
 * (@trigger.dev/core: makeIdempotencyKey → createIdempotencyKey(key, {scope:
 * 'run'}) → injectScope добавляет taskContext.ctx.run.id). Мы триггерим ИЗ тела
 * таска daily-planner, поэтому один и тот же 'drop-ilya-2026-08-07-20:00' в
 * разных ранах планировщика даёт разный хэш: повторный ран (Replay/Test run
 * после крона) поставил бы ВТОРУЮ джобу на тот же слот. Ключ должен быть
 * глобальным — тогда второй триггер отсекается платформой.
 */
export function makeTriggerDrop(deps: {
  trigger: TriggerDropFn;
  createKey: CreateIdempotencyKeyFn;
}): PlannerDeps['triggerDrop'] {
  return async (payload, opts): Promise<void> => {
    const key = await deps.createKey(opts.idempotencyKey, { scope: 'global' });
    await deps.trigger('book-slot-drop', payload, {
      delay: opts.delay,
      idempotencyKey: key,
      concurrencyKey: opts.concurrencyKey,
    });
  };
}

/**
 * Реальные зависимости: Supabase-репозитории (динамический import — см.
 * комментарий в шапке файла) + Telegram по TELEGRAM_BOT_TOKEN + tasks.trigger.
 */
async function buildDeps(): Promise<PlannerDeps> {
  const { ProfilesRepo, SchedulesRepo, SkipsRepo, SettingsRepo } = await import('../core/repos.js');
  const opts = { url: requireEnv('SUPABASE_URL'), serviceKey: requireEnv('SUPABASE_SERVICE_ROLE_KEY') };
  const botToken = process.env.TELEGRAM_BOT_TOKEN?.trim() ?? '';

  return {
    settings: new SettingsRepo(opts),
    schedules: new SchedulesRepo(opts),
    profiles: new ProfilesRepo(opts),
    skips: new SkipsRepo(opts),
    sendPreDrop: async (profile, text, date) => {
      if (botToken === '' || !profile.telegramChatId) {
        logger.warn(`daily-planner: Telegram не настроен — pre-drop сообщение на ${date} не отправлено`);
        return false;
      }
      const buttons: InlineButton[] = [
        { text: '⏭ Пропустить', callback_data: `skip:${date}` },
        // 'noop' — ровно CB_NOOP из src/bot/parse.ts: бот гасит спиннер и ничего
        // не делает. Дублировать константу импортом сюда не стали — эта задача
        // не тянет grammY-зависимости ради одной строки.
        { text: '✅ Бронируем', callback_data: 'noop' },
      ];
      return sendTelegramWithKeyboard({ botToken, chatId: profile.telegramChatId }, text, buttons);
    },
    triggerDrop: makeTriggerDrop({
      trigger: (id, payload, options) => tasks.trigger(id, payload, options),
      createKey: (key, options) => idempotencyKeys.create(key, options),
    }),
  };
}

export const dailyPlannerTask = schedules.task({
  id: 'daily-planner',
  // Каждый час в :30 UTC = :30 Asia/Tbilisi (+04:00 — целые часы, без DST):
  // ран H:30 ставит дропы часа H (см. шапку файла). Id таска исторический —
  // менять его значит потерять расписание в дашборде trigger.dev.
  cron: '30 * * * *',
  // План дня дописывается через read-merge-write (markPlannerPlan): два рана
  // планировщика одновременно (крон + ручной Replay) затёрли бы друг другу
  // слоты, и сторож не ждал бы квитанций по потерянным.
  queue: { concurrencyLimit: 1 },
  run: async (payload) => {
    const deps = await buildDeps();
    return runDailyPlanner(deps, payload.timestamp);
  },
});
