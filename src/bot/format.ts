/**
 * Сборка текстов Telegram-бота. Только чистые функции: ни одного обращения к
 * сети, к state и к grammY — всё, что здесь есть, покрывается тестами
 * (tests/bot-format.test.ts), а хендлеры остаются тонкими.
 *
 * Инварианты:
 *  - «сейчас» всегда приходит параметром (`now: Date`) — никакого `new Date()`;
 *  - все даты трактуются в зоне клуба (+04:00) через src/core/scheduler.ts;
 *  - весь динамический текст экранируется под parse_mode=HTML (escapeHtml);
 *  - персональные данные профиля (email/phone/chat_id) наружу уходят только
 *    маскированными — их читает админ, но целиком светить их в чате незачем.
 */

import type { CourtInfo } from '../reservio/types.js';
import { COURTS } from '../reservio/types.js';
import type { Slot } from '../reservio/types.js';
import type { StoredBooking } from '../core/state.js';
import type { ProfileRow, ScheduleRuleRow } from '../core/repos.js';
import { slotEndISO, slotStartISO, tbilisiDateOf, weekdayOf } from '../core/scheduler.js';
// Направление зависимости — format.ts → parse.ts, и только оно: parse.ts про
// format.ts не знает, поэтому цикла нет. Здесь нужен лишь числовой кодек
// битмасок мультивыбора (имена кортов и подписи живут в этом файле).
import { DAYS_MASK_MAX, bitsOf, maskOfBits, type RuleDraft, type RuleMode } from './parse.js';
// Та же история с wizard-state.ts: сюда приезжают только форма черновика и
// номер шага, обратной зависимости нет (wizard-state про тексты не знает).
import { stepNumber, type ProfileDraft, type ProfileStep } from './wizard-state.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Отмена в Reservio закрывается за час до начала слота (docs/PROTOCOL.md). */
export const CANCEL_DEADLINE_MS = 60 * 60 * 1000;

export const WEEKDAYS_SHORT = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'] as const;

/**
 * Корты, которые бот предлагает в интерфейсе: все шесть кортов клуба.
 * Порядок наследует COURTS: падел-корты первыми (индексы 0–3 как раньше —
 * старые callback_data в уже отправленных сообщениях не поедут), затем Park.
 */
export const BOOKABLE_COURTS: CourtInfo[] = [...COURTS];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Экранирование под parse_mode=HTML: Telegram знает ровно три спецсимвола. */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Корт по индексу в BOOKABLE_COURTS (индекс ездит в callback_data — он короткий). */
export function courtByIndex(index: number): CourtInfo | null {
  return BOOKABLE_COURTS[index] ?? null;
}

export function courtIndexOf(name: string): number {
  const needle = name.trim().toLowerCase();
  return BOOKABLE_COURTS.findIndex((c) => c.name.toLowerCase() === needle);
}

/** '2026-08-06' → '06.08 (чт)'. Кривую дату отдаём как есть — врать не надо. */
export function formatDateShort(date: string): string {
  if (!DATE_RE.test(date)) return date;
  let wd: number;
  try {
    wd = weekdayOf(date);
  } catch {
    return date;
  }
  return `${date.slice(8, 10)}.${date.slice(5, 7)} (${WEEKDAYS_SHORT[wd]})`;
}

/** Ближайшие даты в зоне клуба: `offsetDays` — сдвиг первой даты от «сегодня». */
export function upcomingDates(now: Date, count: number, offsetDays = 0): string[] {
  const out: string[] = [];
  for (let i = 0; i < count; i += 1) {
    out.push(tbilisiDateOf(new Date(now.getTime() + (offsetDays + i) * DAY_MS)));
  }
  return out;
}

/** '2026-08-06T20:00:00+04:00' → '20:00'. Чужой формат возвращаем без правок. */
export function slotTimeLabel(start: string): string {
  const hhmm = start.slice(11, 16);
  return TIME_RE.test(hhmm) ? hhmm : start;
}

/** Свободные времена корта: HH:MM, без дублей, по возрастанию (API порядок не гарантирует). */
export function freeTimes(slots: Slot[]): string[] {
  const set = new Set<string>();
  for (const s of slots) {
    if (typeof s?.start !== 'string') continue;
    const t = slotTimeLabel(s.start);
    if (TIME_RE.test(t)) set.add(t);
  }
  return [...set].sort();
}

/** Абсолютный конец слота в мс; null — дату/время не разобрать. */
function slotEndMs(date: string, time: string): number | null {
  try {
    const ms = new Date(slotEndISO(date, time)).getTime();
    return Number.isFinite(ms) ? ms : null;
  } catch {
    return null;
  }
}

/** Абсолютное начало слота в мс; null — дату/время не разобрать. */
export function slotStartMs(date: string, time: string): number | null {
  try {
    const ms = new Date(slotStartISO(date, time)).getTime();
    return Number.isFinite(ms) ? ms : null;
  } catch {
    return null;
  }
}

/**
 * Активные брони профиля: state !== 'canceled' и слот ещё не закончился.
 * Границей берём КОНЕЦ слота, а не начало: идущая прямо сейчас игра из списка
 * пропадать не должна. Записи с неразбираемой датой не прячем — иначе бронь,
 * которую видно только в базе, тихо исчезнет из интерфейса.
 */
export function activeBookings(all: StoredBooking[], now: Date): StoredBooking[] {
  const nowMs = now.getTime();
  return all
    .filter((b) => b.state !== 'canceled')
    .filter((b) => {
      const end = slotEndMs(b.date, b.time);
      return end === null || end > nowMs;
    })
    .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
}

export function formatBookingsList(all: StoredBooking[], now: Date): string {
  const rows = activeBookings(all, now);
  if (rows.length === 0) {
    return '📅 <b>Мои брони</b>\n\nАктивных броней нет.\nНажми «📆 Бронировать», чтобы занять слот.';
  }
  const lines = rows.map(
    (b) => `• ${escapeHtml(formatDateShort(b.date))} ${escapeHtml(b.time)} — ${escapeHtml(b.court)}`,
  );
  return ['📅 <b>Мои брони</b>', '', ...lines].join('\n');
}

/** Подпись брони для кнопки выбора: коротко, влезает в inline-кнопку. */
export function bookingButtonLabel(b: StoredBooking): string {
  return `${formatDateShort(b.date)} ${b.time} · ${b.court}`;
}

// ---------------------------------------------------------------------------
// Хлебные крошки мастеров
// ---------------------------------------------------------------------------

/** Пошаговые мастера бота: «📆 Бронировать», «🔍 Слоты» и «⏰ Расписание». */
export type WizardKind = 'book' | 'slots' | 'schedule';

/** Заголовок мастера: по нему видно, в каком из них находишься. */
export const WIZARD_TITLE: Record<WizardKind, string> = {
  book: '📆 <b>Бронь</b>',
  slots: '🔍 <b>Слоты</b>',
  schedule: '⏰ <b>Расписание</b>',
};

const CRUMB_SEP = ' · ';

/**
 * Строка шага: заголовок · выбранная дата · выбранный корт · что делать дальше.
 * Весь накопленный контекст обязан быть виден на КАЖДОМ шаге — иначе после
 * «Назад» человек не понимает, куда попал, а сервер состояние мастера не хранит.
 *
 * Экранируются ВСЕ параметры, включая `prompt`: функция экспортирована, и первый
 * же вызов с динамическим хвостом (например, причиной отказа Reservio с '<' или
 * '&') отдал бы Telegram невалидный HTML — editMessageText упал бы на разборе
 * разметки, а фолбэк ctx.reply отправил бы тот же битый текст. Сырой остаётся
 * только WIZARD_TITLE: это наша константа, а не параметр.
 */
export function wizardCrumbs(
  wizard: WizardKind,
  picked: { date?: string; court?: string },
  prompt: string,
): string {
  const parts = [WIZARD_TITLE[wizard]];
  if (picked.date !== undefined) parts.push(escapeHtml(formatDateShort(picked.date)));
  if (picked.court !== undefined) parts.push(escapeHtml(picked.court));
  parts.push(escapeHtml(prompt));
  return parts.join(CRUMB_SEP);
}

export const formatBookDatesStep = (): string => wizardCrumbs('book', {}, 'выбери дату');
export const formatBookCourtsStep = (date: string): string => wizardCrumbs('book', { date }, 'выбери корт');
export const formatBookTimesStep = (date: string, court: string): string =>
  wizardCrumbs('book', { date, court }, 'выбери время');
export const formatSlotsDatesStep = (): string => wizardCrumbs('slots', {}, 'выбери дату');
export const formatSlotsCourtsStep = (date: string): string => wizardCrumbs('slots', { date }, 'выбери корт');

/** Тупик мастера: у корта на эту дату нет свободных часов. Крошки остаются. */
export function formatBookNoTimes(date: string, court: string): string {
  return [
    wizardCrumbs('book', { date, court }, 'свободных слотов нет'),
    '',
    'Вернись назад и выбери другой корт или дату.',
  ].join('\n');
}

export function formatSlotsList(court: string, date: string, slots: Slot[]): string {
  const times = freeTimes(slots);
  const head = `🔍 <b>${escapeHtml(court)}</b>, ${escapeHtml(formatDateShort(date))}`;
  if (times.length === 0) {
    return `${head}\n\nСвободных слотов нет.`;
  }
  return `${head}\n\nСвободно (${times.length}): ${escapeHtml(times.join(', '))}`;
}

export function formatBookingSuccess(b: StoredBooking): string {
  return [
    '✅ <b>Забронировано</b>',
    `${escapeHtml(formatDateShort(b.date))} ${escapeHtml(b.time)} — ${escapeHtml(b.court)}`,
    'Подтверждение придёт на почту профиля.',
  ].join('\n');
}

export function formatBookingFailure(date: string, time: string, court: string, reason: string): string {
  return [
    '❌ <b>Не забронировано</b>',
    `${escapeHtml(formatDateShort(date))} ${escapeHtml(time)} — ${escapeHtml(court)}`,
    `Причина: ${escapeHtml(reason)}`,
  ].join('\n');
}

/** Подтверждение перед реальным POST: последний экран, где можно передумать. */
export function formatBookingConfirm(date: string, time: string, court: string): string {
  return [
    '📆 <b>Подтверди бронь</b>',
    `${escapeHtml(formatDateShort(date))} ${escapeHtml(time)} — ${escapeHtml(court)}`,
    '',
    'Бронь создаётся на контакт твоего профиля, оплата в клубе.',
  ].join('\n');
}

export function formatCancelConfirm(b: StoredBooking): string {
  return [
    '❌ <b>Отменить бронь?</b>',
    `${escapeHtml(formatDateShort(b.date))} ${escapeHtml(b.time)} — ${escapeHtml(b.court)}`,
    '',
    'Отмена необратима: слот сразу вернётся в общий доступ.',
  ].join('\n');
}

export function formatCancelSuccess(b: StoredBooking): string {
  return [
    '✅ <b>Бронь отменена</b>',
    `${escapeHtml(formatDateShort(b.date))} ${escapeHtml(b.time)} — ${escapeHtml(b.court)}`,
  ].join('\n');
}

/**
 * Дедлайн отмены (за час до начала) проверяем САМИ, до обращения к API: так
 * человек получает понятную причину, а не «HTTP 4xx» из чужого текста.
 * Неразбираемую дату дедлайном не считаем — пусть решает API.
 */
export function cancelDeadlinePassed(date: string, time: string, now: Date): boolean {
  const start = slotStartMs(date, time);
  if (start === null) return false;
  return now.getTime() > start - CANCEL_DEADLINE_MS;
}

export function formatCancelTooLate(b: StoredBooking): string {
  return [
    '🚫 <b>Отменить уже нельзя</b>',
    `${escapeHtml(formatDateShort(b.date))} ${escapeHtml(b.time)} — ${escapeHtml(b.court)}`,
    '',
    'Клуб закрывает отмену за час до начала слота. Позвони в клуб, если нужно освободить корт.',
  ].join('\n');
}

/**
 * Человеческий текст для отказа Reservio при отмене. Чужой message в чат не
 * тащим целиком: он англоязычный и часто цитирует внутренние поля.
 */
export function humanizeCancelError(err: { message?: string; status?: number; code?: string }): string {
  const code = err.code ?? '';
  const status = err.status;
  if (code === 'notCanceled') {
    return 'Клуб не отменил бронь — скорее всего, дедлайн отмены (час до начала) уже прошёл. Позвони в клуб.';
  }
  if (status === 403 || status === 404) {
    return 'Бронь недоступна по сохранённому токену — возможно, её уже отменили. Проверь письмо-подтверждение.';
  }
  if (code === 'networkError' || code === 'timeout') {
    return 'Reservio не ответил. Бронь, скорее всего, осталась активной — попробуй ещё раз через минуту.';
  }
  return 'Reservio отклонил отмену. Попробуй ещё раз или отмени по ссылке из письма-подтверждения.';
}

export function formatNoToken(b: StoredBooking): string {
  return [
    '⚠️ <b>Отменить через бота нельзя</b>',
    `${escapeHtml(formatDateShort(b.date))} ${escapeHtml(b.time)} — ${escapeHtml(b.court)}`,
    '',
    'У этой брони не сохранён guest-токен. Отмени её по ссылке из письма-подтверждения.',
  ].join('\n');
}

/** 'каждый день' либо 'пн, ср, пт'. Пустой список = правило не сработает никогда. */
export function formatDays(daysOfWeek: number[] | null): string {
  if (daysOfWeek === null) return 'каждый день';
  if (daysOfWeek.length === 0) return 'ни одного дня';
  return [...daysOfWeek]
    .filter((d) => Number.isInteger(d) && d >= 0 && d <= 6)
    .sort((a, b) => a - b)
    .map((d) => WEEKDAYS_SHORT[d])
    .join(', ');
}

// ---------------------------------------------------------------------------
// Сценарии расписания: мультивыборы, сводки, экраны мастера
// ---------------------------------------------------------------------------

/** Часы, которые предлагает мастер (клуб играет с 07:00 до 23:00 включительно). */
export const SCHEDULE_HOURS: number[] = Array.from({ length: 17 }, (_, i) => i + 7);

/** Порядок кнопок дней: по-человечески пн→вс, хотя бит вс = 0. */
export const WEEKDAY_BUTTON_ORDER: number[] = [1, 2, 3, 4, 5, 6, 0];

export const RULE_MODE_LABEL: Record<RuleMode, string> = {
  priority: 'первый доступный по приоритету',
  all: 'бронировать все появившиеся',
};

/** Короткая подпись режима для списка сценариев. */
export const RULE_MODE_SHORT: Record<RuleMode, string> = {
  priority: 'по приоритету',
  all: 'все корты',
};

export const RULE_MODE_HINT: Record<RuleMode, string> = {
  priority: 'Бронируем ПЕРВЫЙ освободившийся корт из списка и на этом останавливаемся.',
  all: 'Бронируем КАЖДЫЙ появившийся корт набора — лишнее отменишь руками. Клуб держит вечерние Padel 2 и 3, так что пак 20:00+21:00 ловится именно так.',
};

/**
 * Почему бот не «ищет свободный слот», а ждёт секунду дропа. Владелец просил
 * видеть эту логику прямо в подтверждении сценария (docs/PROTOCOL.md).
 */
export const DROP_EXPLAINER =
  'Бронь ловится в момент дропа: слот часа H открывается в H:59:00 за 7 суток.';

/** Час → подпись слота: 20 → '20:00'. */
export function hourLabel(hour: number): string {
  return `${String(hour).padStart(2, '0')}:00`;
}

/** '20:00' → 20. null — не целый час: битмаска мастера такое не кодирует. */
export function hourOfTime(time: string): number | null {
  if (!TIME_RE.test(time) || time.slice(3) !== '00') return null;
  return Number(time.slice(0, 2));
}

/** Все семь дней = «каждый день» (в базе это null, а не список из семи). */
export function daysFromMask(mask: number): number[] | null {
  return mask === DAYS_MASK_MAX ? null : bitsOf(mask).filter((d) => d <= 6);
}

export function maskOfDays(daysOfWeek: number[] | null): number {
  return daysOfWeek === null ? DAYS_MASK_MAX : maskOfBits(daysOfWeek.filter((d) => d >= 0 && d <= 6));
}

export function timesFromMask(mask: number): string[] {
  return bitsOf(mask).map(hourLabel);
}

/**
 * Времена в маску. Получасовые времена (их в клубе нет, но в базе теоретически
 * могут лежать) битмаска не кодирует — они молча выпадут при правке сценария
 * через мастер, поэтому такие правила правятся только командой /add_rule.
 */
export function maskOfTimes(times: string[]): number {
  const hours: number[] = [];
  for (const t of times) {
    const h = hourOfTime(t);
    if (h !== null) hours.push(h);
  }
  return maskOfBits(hours);
}

export function courtsFromMask(mask: number): string[] {
  return bitsOf(mask)
    .map((i) => BOOKABLE_COURTS[i]?.name)
    .filter((name): name is string => name !== undefined);
}

export function maskOfCourts(names: string[]): number {
  return maskOfBits(names.map(courtIndexOf).filter((i) => i >= 0));
}

/** 'Padel Court 3' → 'C3', 'Park Court 1' → 'P1'. Чужое имя оставляем как есть. */
export function courtShort(name: string): string {
  const m = /^(Padel|Park) Court (\d+)$/i.exec(name.trim());
  if (m === null) return name;
  return `${m[1]!.toLowerCase() === 'park' ? 'P' : 'C'}${m[2]}`;
}

/** Имя сценария, если человек его не задал: «20:00+21:00 · C3,C4,C1». */
export function autoRuleLabel(times: string[], courts: string[]): string {
  const left = times.join('+');
  const right = courts.map(courtShort).join(',');
  if (left === '') return right === '' ? 'сценарий' : right;
  return right === '' ? left : `${left} · ${right}`;
}

/** Мусор в колонке mode читаем как 'priority': это поведение старых правил. */
export function ruleModeOf(rule: Pick<ScheduleRuleRow, 'mode'>): RuleMode {
  return rule.mode === 'all' ? 'all' : 'priority';
}

/** Заголовок сценария: label человека, иначе автоимя. */
export function ruleTitle(rule: ScheduleRuleRow): string {
  const label = typeof rule.label === 'string' ? rule.label.trim() : '';
  return label === '' ? autoRuleLabel(rule.times, rule.courts) : label;
}

/** Стрелка — это приоритет; в режиме «все» корты равноправны, там запятая. */
export function formatCourts(courts: string[], mode: RuleMode): string {
  return courts.join(mode === 'priority' ? ' → ' : ', ');
}

export function ruleButtonLabel(rule: ScheduleRuleRow): string {
  return `${rule.enabled ? '✅' : '⛔'} ${ruleTitle(rule)}`;
}

export function formatRulesList(rules: ScheduleRuleRow[]): string {
  if (rules.length === 0) {
    return [
      WIZARD_TITLE.schedule,
      '',
      'Сценариев пока нет.',
      'Нажми «➕ Новый сценарий» — мастер спросит дни, времена, корты и режим.',
      '',
      DROP_EXPLAINER,
    ].join('\n');
  }
  const lines = rules.map((r) => {
    const mode = ruleModeOf(r);
    return [
      `${r.enabled ? '✅' : '⛔'} <b>${escapeHtml(ruleTitle(r))}</b>`,
      `   дни: ${escapeHtml(formatDays(r.daysOfWeek))}`,
      `   времена: ${escapeHtml(r.times.join(', '))}`,
      `   корты: ${escapeHtml(formatCourts(r.courts, mode))}`,
      `   режим: ${escapeHtml(RULE_MODE_LABEL[mode])}`,
    ].join('\n');
  });
  return [
    WIZARD_TITLE.schedule,
    '',
    ...lines,
    '',
    'Тап по названию включает/выключает сценарий, ✏️ — правка, 🗑 — удаление.',
    DROP_EXPLAINER,
  ].join('\n');
}

/** Черновик мастера из сохранённого сценария (кнопка ✏️). */
export function draftFromRule(rule: ScheduleRuleRow): RuleDraft {
  return {
    days: maskOfDays(rule.daysOfWeek),
    times: maskOfTimes(rule.times),
    courts: maskOfCourts(rule.courts),
    mode: ruleModeOf(rule),
    ruleId: rule.id,
  };
}

/** Поля сценария из черновика — ровно то, что уходит в SchedulesRepo.upsert. */
export interface RuleFromDraft {
  times: string[];
  courts: string[];
  daysOfWeek: number[] | null;
  mode: RuleMode;
  label: string;
}

/**
 * Порядок кортов = порядок приоритета, а битмаска порядок не хранит: из неё
 * корты выходят в порядке BOOKABLE_COURTS. Поэтому при правке прежний порядок
 * восстанавливается, а новые галочки дописываются в конец — иначе «поменял день
 * недели» молча превращало бы приоритет C3→C4→C1 в C1→C3→C4.
 */
export function mergeCourtOrder(selected: string[], previous: string[]): string[] {
  const chosen = new Set(selected);
  const kept = previous.filter((c) => chosen.has(c));
  const keptSet = new Set(kept);
  return [...kept, ...selected.filter((c) => !keptSet.has(c))];
}

/** Дни в сравнимый вид: null (каждый день) — это не то же самое, что список. */
function daysKey(daysOfWeek: number[] | null): string {
  return daysOfWeek === null ? '*' : [...daysOfWeek].sort((a, b) => a - b).join(',');
}

/**
 * Совпадает ли сохранённый сценарий с черновиком ПО СМЫСЛУ (имя и вкл/выкл не в
 * счёт). Нужна кнопке «💾 Сохранить»: она stateless, у нового сценария id в
 * callback_data пустой, и повторный тап (сеть подтормозила — человек жмёт ещё
 * раз) уходил бы во второй INSERT. Два одинаковых включённых сценария — это два
 * pre-drop сообщения и два рана на один час, второй из которых бесполезен.
 */
export function sameRuleFields(
  rule: Pick<ScheduleRuleRow, 'times' | 'courts' | 'daysOfWeek' | 'mode'>,
  fields: RuleFromDraft,
): boolean {
  return (
    rule.times.join(',') === fields.times.join(',') &&
    rule.courts.join(',') === fields.courts.join(',') &&
    daysKey(rule.daysOfWeek) === daysKey(fields.daysOfWeek) &&
    ruleModeOf(rule) === fields.mode
  );
}

export function ruleFromDraft(draft: RuleDraft, previousCourts: string[] = []): RuleFromDraft {
  const times = timesFromMask(draft.times);
  const courts = mergeCourtOrder(courtsFromMask(draft.courts), previousCourts);
  return {
    times,
    courts,
    daysOfWeek: daysFromMask(draft.days),
    mode: draft.mode,
    label: autoRuleLabel(times, courts),
  };
}

/**
 * Чего не хватает черновику до сохранения. null — можно сохранять. Пустой
 * набор дней/времён/кортов это не «и так сойдёт», а сценарий, который никогда
 * не сработает: молчаливое расписание — тот же молчаливый провал.
 */
export function draftProblem(draft: RuleDraft): string | null {
  if (draft.days === 0) return 'не выбран ни один день недели';
  if (draft.times === 0) return 'не выбрано ни одного времени';
  if (draft.courts === 0) return 'не выбран ни один корт';
  return null;
}

const CRUMB_NOTHING = '—';

/** Крошки мастера расписаний: накопленный выбор виден на каждом шаге. */
export function scheduleCrumbs(picked: string[], prompt: string): string {
  return [WIZARD_TITLE.schedule, ...picked.map(escapeHtml), escapeHtml(prompt)].join(CRUMB_SEP);
}

function daysCrumb(draft: RuleDraft): string {
  return draft.days === 0 ? CRUMB_NOTHING : formatDays(daysFromMask(draft.days));
}

function timesCrumb(draft: RuleDraft): string {
  return draft.times === 0 ? CRUMB_NOTHING : timesFromMask(draft.times).join(', ');
}

function courtsCrumb(draft: RuleDraft): string {
  return draft.courts === 0 ? CRUMB_NOTHING : courtsFromMask(draft.courts).map(courtShort).join(', ');
}

/** Шапка «новый сценарий» / «правка сценария» — по ней видно, что произойдёт. */
function draftKind(draft: RuleDraft): string {
  return draft.ruleId === null ? 'новый' : 'правка';
}

export function formatRuleDaysStep(draft: RuleDraft): string {
  return [
    scheduleCrumbs([draftKind(draft), 'шаг 1/5'], 'выбери дни недели'),
    '',
    `Отмечено: ${escapeHtml(daysCrumb(draft))}`,
    'Дни — это дни ИГРЫ. Дроп на них случится за 7 суток.',
  ].join('\n');
}

export function formatRuleTimesStep(draft: RuleDraft): string {
  return [
    scheduleCrumbs([draftKind(draft), daysCrumb(draft), 'шаг 2/5'], 'выбери времена'),
    '',
    `Отмечено: ${escapeHtml(timesCrumb(draft))}`,
    'Каждое время — отдельный дроп и отдельная бронь: «два часа» это 20:00 и 21:00.',
  ].join('\n');
}

export function formatRuleCourtsStep(draft: RuleDraft): string {
  return [
    scheduleCrumbs([draftKind(draft), daysCrumb(draft), timesCrumb(draft), 'шаг 3/5'], 'выбери корты'),
    '',
    `Отмечено: ${escapeHtml(courtsCrumb(draft))}`,
    'Приоритет нового сценария — по списку клуба (Padel 1→4, затем Park); при правке прежний порядок сохраняется. Точный порядок задаёт /add_rule.',
  ].join('\n');
}

export function formatRuleModeStep(draft: RuleDraft): string {
  return [
    scheduleCrumbs(
      [draftKind(draft), daysCrumb(draft), timesCrumb(draft), courtsCrumb(draft), 'шаг 4/5'],
      'выбери режим',
    ),
    '',
    `▫️ <b>${escapeHtml(RULE_MODE_LABEL.priority)}</b> — ${escapeHtml(RULE_MODE_HINT.priority)}`,
    `▫️ <b>${escapeHtml(RULE_MODE_LABEL.all)}</b> — ${escapeHtml(RULE_MODE_HINT.all)}`,
    '',
    `Сейчас: ${escapeHtml(RULE_MODE_LABEL[draft.mode])}`,
  ].join('\n');
}

/**
 * Шаг 5: полная сводка + объяснение дропа. Последний экран, где можно уйти.
 * `previousCourts` — корты правимого сценария: сводка обязана показывать тот же
 * порядок приоритета, который уйдёт в базу.
 */
export function formatRuleConfirm(draft: RuleDraft, previousCourts: string[] = []): string {
  const rule = ruleFromDraft(draft, previousCourts);
  const problem = draftProblem(draft);
  const head = scheduleCrumbs([draftKind(draft), 'шаг 5/5'], 'проверь и сохрани');
  if (problem !== null) {
    return [head, '', `⚠️ Так сохранять нельзя: ${escapeHtml(problem)}.`, 'Вернись назад и отметь недостающее.'].join(
      '\n',
    );
  }
  return [
    head,
    '',
    `<b>${escapeHtml(rule.label)}</b>`,
    `дни: ${escapeHtml(formatDays(rule.daysOfWeek))}`,
    `времена: ${escapeHtml(rule.times.join(', '))}`,
    `корты: ${escapeHtml(formatCourts(rule.courts, rule.mode))}`,
    `режим: ${escapeHtml(RULE_MODE_LABEL[rule.mode])}`,
    '',
    escapeHtml(DROP_EXPLAINER),
    escapeHtml(
      rule.mode === 'all'
        ? 'В этом режиме бот жмёт на каждый корт набора отдельно — броней может выйти несколько.'
        : 'Бот остановится на первом успешном корте набора.',
    ),
  ].join('\n');
}

export function formatRuleSavedWizard(rule: RuleFromDraft, created: boolean): string {
  return [
    `✅ Сценарий <b>${escapeHtml(rule.label)}</b> ${created ? 'создан' : 'обновлён'}.`,
    `дни: ${escapeHtml(formatDays(rule.daysOfWeek))}`,
    `времена: ${escapeHtml(rule.times.join(', '))}`,
    `корты: ${escapeHtml(formatCourts(rule.courts, rule.mode))}`,
    `режим: ${escapeHtml(RULE_MODE_LABEL[rule.mode])}`,
  ].join('\n');
}

/**
 * Правка расписания НЕ отменяет дроп, уже поставленный на сегодня: планировщик
 * ставит ран в 20:30 со всеми параметрами прямо в payload, и в H:59 тот
 * бронирует, даже если сценарий выключили или удалили в 20:45 (ран перечитывает
 * только скипы). Единственный рычаг на сегодняшний вечер — «⏭ Скип».
 */
export const RULE_TODAY_HINT =
  'Дроп, уже запланированный на сегодня, это не отменяет: чтобы не бронировать сегодня, нажми «⏭ Скип» на дату игры.';

export function formatRuleToggled(title: string, enabled: boolean): string {
  return enabled
    ? `✅ Сценарий <b>${escapeHtml(title)}</b> включён.`
    : `⛔ Сценарий <b>${escapeHtml(title)}</b> выключен.\n${escapeHtml(RULE_TODAY_HINT)}`;
}

export function formatRuleDeleteAsk(rule: ScheduleRuleRow): string {
  return [
    '🗑 <b>Удалить сценарий?</b>',
    `<b>${escapeHtml(ruleTitle(rule))}</b>`,
    `дни: ${escapeHtml(formatDays(rule.daysOfWeek))}`,
    `времена: ${escapeHtml(rule.times.join(', '))}`,
    `корты: ${escapeHtml(formatCourts(rule.courts, ruleModeOf(rule)))}`,
    '',
    'Уже созданные брони останутся — удаляется только правило на будущее.',
    escapeHtml(RULE_TODAY_HINT),
  ].join('\n');
}

export function formatRuleDeleted(title: string): string {
  return `🗑 Сценарий <b>${escapeHtml(title)}</b> удалён.\n${escapeHtml(RULE_TODAY_HINT)}`;
}

/** Сценарий пропал (удалён из другого чата или кнопка из старого сообщения). */
export const RULE_GONE_TEXT = '⚠️ Такого сценария у тебя нет — открой «⏰ Расписание» заново.';

/** Кнопка дня в меню скипов: отметка показывает текущее состояние. */
export function skipButtonLabel(date: string, skipped: boolean): string {
  return `${skipped ? '⏭' : '▶️'} ${formatDateShort(date)}`;
}

/**
 * Заголовок меню скипов. Отдельной константой, потому что по нему хендлер
 * отличает своё сообщение от pre-drop сообщения планировщика: кнопки у них
 * одинаковые (`skip:{date}` по контракту фазы 3), а перерисовывать нужно только
 * собственное меню — затереть план вечера было бы потерей информации.
 */
export const SKIP_MENU_TITLE = 'Пропуск дней игры';

export function formatSkipsList(dates: string[], skipped: ReadonlySet<string>): string {
  const active = dates.filter((d) => skipped.has(d));
  return [
    `⏭ <b>${SKIP_MENU_TITLE}</b>`,
    '',
    'Даты — это дни ИГРЫ (дроп на них случится за 7 суток).',
    active.length === 0
      ? 'Сейчас ничего не пропускаем.'
      : `Пропускаем: ${escapeHtml(active.map(formatDateShort).join(', '))}`,
    '',
    'Тап по дате переключает пропуск.',
  ].join('\n');
}

/** Персональные данные показываем админу только хвостом — целиком они ему не нужны. */
export function maskEmail(email: string): string {
  const at = email.indexOf('@');
  if (at <= 0) return '—';
  const head = email.slice(0, at);
  const visible = head.slice(0, 1);
  return `${visible}${'*'.repeat(Math.max(1, head.length - 1))}${email.slice(at)}`;
}

export function maskTail(value: string, keep = 4): string {
  const s = value.trim();
  if (s === '') return '—';
  return s.length <= keep ? '…' : `…${s.slice(-keep)}`;
}

export function formatProfilesList(profiles: ProfileRow[]): string {
  if (profiles.length === 0) {
    return '👤 <b>Профили</b>\n\nПрофилей нет. Заведи первого кнопкой «➕ Добавить профиль».';
  }
  const lines = profiles.map((p) => {
    const flags = [p.isAdmin ? 'админ' : null, p.telegramChatId ? `chat ${maskTail(p.telegramChatId)}` : 'chat не привязан']
      .filter((x): x is string => x !== null)
      .join(', ');
    return `• <code>${escapeHtml(p.id)}</code> — ${escapeHtml(p.label)} (${escapeHtml(maskEmail(p.email))})\n   ${escapeHtml(flags)}`;
  });
  return ['👤 <b>Профили</b>', '', ...lines].join('\n');
}

export function formatProfileSaved(id: string, label: string): string {
  return `✅ Профиль <code>${escapeHtml(id)}</code> (${escapeHtml(label)}) сохранён.`;
}

// ---------------------------------------------------------------------------
// Мастер «➕ Добавить профиль» (админская ветка)
// ---------------------------------------------------------------------------

/** Заголовок мастера профиля — по нему видно, в каком диалоге находишься. */
const PROFILE_WIZARD_TITLE = '👤 <b>Новый игрок</b>';

/** Вопрос каждого текстового шага. Отвечают СООБЩЕНИЕМ, не кнопкой. */
export const PROFILE_STEP_PROMPT: Record<ProfileStep, string> = {
  name: 'Имя игрока (видимое в списках)',
  email: 'Email аккаунта Reservio игрока',
  phone: 'Телефон (+995...)',
  confirm: 'проверь и создай',
};

const PROFILE_STEP_HINT: Record<ProfileStep, string> = {
  name: 'Так игрок будет подписан в списках бота и в брони клуба.',
  email: 'На этот адрес клуб пришлёт подтверждение, к нему же привяжется бронь в кабинете Reservio.',
  phone: 'Формат +995XXXXXXXXX — пробелы и скобки уберу сам.',
  confirm: '',
};

/**
 * Экран текстового шага: крошки с уже введённым + вопрос + подсказка.
 * Введённое показываем целиком: это персональные данные, но их только что
 * набрал сам админ в этом же чате — прятать от него нечего (в ЛОГИ они не
 * попадают, см. handlers/profiles.ts).
 */
export function formatProfileStep(draft: ProfileDraft, error = ''): string {
  const picked: string[] = [];
  if (draft.name !== '') picked.push(draft.name);
  if (draft.email !== '') picked.push(draft.email);
  if (draft.phone !== '') picked.push(draft.phone);
  const head = [PROFILE_WIZARD_TITLE, ...picked.map(escapeHtml), escapeHtml(`шаг ${stepNumber(draft.step)}/4`)].join(
    CRUMB_SEP,
  );
  const hint = PROFILE_STEP_HINT[draft.step];
  return [
    head,
    '',
    ...(error === '' ? [] : [`⚠️ ${escapeHtml(error)}`, '']),
    `<b>${escapeHtml(PROFILE_STEP_PROMPT[draft.step])}</b>`,
    // Подсказки нет только у сводки. Отфильтровать все пустые строки разом
    // нельзя: тогда уедут и разделители — экран слипнется в стену текста.
    ...(hint === '' ? [] : [escapeHtml(hint)]),
    '',
    escapeHtml('Ответь сообщением. Отменить — /cancel.'),
  ].join('\n');
}

/**
 * Шаг 4: сводка перед созданием. Дальше — только кнопки.
 *
 * `error` — ответ на сообщение, присланное вместо нажатия кнопки. Он рисуется
 * ЗДЕСЬ, а не через formatProfileStep: там экран заканчивается строкой «Ответь
 * сообщением», то есть ровно противоположной инструкцией, да ещё и без кнопок
 * под ней. Сводка же приезжает со своими «✅ Создать» / «❌ Отмена».
 */
export function formatProfileSummary(draft: ProfileDraft, error = ''): string {
  return [
    [PROFILE_WIZARD_TITLE, escapeHtml('шаг 4/4'), escapeHtml(PROFILE_STEP_PROMPT.confirm)].join(CRUMB_SEP),
    '',
    ...(error === '' ? [] : [`⚠️ ${escapeHtml(error)}`, '']),
    `имя: <b>${escapeHtml(draft.name)}</b>`,
    `email: ${escapeHtml(draft.email)}`,
    `телефон: ${escapeHtml(draft.phone)}`,
    '',
    escapeHtml('По кнопке «✅ Создать» заведу профиль без доступа к боту и выдам ссылку-приглашение — её отправишь игроку.'),
  ].join('\n');
}

/** Ссылка-приглашение: t.me/<бот>?start=inv_<код>. */
export function inviteLink(botUsername: string, code: string): string {
  return `https://t.me/${botUsername}?start=inv_${code}`;
}

/**
 * Итог создания (`reissued: false`) и перевыпуск ссылки для уже заведённого,
 * но ещё не привязанного профиля (`reissued: true`).
 *
 * Код приглашения — секрет: он ЗДЕСЬ и в базе, и больше нигде (в лог не
 * пишется). Потеряли сообщение до того, как игрок перешёл, — не беда: кнопка
 * «🔗 Ссылка» в «👤 Профили» выпускает новый код тому же профилю, заводить
 * человека заново не нужно.
 */
export function formatProfileInvite(label: string, link: string, reissued = false): string {
  return [
    reissued ? `🔗 Новая ссылка для <b>${escapeHtml(label)}</b>.` : `✅ Профиль <b>${escapeHtml(label)}</b> создан.`,
    '',
    'Отправь игроку ссылку-приглашение:',
    `<code>${escapeHtml(link)}</code>`,
    '',
    escapeHtml('По ней бот привяжет её чат и откроет меню. Ссылка одноразовая — после первого перехода она мертва.'),
    // Старый код не гасим: гасить нечего, пока он не предъявлен, а лишний
    // запрос к базе ради этого не нужен. Сработает та ссылка, которую откроют
    // первой, — вторая после привязки профиля мертва (src/bot/auth.ts).
    ...(reissued
      ? [escapeHtml('Прежняя ссылка, если её ещё не открывали, тоже рабочая: сработает та, что откроют первой.')]
      : []),
  ].join('\n');
}

/** Кнопка «🔗 Ссылка» у профиля, чей чат уже привязан: выпускать нечего. */
export const PROFILE_ALREADY_BOUND_TEXT =
  '✅ У этого профиля чат уже привязан — приглашение ему не нужно. Открой «👤 Профили» заново, чтобы обновить список.';

/** Кнопка «🔗 Ссылка» из старого сообщения: профиль с тех пор удалили. */
export const PROFILE_GONE_TEXT = '⚠️ Такого профиля больше нет. Открой «👤 Профили» заново.';

/** Черновик потерян: истёк TTL, бот перезапускался или уже создан профиль. */
export const PROFILE_DRAFT_GONE_TEXT =
  '⌛ Черновик профиля не найден: он живёт 15 минут и не переживает перезапуск бота.\nОткрой «👤 Профили» → «➕ Добавить профиль» и начни заново.';

export const PROFILE_DRAFT_CANCELED_TEXT = '↩️ Черновик профиля отменён — ничего не создано.';

/**
 * Кнопка меню при активном черновике: она работает как обычно, но черновик
 * сбрасывает. Молчаливый сброс был бы хуже — человек дописывал бы мастер,
 * которого уже нет.
 */
export const PROFILE_DRAFT_DROPPED_TEXT =
  '↩️ Черновик профиля отменён (нажата кнопка меню). Чтобы завести игрока, начни заново: «👤 Профили» → «➕ Добавить профиль».';

export const PROFILE_DRAFT_NOTHING_TEXT = 'Отменять нечего: активного черновика профиля нет.';

export function formatRuleSaved(
  profileId: string,
  times: string[],
  courts: string[],
  days: number[] | null,
  mode: RuleMode = 'priority',
): string {
  return [
    `✅ Правило для <code>${escapeHtml(profileId)}</code> сохранено.`,
    `Времена: ${escapeHtml(times.join(', '))}`,
    `Корты: ${escapeHtml(formatCourts(courts, mode))}`,
    `Дни: ${escapeHtml(formatDays(days))}`,
    `Режим: ${escapeHtml(RULE_MODE_LABEL[mode])}`,
  ].join('\n');
}

/**
 * Первое, что игрок видит после перехода по ссылке-приглашению. Это же и
 * единственный ответ, который получает чат, до этого момента боту незнакомый
 * (src/bot/auth.ts): значит, из него должно быть понятно, куда он попал и что
 * делать дальше — второго сообщения «а, и ещё» не будет.
 */
export function formatInviteWelcome(label: string): string {
  return [
    formatWelcome(label, false),
    '',
    escapeHtml('Бот бронирует корты Padel Port Batumi. Твой чат привязан к профилю — админ больше не нужен.'),
    escapeHtml('«⏰ Расписание» — дни, времена и корты для автоброни; «⏭ Скип» — пропустить конкретный день игры.'),
    escapeHtml(DROP_EXPLAINER),
  ].join('\n');
}

export function formatWelcome(label: string, isAdmin: boolean): string {
  return [
    `Привет, ${escapeHtml(label)}! 🎾`,
    '',
    'Кнопки внизу:',
    '📅 Мои брони · 🔍 Слоты',
    '📆 Бронировать · ❌ Отменить бронь',
    '⏭ Скип · ⏰ Расписание',
    isAdmin ? '👤 Профили (только для админа)' : '',
  ]
    .filter((l) => l !== '')
    .join('\n');
}

// ---------------------------------------------------------------------------
// Свободные запросы (фаза 5)
// ---------------------------------------------------------------------------

/**
 * Все тексты ветки свободных запросов — здесь, и ни один из них не приходит от
 * модели. LLM в этой ветке работает ТОЛЬКО парсером текста в структуру
 * (CLAUDE.md, путь A): в чат уходят наши строки, собранные из проверенных
 * кодом даты, времени и имени корта.
 */
export const FREE_QUERY_EXAMPLES: readonly string[] = [
  'найди 2 часа подряд в субботу вечером',
  'что свободно завтра после 19:00',
  'забронируй пятницу 20:00 на Padel Court 3',
];

function examplesBlock(): string[] {
  return FREE_QUERY_EXAMPLES.map((e) => `• «${escapeHtml(e)}»`);
}

/** Запрос не разобрался (или разобрался в «непонятно»): показываем, как надо. */
export function formatFreeQueryHelp(): string {
  return [
    '🤔 <b>Не понял запрос</b>',
    '',
    'Напиши примерно так:',
    ...examplesBlock(),
    '',
    escapeHtml('Или жми кнопки: «🔍 Слоты» — посмотреть свободное, «📆 Бронировать» — занять слот.'),
  ].join('\n');
}

/**
 * Ключа модели нет. Показывается ОДИН раз в сутки на профиль (дальше тишина):
 * молчать совсем нельзя — человек будет думать, что бот его не слышит, а
 * повторять на каждое сообщение значит превратить бота в эхо.
 */
export function formatFreeQueryOff(): string {
  return [
    '🧠 <b>Свободные запросы пока не настроены</b>',
    '',
    escapeHtml('Разбор текста выключен (нет ключа модели). Всё то же самое доступно кнопками:'),
    escapeHtml('«🔍 Слоты» — что свободно, «📆 Бронировать» — занять слот, «⏰ Расписание» — автобронь.'),
  ].join('\n');
}

/** Суточный лимит исчерпан. Отказ вежливый и БЕЗ обращения к модели. */
export function formatFreeQueryQuota(limit: number): string {
  return [
    '🧠 <b>На сегодня хватит</b>',
    '',
    escapeHtml(`Свободных запросов — ${limit} в сутки на профиль, они кончились.`),
    escapeHtml('Кнопки меню работают без лимита: «🔍 Слоты» и «📆 Бронировать».'),
    escapeHtml('Счётчик обнулится в полночь по Батуми.'),
  ].join('\n');
}

/** Текст длиннее лимита в модель не отправляем вовсе. */
export function formatFreeQueryTooLong(max: number): string {
  return [
    '✂️ <b>Слишком длинный запрос</b>',
    '',
    escapeHtml(`Уложись в ${max} символов — например, «суббота вечер, 2 часа подряд».`),
  ].join('\n');
}

/**
 * Текст похож на почту или телефон — в модель он не поедет (см.
 * `looksLikeContact` в handlers/free-query.ts). Чаще всего это дописанный шаг
 * мастера «➕ Добавить профиль», который успел истечь, поэтому подсказываем и
 * про мастер: иначе человек не поймёт, куда делся его ввод.
 */
export function formatFreeQueryContact(): string {
  return [
    '📇 <b>Это похоже на контакт, а не на запрос</b>',
    '',
    escapeHtml('Почту и телефон я в разбор текста не отправляю — это персональные данные.'),
    escapeHtml('Заполнял карточку игрока? Мастер уже закрылся — открой «👤 Профили» и начни заново.'),
    escapeHtml('А про корты пиши словами — например, «найди 2 часа подряд в субботу вечером».'),
  ].join('\n');
}

/**
 * Запрос требует слишком много обращений к Reservio (дни × корты). Просим
 * сузить, а не поллим клуб десятками запросов ради одной фразы.
 */
export function formatFreeQueryTooWide(days: number, courts: number, limit: number): string {
  return [
    '🔎 <b>Слишком широкий запрос</b>',
    '',
    escapeHtml(`Получается ${days} дн. × ${courts} корт. = ${days * courts} проверок при лимите ${limit}.`),
    escapeHtml('Назови конкретный день («в субботу») или корт («на Padel Court 3») — и я посмотрю.'),
  ].join('\n');
}

/** Даты запроса вне горизонта клуба. */
export function formatFreeQueryOutOfHorizon(from: string, to: string): string {
  return [
    '📅 <b>Это вне горизонта клуба</b>',
    '',
    escapeHtml(`Reservio открывает слоты на 7 суток вперёд: сейчас это ${formatDateShort(from)} — ${formatDateShort(to)}.`),
    escapeHtml('На более поздний день поставь автобронь: «⏰ Расписание».'),
  ].join('\n');
}

export function formatFreeQueryEmpty(): string {
  return [
    '🔎 <b>Ничего не нашёл</b>',
    '',
    escapeHtml('Под этот запрос свободных слотов нет. Попробуй другой день, время или корт.'),
    escapeHtml('На вечерние часы слоты почти всегда разбирают в момент дропа — их ловит «⏰ Расписание».'),
  ].join('\n');
}

/** Reservio не ответил. Честно и без цитирования чужой ошибки. */
export const FREE_QUERY_API_DOWN = [
  '⚠️ <b>Reservio не ответил</b>',
  '',
  'Свободные слоты сейчас не проверить — попробуй через минуту.',
].join('\n');

/**
 * Легло хранилище счётчика (Supabase), а не Reservio. Отдельный текст, потому
 * что валить чужую поломку на клуб — это соврать: человек пойдёт проверять
 * Reservio, а чинить надо совсем другое. Кнопки при этом живы, и это главное,
 * что ему нужно знать прямо сейчас.
 */
export const FREE_QUERY_STORE_DOWN = [
  '⚠️ <b>Не получилось проверить лимит</b>',
  '',
  escapeHtml('Счётчик свободных запросов сейчас недоступен, поэтому разбор текста я не запускаю.'),
  escapeHtml('Кнопки меню работают как обычно: «🔍 Слоты» и «📆 Бронировать».'),
].join('\n');

/** Точечный запрос «забронируй X», но слот уже занят. */
export function formatFreeQuerySlotTaken(date: string, time: string, court: string): string {
  return [
    '🚫 <b>Этот слот занят</b>',
    `${escapeHtml(formatDateShort(date))} ${escapeHtml(time)} — ${escapeHtml(court)}`,
    '',
    escapeHtml('Напиши, что искать вместо него, или посмотри свободное кнопкой «🔍 Слоты».'),
  ].join('\n');
}

/** Один найденный вариант: связка часов на ОДНОМ корте одного дня. */
export interface FreeQueryOptionLike {
  court: string;
  date: string;
  times: string[];
}

/** Подпись кнопки варианта: «06.08 20:00 · C3» — влезает в inline-кнопку. */
export function freeQueryButtonLabel(date: string, time: string, court: string): string {
  return `${formatDateShort(date)} ${time} · ${courtShort(court)}`;
}

/** «1 вариант», «2 варианта», «5 вариантов» — русские числительные. */
export function pluralOptions(n: number): string {
  const rest = Math.abs(n) % 100;
  const last = rest % 10;
  if (rest > 10 && rest < 20) return 'вариантов';
  if (last === 1) return 'вариант';
  if (last >= 2 && last <= 4) return 'варианта';
  return 'вариантов';
}

/**
 * Список вариантов. `hidden` — сколько НЕ поместилось (0 — поместилось всё):
 * «ровно восемь» и «восемь из сорока» иначе выглядят одинаково, и человек не
 * поймёт, что запрос стоит сузить.
 *
 * Про «час = отдельная бронь» пишем только когда в вариантах есть связки: это
 * не общая присказка, а объяснение, почему у одного варианта две кнопки.
 */
export function formatFreeQueryOptions(options: readonly FreeQueryOptionLike[], hidden = 0): string {
  const lines = options.map((o, i) => {
    const times = o.times.join(' + ');
    return `${i + 1}. ${escapeHtml(formatDateShort(o.date))} · ${escapeHtml(o.court)} · ${escapeHtml(times)}`;
  });
  const multi = options.some((o) => o.times.length > 1);
  return [
    `🔎 <b>Нашёл: ${options.length}</b>`,
    '',
    ...lines,
    '',
    ...(hidden > 0
      ? [escapeHtml(`И ещё ${hidden} ${pluralOptions(hidden)} — сузь запрос (день, корт или время), чтобы увидеть их.`)]
      : []),
    escapeHtml('Кнопка ведёт на экран подтверждения — бронь создаётся только после него.'),
    ...(multi ? [escapeHtml('Каждый час — отдельная бронь: для двух часов подряд подтверди оба.')] : []),
  ].join('\n');
}
