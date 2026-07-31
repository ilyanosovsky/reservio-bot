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

export function ruleButtonLabel(rule: ScheduleRuleRow): string {
  return `${rule.enabled ? '✅' : '⛔'} ${rule.times.join(', ')}`;
}

export function formatRulesList(rules: ScheduleRuleRow[]): string {
  if (rules.length === 0) {
    return '⏰ <b>Расписание</b>\n\nПравил нет. Добавить может админ командой /add_rule.';
  }
  const lines = rules.map((r) => {
    const head = `${r.enabled ? '✅' : '⛔'} <b>${escapeHtml(r.times.join(', '))}</b>`;
    return `${head}\n   корты: ${escapeHtml(r.courts.join(' → '))}\n   дни: ${escapeHtml(formatDays(r.daysOfWeek))}`;
  });
  return [
    '⏰ <b>Расписание</b>',
    '',
    ...lines,
    '',
    'Тап по кнопке включает/выключает правило.',
  ].join('\n');
}

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
    return '👤 <b>Профили</b>\n\nПрофилей нет. Добавь первый командой /add_profile.';
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

export function formatRuleSaved(profileId: string, times: string[], courts: string[], days: number[] | null): string {
  return [
    `✅ Правило для <code>${escapeHtml(profileId)}</code> сохранено.`,
    `Времена: ${escapeHtml(times.join(', '))}`,
    `Корты: ${escapeHtml(courts.join(' → '))}`,
    `Дни: ${escapeHtml(formatDays(days))}`,
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
