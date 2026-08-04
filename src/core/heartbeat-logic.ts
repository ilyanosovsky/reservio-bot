/**
 * Чистая логика сторожа наблюдаемости (таск `heartbeat`, src/trigger/heartbeat.ts).
 *
 * Зачем сторож. Инвариант CLAUDE.md: каждый вечер в Telegram уходит ровно одно
 * сообщение о дропе — успех, ошибка или «пропущено по команде». Изнутри
 * вечернего рана этот инвариант не проверяется: если ран не стартовал вовсе
 * (не тикнул крон планировщика, умер воркер, отвалился Supabase) или его отчёт
 * не доехал до Telegram, рассказать об этом уже некому. Молчаливый провал —
 * худший баг проекта, поэтому в 22:12 Тбилиси (после обоих вечерних дропов)
 * отдельный ран сверяет ПЛАН вечера с КВИТАНЦИЯМИ (таблица drop_reports) и
 * будит админов, если чего-то не хватает.
 *
 * Здесь только чистые функции: никакого I/O, никакого `new Date()` без
 * аргумента — «сейчас» всегда приходит параметром (как в core/scheduler.ts).
 * Модуль намеренно не импортирует @trigger.dev/sdk: его константы читает и
 * процесс Telegram-бота (src/bot/index.ts пишет отметку живости), а тянуть в
 * бота SDK и регистрацию тасков ради одного ключа незачем.
 *
 * Приватность: наружу отдаются только тексты проблем — ни chat_id, ни токенов,
 * ни контактов профиля в них нет (профиль называется своим label'ом, как в
 * pre-drop сообщении планировщика).
 */

import { dropDayOf, dropWatchWindow, slotStartISO } from './scheduler.js';

// ------------------------------ ключи settings ------------------------------

/** Тумблер планировщика; читают daily-planner и heartbeat. */
export const PLANNER_ENABLED_KEY = 'planner_enabled';
export const PLANNER_ENABLED_VALUE = 'true';

/** Отметка «планировщик сегодня отработал» — её ставит daily-planner в конце рана. */
export const PLANNER_LAST_RUN_KEY = 'planner_last_run';

/**
 * План вечера, записанный планировщиком: `{date, at, slots:[{profileId,time}]}`
 * (см. formatPlannerPlan). Это ФАКТ — список ранов, которые планировщик реально
 * поставил в 20:30, — и именно с ним сторож сверяет квитанции.
 *
 * Зачем отдельный ключ, если правила лежат в БД: расписание и скипы живут своей
 * жизнью ВЕСЬ вечер. Владелец снимает скип с даты T+7 в 21:00 (первая же кнопка
 * меню «⏭ Скип» — ровно эта дата) или заводит новый сценарий в мастере — и
 * сторож, восстанавливающий план из живых правил в 22:12, ждёт квитанции по
 * дропам, которых никто не ставил. Ложная тревога от сторожа хуже молчания: её
 * приучаются смахивать вместе с настоящими.
 */
export const PLANNER_LAST_PLAN_KEY = 'planner_last_plan';

/**
 * Префикс отметки выключенного планировщика: крон тикнул и ран отработал, просто
 * бронировать было запрещено флагом. Для сторожа это тоже «планировщик жив».
 */
export const PLANNER_DISABLED_PREFIX = 'disabled@';

/** Отметка живости Telegram-бота; её каждые 5 минут обновляет src/bot/alive.ts. */
export const BOT_ALIVE_KEY = 'bot_alive_at';

/**
 * Тумблер проверки живости бота (по умолчанию ВЫКЛЮЧЕНА).
 *
 * Пока процесс бота нигде не хостится (`PLAN.md` → фаза 4 «Хостинг Telegram-
 * бота», `docs/wiki/Hosting.md` — черновой план), он живёт на ноутбуке
 * владельца и запускается руками (`pnpm bot`). Включённая проверка в такой
 * конфигурации будила бы админов КАЖДУЮ ночь, в том числе после идеально
 * отработавшего вечера, — а сторож, который врёт каждую ночь, хуже
 * отсутствующего: его алерты начинают смахивать не читая вместе с настоящей
 * строкой «нет отчёта по 21:00» в том же сообщении.
 *
 * Поэтому проверка включается ЯВНО — строкой `bot_alive_required = 'true'` в
 * settings, шагом деплоя хостинга (`docs/wiki/Runbook.md` → «Heartbeat»).
 * От `planner_enabled` она по-прежнему не зависит: умерший бот — проблема и в
 * тот вечер, когда бронировать нечего.
 */
export const BOT_ALIVE_REQUIRED_KEY = 'bot_alive_required';
export const BOT_ALIVE_REQUIRED_VALUE = 'true';

/**
 * Час крона планировщика в зоне клуба (daily-planner: cron '30 16 * * *' UTC).
 * Нужен только как ЗАПАСНАЯ точка отсчёта, когда сегодняшней отметки
 * planner_last_run нет: см. plannerRunMoment.
 */
export const PLANNER_CRON_TIME = '20:30';

/**
 * Насколько старой может быть отметка живости. Бот отмечается раз в 5 минут,
 * 15 минут = три пропущенных отметки подряд: одиночный сетевой сбой или рестарт
 * хостинга тревогу не поднимают, а реально умерший процесс — поднимает.
 */
export const BOT_STALE_MS = 15 * 60_000;

/**
 * Запас после закрытия окна дропа, в течение которого квитанции ещё можно не
 * быть. Окно наблюдения закрывается в H:03:30 следующего часа (dropWatchWindow),
 * после чего ран форматирует отчёт, шлёт его в Telegram (до 3 попыток) и только
 * потом пишет квитанцию. Три минуты покрывают это с запасом и оставляют слоту
 * 21:00 (квитанция ожидается с 22:06:30) время до крона сторожа в 22:12.
 */
export const REPORT_GRACE_MS = 3 * 60_000;

// --------------------------------- типы ------------------------------------

/** Профиль в объёме, нужном сторожу: подпись в алерте + адресат алерта. */
export interface HeartbeatProfile {
  id: string;
  label: string;
  telegramChatId: string | null;
  isAdmin: boolean;
}

/** Ожидаемая квитанция: (профиль, дата игры, час), по которому вечер уже прошёл. */
export interface ExpectedReceipt {
  profileId: string;
  /** label профиля — им профиль называется в алерте (chat_id и контакты туда не попадают). */
  label: string;
  date: string;
  time: string;
}

/** Зеркало DropReportRow из src/core/repos.ts (импорт не нужен: сверяем по форме). */
export interface DropReceipt {
  profileId: string;
  date: string;
  time: string;
  ok: boolean;
  telegramOk: boolean;
  createdAt: string;
}

/** Один слот плана вечера: чей и на какой час поставлен ран дропа. */
export interface PlannedSlot {
  profileId: string;
  time: string;
}

/** План вечера, каким его записал планировщик (settings.planner_last_plan). */
export interface PlannerPlan {
  /** Дата игры (T+7), на которую ставились дропы. */
  date: string;
  /** tbilisiStamp момента, когда планировщик принимал решения. */
  at: string;
  /** Поставленные раны (профиль, час) — уже схлопнутые mergePlannedDrops. */
  slots: PlannedSlot[];
}

/** Разобранная отметка времени в зоне клуба. */
export interface ParsedStamp {
  /** YYYY-MM-DD — календарный день Тбилиси, к которому относится отметка. */
  date: string;
  at: Date;
  /** Отметка была с префиксом 'disabled@' (планировщик отработал выключенным). */
  disabled: boolean;
}

// ------------------------------ разбор отметок ------------------------------

/** Формат tbilisiStamp: `2026-08-04T20:30:00.123+04:00` (доли секунды необязательны). */
const STAMP_RE = /^(\d{4}-\d{2}-\d{2})T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?\+04:00$/;

/** Сколько символов чужого значения пускаем в текст алерта (мусор бывает длинным). */
const RAW_VALUE_LIMIT = 40;

function clampRaw(value: string): string {
  const text = value.trim();
  return text.length <= RAW_VALUE_LIMIT ? text : `${text.slice(0, RAW_VALUE_LIMIT)}…`;
}

/**
 * Разбирает отметку settings (`bot_alive_at`, `planner_last_run`).
 * null — ключа нет, значение пустое или нечитаемое: для сторожа это ровно то же,
 * что «отметки не было», и он обязан поднять тревогу, а не молча поверить.
 */
export function parseTbilisiStamp(raw: string | null | undefined): ParsedStamp | null {
  if (raw === null || raw === undefined) return null;
  const trimmed = raw.trim();
  const disabled = trimmed.startsWith(PLANNER_DISABLED_PREFIX);
  const value = disabled ? trimmed.slice(PLANNER_DISABLED_PREFIX.length) : trimmed;
  const m = STAMP_RE.exec(value);
  if (m === null) return null;
  const at = new Date(value);
  if (!Number.isFinite(at.getTime())) return null;
  return { date: m[1]!, at, disabled };
}

/** Возраст отметки в целых минутах (для текста алерта). */
function minutesAgo(at: Date, now: Date): number {
  return Math.max(0, Math.round((now.getTime() - at.getTime()) / 60_000));
}

// ------------------------------ план вечера ---------------------------------

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Значение settings.planner_last_plan: компактный JSON, без контактов и chat_id. */
export function formatPlannerPlan(plan: PlannerPlan): string {
  return JSON.stringify({
    date: plan.date,
    at: plan.at,
    slots: plan.slots.map((s) => ({ profileId: s.profileId, time: s.time })),
  });
}

/**
 * Разбор записанного плана. Строгий: любой мусор (не JSON, чужая форма, битый
 * слот) — null, и сторож честно уходит на восстановление плана по живым
 * правилам, а не сверяет квитанции с половиной списка.
 */
export function parsePlannerPlan(raw: string | null | undefined): PlannerPlan | null {
  if (raw === null || raw === undefined || raw.trim() === '') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const { date, at, slots } = parsed as { date?: unknown; at?: unknown; slots?: unknown };
  if (typeof date !== 'string' || !DATE_RE.test(date)) return null;
  if (typeof at !== 'string' || at === '') return null;
  if (!Array.isArray(slots)) return null;
  const out: PlannedSlot[] = [];
  for (const slot of slots) {
    if (typeof slot !== 'object' || slot === null) return null;
    const { profileId, time } = slot as { profileId?: unknown; time?: unknown };
    if (typeof profileId !== 'string' || profileId === '') return null;
    if (typeof time !== 'string' || time === '') return null;
    out.push({ profileId, time });
  }
  return { date, at, slots: out };
}

// ------------------------------- проверки -----------------------------------

/**
 * Отработал ли сегодня планировщик. `today` — календарная дата Тбилиси на момент
 * сторожа: отметка вчерашним днём означает, что крон сегодня не тикнул (не
 * поднялся деплой, упал ран до самого конца) — а значит вечерних дропов никто
 * не ставил и ждать по ним отчётов бессмысленно, но человек об этом знать обязан.
 *
 * Отметка с префиксом 'disabled@' — тоже «отработал»: ран был, просто
 * планировщик выключен флагом.
 */
export function plannerRunProblem(lastRun: string | null, today: string): string | null {
  const stamp = parseTbilisiStamp(lastRun);
  if (stamp === null) {
    const raw = (lastRun ?? '').trim();
    return raw === ''
      ? `планировщик сегодня не отработал (отметки ${PLANNER_LAST_RUN_KEY} нет вовсе — крон не тикнул или деплой не поднялся)`
      : `планировщик сегодня не отработал (отметка ${PLANNER_LAST_RUN_KEY} нечитаема: ${clampRaw(raw)})`;
  }
  if (stamp.date === today) return null;
  return `планировщик сегодня не отработал (последняя отметка ${stamp.date}, а сегодня ${today})`;
}

/**
 * Момент, в который планировщик сегодня принимал решения. Нужен, чтобы сторож
 * ждал квитанции РОВНО по тем часам, которые планировщик мог поставить: время,
 * чей момент отправки (H:57) прошёл ещё до крона в 20:30, планировщик
 * осознанно пропускает (splitTimesByDrop), дропа по нему не было и квитанции
 * взяться неоткуда. Без этой отсечки правило на 19:00 давало бы ложную тревогу
 * каждый вечер.
 *
 * Берём фактическую отметку planner_last_run (в ней записан реальный момент
 * рана, в том числе у ручного Replay в неурочный час); если её нет или она не
 * сегодняшняя — считаем по штатному крону, это ближе к правде, чем «ждём
 * квитанции по всем часам подряд».
 */
export function plannerRunMoment(lastRun: string | null, today: string): Date {
  const stamp = parseTbilisiStamp(lastRun);
  if (stamp !== null && stamp.date === today) return stamp.at;
  return new Date(slotStartISO(today, PLANNER_CRON_TIME));
}

/** Решение сторожа «ждать ли сегодня квитанции» и его обоснование. */
export interface EveningPlanDecision {
  /** Планировщик сегодня отработал (есть сегодняшняя отметка planner_last_run). */
  ranToday: boolean;
  /** Вечер реально планировался — значит квитанции обязаны быть. */
  expectReceipts: boolean;
  /** Почему решили так: уходит в output рана и в detail пропущенной проверки. */
  reason: string;
}

/**
 * Планировался ли СЕГОДНЯШНИЙ вечер.
 *
 * Источник правды — отметка planner_last_run за сегодня, а НЕ текущее значение
 * planner_enabled: флаг живёт в БД и меняется руками в любой момент, в том
 * числе между кроном планировщика (20:30) и кроном сторожа (22:12).
 *
 *   — отметка сегодняшняя, без префикса: вечер планировался ВКЛЮЧЁННЫМ
 *     планировщиком, раны поставлены. Если владелец выключил флаг в 21:20,
 *     поставленный ран всё равно отработает и забронирует корт (Runbook прямо
 *     об этом предупреждает) — и его отчёт обязан доехать до человека, иначе
 *     останется бронь на 80 GEL, о которой никто не знает;
 *   — отметка сегодняшняя, с префиксом 'disabled@': планировщик отработал
 *     выключенным, дропов не ставил — ждать квитанции не с чего (иначе вечер
 *     включения флага после 20:30 дал бы два бессмысленных алерта);
 *   — сегодняшней отметки нет вовсе: планировщик мог не отработать (об этом
 *     скажет отдельная находка) или упасть уже ПОСЛЕ постановки дропов, так что
 *     ориентируемся на текущий флаг — включён, значит вечер, скорее всего,
 *     планировался.
 */
export function eveningWasPlanned(
  lastRun: string | null,
  today: string,
  plannerEnabledNow: boolean,
): EveningPlanDecision {
  const stamp = parseTbilisiStamp(lastRun);
  const todayStamp = stamp !== null && stamp.date === today ? stamp : null;
  if (todayStamp !== null) {
    return todayStamp.disabled
      ? {
          ranToday: true,
          expectReceipts: false,
          reason: `${PLANNER_LAST_RUN_KEY} за сегодня с префиксом '${PLANNER_DISABLED_PREFIX}': планировщик отработал выключенным и дропов не ставил`,
        }
      : {
          ranToday: true,
          expectReceipts: true,
          reason: `${PLANNER_LAST_RUN_KEY} за сегодня без префикса: вечер планировался включённым планировщиком (текущее значение ${PLANNER_ENABLED_KEY} роли не играет — поставленный ран отрабатывает и после выключения флага)`,
        };
  }
  return plannerEnabledNow
    ? {
        ranToday: false,
        expectReceipts: true,
        reason: `сегодняшней отметки ${PLANNER_LAST_RUN_KEY} нет, но ${PLANNER_ENABLED_KEY} = '${PLANNER_ENABLED_VALUE}': считаем, что вечер планировался`,
      }
    : {
        ranToday: false,
        expectReceipts: false,
        reason: `сегодняшней отметки ${PLANNER_LAST_RUN_KEY} нет и ${PLANNER_ENABLED_KEY} ≠ '${PLANNER_ENABLED_VALUE}': вечерних дропов не было`,
      };
}

/**
 * Жив ли процесс Telegram-бота. Проверка НЕ зависит от планировщика: даже когда
 * бронировать нечего, умерший бот означает, что человек не может ни пропустить
 * день, ни отменить бронь, ни узнать о ней — и не догадывается об этом.
 */
export function botAliveProblem(aliveAt: string | null, now: Date): string | null {
  const stamp = parseTbilisiStamp(aliveAt);
  if (stamp === null) {
    const raw = (aliveAt ?? '').trim();
    return raw === ''
      ? `Telegram-бот не подаёт признаков жизни (отметки ${BOT_ALIVE_KEY} нет вовсе — процесс ни разу не стартовал или не видит Supabase)`
      : `Telegram-бот не подаёт признаков жизни (отметка ${BOT_ALIVE_KEY} нечитаема: ${clampRaw(raw)})`;
  }
  // Отметка из будущего (рассинхрон часов хоста) — не повод будить админов.
  if (now.getTime() - stamp.at.getTime() <= BOT_STALE_MS) return null;
  return `Telegram-бот не подаёт признаков жизни с ${clampRaw(aliveAt ?? '')} (${minutesAgo(stamp.at, now)} мин назад)`;
}

/**
 * Должна ли к моменту `now` существовать квитанция по слоту `time` дня T+7.
 *
 * Считается из окна наблюдения дропа (scheduler.dropWatchWindow), а не из
 * захардкоженного списка часов: сдвинется крон сторожа или окно — отсечка
 * поедет вместе с ними. Мусорное время в правиле (не HH:MM) — «не ждём»:
 * планировщик по такому правилу дроп тоже не поставил бы.
 */
export function dropIsDue(dayT: string, time: string, now: Date): boolean {
  let deadlineMs: number;
  try {
    deadlineMs = dropWatchWindow(dayT, time).deadline.getTime();
  } catch {
    return false;
  }
  return deadlineMs + REPORT_GRACE_MS <= now.getTime();
}

/**
 * Ожидаемые квитанции по ЗАПИСАННОМУ плану вечера (settings.planner_last_plan)
 * — основной путь: сверяем не с тем, что стоит в расписании сейчас, а с тем,
 * что планировщик реально поставил в 20:30.
 *
 * Часы, чей дроп к моменту `now` ещё не закрылся (правило на 22:00, а сторож
 * тикает в 22:12), отсекаются так же, как в expectedReceipts. `labelOf` даёт
 * подпись профиля для алерта; профиль, удалённый после планирования, называется
 * своим id — молчать про его слот нельзя.
 */
export function expectedFromPlan(
  slots: readonly PlannedSlot[],
  date: string,
  labelOf: (profileId: string) => string,
  now: Date,
): ExpectedReceipt[] {
  const dayT = dropDayOf(date);
  const seen = new Set<string>();
  const out: ExpectedReceipt[] = [];
  for (const slot of slots) {
    if (!dropIsDue(dayT, slot.time, now)) continue;
    const key = `${slot.profileId} ${slot.time}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ profileId: slot.profileId, label: labelOf(slot.profileId), date, time: slot.time });
  }
  return out;
}

/**
 * План вечера в терминах квитанций: какие (профиль, час) обязаны были
 * отчитаться к моменту `now`. ЗАПАСНОЙ путь — когда записанного плана за эту
 * дату нет (планировщик упал до записи, деплой старее этой ветки): план
 * восстанавливается по живым правилам, и его расхождение с фактом вечера как
 * раз и есть цена запасного пути (см. PLANNER_LAST_PLAN_KEY).
 *
 * На вход идёт результат selectEligibleRules из daily-planner.ts, у которого
 * времена уже прорежены его же splitTimesByDrop по plannerRunMoment — то есть
 * применимость дня недели, скипы и «на этот час дроп ставить было поздно»
 * считаются РОВНО ТЕМ ЖЕ кодом, что у планировщика: две независимые копии этих
 * правил рано или поздно разъедутся, и сторож начнёт будить админов из-за
 * собственной ошибки.
 *
 * Несколько сценариев профиля на один час схлопываются в ОДИН ожидаемый отчёт —
 * ровно так же, как планировщик схлопывает их в один ран (mergePlannedDrops).
 */
export function expectedReceipts(
  eligible: ReadonlyArray<{ rule: { profileId: string; times: string[] }; profile: { label: string } }>,
  date: string,
  now: Date,
): ExpectedReceipt[] {
  const dayT = dropDayOf(date);
  const seen = new Set<string>();
  const out: ExpectedReceipt[] = [];
  for (const { rule, profile } of eligible) {
    for (const time of rule.times) {
      if (!dropIsDue(dayT, time, now)) continue;
      // Разделитель — пробел: его нет ни в id профиля, ни в HH:MM (см. mergePlannedDrops).
      const key = `${rule.profileId} ${time}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ profileId: rule.profileId, label: profile.label, date, time });
    }
  }
  return out;
}

/**
 * Сверка плана с квитанциями. Две находки:
 *   — квитанции нет вовсе: ран дропа не стартовал, умер до отчёта или не дошёл
 *     до записи квитанции;
 *   — квитанция есть, но telegram_ok=false: результат вечера остался в логах
 *     рана, человек его не видел.
 *
 * Провал самой брони (ok=false) находкой НЕ считается: про него человеку уже
 * написал вечерний отчёт, а сторож следит за наблюдаемостью, а не за кортами.
 * Несколько квитанций на один слот (Replay рана) — норма: достаточно одной
 * доставленной.
 */
export function receiptProblems(
  expected: readonly ExpectedReceipt[],
  receipts: readonly DropReceipt[],
): string[] {
  const problems: string[] = [];
  for (const slot of expected) {
    const rows = receipts.filter(
      (r) => r.profileId === slot.profileId && r.date === slot.date && r.time === slot.time,
    );
    if (rows.length === 0) {
      problems.push(`нет отчёта по ${slot.time} (профиль ${slot.label}) — ран дропа не отработал или не дожил до отчёта`);
      continue;
    }
    if (!rows.some((r) => r.telegramOk)) {
      problems.push(`отчёт по ${slot.time} не доставлен в Telegram (профиль ${slot.label})`);
    }
  }
  return problems;
}

/**
 * Адресаты алерта: админы с привязанным чатом, без дублей (два админ-профиля
 * могут смотреть в один чат — сообщение всё равно должно быть одно).
 */
export function adminChatIds(profiles: readonly HeartbeatProfile[]): string[] {
  const out: string[] = [];
  for (const p of profiles) {
    if (!p.isAdmin) continue;
    const chatId = p.telegramChatId?.trim() ?? '';
    if (chatId === '' || out.includes(chatId)) continue;
    out.push(chatId);
  }
  return out;
}

/** Экранирование для parse_mode=HTML: те же три символа, что в core/notify.ts. */
function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Единственное сообщение сторожа. Каждая находка — отдельной строкой, чтобы её
 * было видно с телефона; в конце ссылка на разбор в рунбуке. Ни токенов, ни
 * chat_id, ни контактов — только время, дата игры и тексты находок.
 */
export function formatHeartbeatAlert(input: {
  /** tbilisiStamp момента проверки. */
  at: string;
  /** Дата игры (T+7), про которую шла речь вечером. */
  targetDate: string;
  problems: readonly string[];
}): string {
  return [
    '🚨 <b>Heartbeat: вечер прошёл не по плану</b>',
    `${esc(input.at)} · дата игры ${esc(input.targetDate)}`,
    ...input.problems.map((p) => `• ${esc(p)}`),
    'Разбор — docs/wiki/Runbook.md → «Heartbeat».',
  ].join('\n');
}
