/**
 * Подбор вариантов под разобранное намерение (BookingIntent) — чистые функции.
 *
 * Ни сети, ни state, ни Telegram: на вход приезжает уже вычитанная
 * availability, на выход — отсортированный список вариантов, каждый из которых
 * потом станет кнопкой «Забронировать». Решение о брони принимает человек,
 * поэтому здесь важнее предсказуемость и порядок, чем «умный» подбор.
 *
 * Инварианты:
 *  - связка (durationHours > 1) — это часы ПОДРЯД НА ОДНОМ КОРТЕ в пределах
 *    одних суток. 23:00 + 00:00 связкой не считается никогда: через полночь это
 *    уже другой день, а внутри одного дня разница между ними −23 часа;
 *  - времена сравниваются в минутах от полуночи, поэтому «подряд» — это ровно
 *    +60 минут, без модульной арифметики и без склейки через сутки;
 *  - порядок результата детерминирован (сортировка добивается именем корта),
 *    иначе один и тот же запрос давал бы разные кнопки;
 *  - окно `timeFrom..timeTo` применяется к НАЧАЛУ связки. Иначе точечный запрос
 *    «в 20:00 на два часа» (модель ставит timeFrom = timeTo = 20:00) не нашёл
 *    бы ничего вообще.
 */

import type { Slot } from '../reservio/types.js';
import type { BookingIntent } from './intent.js';

/** Вариант для кнопки: `times.length` = запрошенная длительность, часы подряд. */
export interface SlotOption {
  court: string;
  /** YYYY-MM-DD */
  date: string;
  /** HH:MM по возрастанию, шаг ровно час. */
  times: string[];
}

/** Сколько вариантов показываем; остальное вызывающий сворачивает в «и ещё N». */
export const MAX_SLOT_OPTIONS = 8;

const MIN_DURATION = 1;
const MAX_DURATION = 3;
const SLOT_STEP_MINUTES = 60;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * Ключ карты availability. Экспортируется специально: формат ключа знают двое —
 * тот, кто карту собирает, и тот, кто её читает. Разъехаться им нельзя.
 */
export function slotKey(court: string, date: string): string {
  return `${court}|${date}`;
}

/** Обратный разбор ключа. Дату ищем справа: '|' в имени корта не бывает, но так надёжнее. */
function parseKey(key: string): { court: string; date: string } | null {
  const cut = key.lastIndexOf('|');
  if (cut <= 0) return null;
  const court = key.slice(0, cut);
  const date = key.slice(cut + 1);
  return DATE_RE.test(date) && court !== '' ? { court, date } : null;
}

/** 'HH:MM' → минуты от полуночи. null — не время. */
function toMinutes(value: string | undefined): number | null {
  if (value === undefined || !TIME_RE.test(value)) return null;
  return Number(value.slice(0, 2)) * 60 + Number(value.slice(3, 5));
}

function toLabel(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** '2026-08-06T20:00:00+04:00' → 1200. Чужой формат игнорируем. */
function slotMinutes(slots: Slot[] | undefined): number[] {
  if (!Array.isArray(slots)) return [];
  const set = new Set<number>();
  for (const slot of slots) {
    const start = slot?.start;
    if (typeof start !== 'string') continue;
    const minutes = toMinutes(start.slice(11, 16));
    // API порядок не гарантирует и может повторить слот — берём множество.
    if (minutes !== null) set.add(minutes);
  }
  return [...set].sort((a, b) => a - b);
}

function durationOf(intent: BookingIntent): number {
  const raw = intent?.durationHours;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return MIN_DURATION;
  return Math.min(MAX_DURATION, Math.max(MIN_DURATION, Math.round(raw)));
}

/** null — корт не важен (любой). */
function courtFilter(intent: BookingIntent): Set<string> | null {
  const names: string[] = [];
  if (Array.isArray(intent?.courts)) names.push(...intent.courts);
  if (typeof intent?.court === 'string') names.push(intent.court);
  const set = new Set(names.filter((n) => typeof n === 'string' && n.trim() !== '').map((n) => n.trim().toLowerCase()));
  return set.size === 0 ? null : set;
}

function isRun(minutes: number[]): boolean {
  for (let i = 1; i < minutes.length; i += 1) {
    // Строго +60: 23:00 → 00:00 даёт −1380 и связкой не станет.
    if (minutes[i]! - minutes[i - 1]! !== SLOT_STEP_MINUTES) return false;
  }
  return true;
}

function collectRuns(
  out: SlotOption[],
  court: string,
  date: string,
  minutes: number[],
  length: number,
  from: number | null,
  to: number | null,
): void {
  for (let i = 0; i + length <= minutes.length; i += 1) {
    const run = minutes.slice(i, i + length);
    if (!isRun(run)) continue;
    const start = run[0]!;
    if (from !== null && start < from) continue;
    if (to !== null && start > to) continue;
    out.push({ court, date, times: run.map(toLabel) });
  }
}

/**
 * Все подходящие варианты, отсортированные: связки раньше одиночек, затем по
 * дате, затем по времени начала, затем по имени корта (последнее — только ради
 * детерминизма).
 */
function collectOptions(
  availabilityByCourtDate: Map<string, Slot[]>,
  intent: BookingIntent,
  horizon: { from: string; to: string },
): SlotOption[] {
  if (!(availabilityByCourtDate instanceof Map)) return [];

  // Даты YYYY-MM-DD сравниваются как строки, поэтому пересечение с горизонтом —
  // это max/min по строкам. Одиночные поля date/time поддержаны для намерения
  // kind:'book': та же функция должна уметь проверить и конкретный слот.
  const wantFrom = intent?.dateFrom ?? intent?.date ?? horizon.from;
  const wantTo = intent?.dateTo ?? intent?.date ?? horizon.to;
  const from = wantFrom > horizon.from ? wantFrom : horizon.from;
  const to = wantTo < horizon.to ? wantTo : horizon.to;
  if (from > to) return [];

  const duration = durationOf(intent);
  const courts = courtFilter(intent);
  const timeFrom = toMinutes(intent?.timeFrom ?? intent?.time);
  const timeTo = toMinutes(intent?.timeTo ?? intent?.time);

  const out: SlotOption[] = [];
  for (const [key, slots] of availabilityByCourtDate) {
    const parsed = parseKey(key);
    if (parsed === null) continue;
    const { court, date } = parsed;
    if (date < from || date > to) continue;
    if (courts !== null && !courts.has(court.toLowerCase())) continue;

    const minutes = slotMinutes(slots);
    collectRuns(out, court, date, minutes, duration, timeFrom, timeTo);
    // Связок нужной длины может не быть вовсе. Если человек не требовал «подряд»
    // явно, одиночные часы — честный запасной вариант: он увидит их ниже связок
    // и решит сам. При consecutive === true такой подмены не делаем.
    if (duration > MIN_DURATION && intent?.consecutive !== true) {
      collectRuns(out, court, date, minutes, MIN_DURATION, timeFrom, timeTo);
    }
  }

  out.sort(
    (a, b) =>
      b.times.length - a.times.length ||
      a.date.localeCompare(b.date) ||
      (a.times[0] ?? '').localeCompare(b.times[0] ?? '') ||
      a.court.localeCompare(b.court),
  );
  return out;
}

/**
 * Варианты под намерение, не больше MAX_SLOT_OPTIONS.
 * Ключ карты — `slotKey(court, date)`; значение — свободные слоты этого корта
 * на эту дату (ровно то, что отдаёт `client.getAvailability`).
 */
export function searchSlots(
  availabilityByCourtDate: Map<string, Slot[]>,
  intent: BookingIntent,
  horizon: { from: string; to: string },
): SlotOption[] {
  return collectOptions(availabilityByCourtDate, intent, horizon).slice(0, MAX_SLOT_OPTIONS);
}

/**
 * Сколько вариантов нашлось всего. Нужно ровно для строки «и ещё N»: без него
 * вызывающий не отличит «ровно восемь» от «восемь из сорока».
 */
export function countSlotOptions(
  availabilityByCourtDate: Map<string, Slot[]>,
  intent: BookingIntent,
  horizon: { from: string; to: string },
): number {
  return collectOptions(availabilityByCourtDate, intent, horizon).length;
}
