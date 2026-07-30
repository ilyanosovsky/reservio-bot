/**
 * Датовая арифметика клуба (Padel Port Batumi).
 *
 * Таймзона клуба Asia/Tbilisi = фиксированный +04:00 круглый год, без DST.
 * Поэтому весь расчёт делается через `Date.UTC` + явный сдвиг на оффсет:
 * ни одна функция этого модуля не зависит от локальной таймзоны процесса.
 * `new Date()` без аргументов здесь не используется — «сейчас» всегда приходит
 * параметром, чтобы всё было чистым и тестируемым.
 */

export const TZ_OFFSET = '+04:00';

const TZ_OFFSET_MS = 4 * 60 * 60 * 1000;

/** Длительность слота Reservio: 20:00 → 20:59. */
const SLOT_MINUTES = 59;

/** Горизонт бронирования клуба: слоты открываются за 7 суток. */
const TARGET_LEAD_DAYS = 7;

/**
 * Дроп слота часа H наблюдается с H:58:30 дня T — того же часа, НЕ (H-1).
 *
 * Механика (выведена из живого замера 30.07.2026, docs/PROTOCOL.md): горизонт
 * ровно 7×24 ч, слот открывается, когда его КОНЕЦ входит в горизонт, т.е. в
 * `end − 7 суток` = `H:59:00` дня T. Замер: слот 06.08 10:00 ОТСУТСТВОВАЛ
 * 30.07 в 10:58:49.4 и появился в 10:58:59.9 — модель «(H-1):58:50» этим
 * замером опровергнута (в ней слот был бы виден уже в 09:58:50).
 * Начинаем слушать за 30 секунд до расчётного момента.
 */
const DROP_WATCH_START_MINUTE = 58;
const DROP_WATCH_START_SECOND = 30;

/** Окно наблюдения дропа — 5 минут (верхняя граница из CLAUDE.md). */
const DROP_WATCH_MINUTES = 5;

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

interface Ymd {
  y: number;
  m: number;
  d: number;
}

interface Hm {
  h: number;
  min: number;
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0');
}

/** YYYY-MM-DD из абсолютного ms, прочитанного как UTC-поля. */
function formatUtcDate(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/**
 * `wallMs` — стенные часы Тбилиси, закодированные как UTC (Date.UTC(...)).
 * Возвращает ISO-строку с явным +04:00.
 */
function formatWallISO(wallMs: number): string {
  const d = new Date(wallMs);
  return (
    `${formatUtcDate(wallMs)}T` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}` +
    TZ_OFFSET
  );
}

function parseDate(date: string): Ymd {
  const m = DATE_RE.exec(date);
  if (!m) {
    throw new RangeError(`Дата должна быть в формате YYYY-MM-DD, получено: ${JSON.stringify(date)}`);
  }
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  // Roundtrip отсеивает несуществующие даты (2026-02-30, 2026-13-01).
  if (formatUtcDate(Date.UTC(y, mo - 1, d)) !== date) {
    throw new RangeError(`Несуществующая дата: ${date}`);
  }
  return { y, m: mo, d };
}

function parseTime(time: string): Hm {
  const m = TIME_RE.exec(time);
  if (!m) {
    throw new RangeError(`Время должно быть в формате HH:MM (00:00–23:59), получено: ${JSON.stringify(time)}`);
  }
  return { h: Number(m[1]), min: Number(m[2]) };
}

/** Текущая календарная дата в таймзоне клуба (+04:00). */
export function tbilisiDateOf(now: Date): string {
  const ms = now.getTime();
  if (!Number.isFinite(ms)) {
    throw new RangeError('tbilisiDateOf: передан невалидный Date');
  }
  return formatUtcDate(ms + TZ_OFFSET_MS);
}

/** День дропа T+7: слоты, которые откроются сегодня вечером. */
export function targetDate(now: Date): string {
  const { y, m, d } = parseDate(tbilisiDateOf(now));
  return formatUtcDate(Date.UTC(y, m - 1, d + TARGET_LEAD_DAYS));
}

/**
 * Обратная функция к `targetDate`: день наблюдения T для целевой даты игры T+7.
 * Именно от неё, а не от «сегодня», считается окно дропа: иначе запуск в
 * неурочный час поллит окно чужих суток.
 */
export function dropDayOf(date: string): string {
  const { y, m, d } = parseDate(date);
  return formatUtcDate(Date.UTC(y, m - 1, d - TARGET_LEAD_DAYS));
}

/** День недели даты клуба: 0 = вс … 6 = сб. Не зависит от локальной TZ хоста. */
export function weekdayOf(date: string): number {
  const { y, m, d } = parseDate(date);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** Момент времени как ISO в зоне клуба: `2026-07-30T20:58:30.412+04:00`. */
export function tbilisiStamp(now: Date): string {
  const ms = now.getTime();
  if (!Number.isFinite(ms)) {
    throw new RangeError('tbilisiStamp: передан невалидный Date');
  }
  return new Date(ms + TZ_OFFSET_MS).toISOString().replace('Z', TZ_OFFSET);
}

/** '2026-08-06' + '20:00' → '2026-08-06T20:00:00+04:00'. */
export function slotStartISO(date: string, time: string): string {
  const { y, m, d } = parseDate(date);
  const { h, min } = parseTime(time);
  return formatWallISO(Date.UTC(y, m - 1, d, h, min));
}

/** Конец слота = старт + 59 минут: '20:00' → '20:59', '23:00' → '23:59'. */
export function slotEndISO(date: string, time: string): string {
  const { y, m, d } = parseDate(date);
  const { h, min } = parseTime(time);
  return formatWallISO(Date.UTC(y, m - 1, d, h, min + SLOT_MINUTES));
}

/**
 * Окно наблюдения дропа слота `time` дня T+7.
 * `dayT` — день T (день наблюдения, не день игры); берётся из `dropDayOf(date)`.
 * Слот часа H появляется ~H:58:50–59:00 дня T (см. комментарий к
 * DROP_WATCH_START_MINUTE), поэтому слушаем H:58:30 + 5 минут.
 */
export function dropWatchWindow(dayT: string, time: string): { start: Date; deadline: Date } {
  const { y, m, d } = parseDate(dayT);
  const { h } = parseTime(time);
  const wallMs = Date.UTC(y, m - 1, d, h, DROP_WATCH_START_MINUTE, DROP_WATCH_START_SECOND);
  const start = new Date(wallMs - TZ_OFFSET_MS);
  const deadline = new Date(start.getTime() + DROP_WATCH_MINUTES * 60 * 1000);
  return { start, deadline };
}
