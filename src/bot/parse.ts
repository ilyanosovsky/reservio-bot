/**
 * Разбор пользовательского ввода бота: админские команды и callback_data.
 * Только чистые функции — покрыты tests/bot-parse.test.ts, хендлеры их лишь
 * вызывают.
 *
 * Приватность: тексты ошибок НИКОГДА не цитируют email/телефон/chat_id —
 * сообщение об ошибке живёт в истории чата и утекает в скриншоты. Про такие
 * поля пишем «поле N не похоже на …», без значения. Имена кортов и времена
 * цитировать можно: это не персональные данные, а без них ошибка бесполезна.
 *
 * callback_data Telegram ограничена 64 байтами. Разделитель полей — '~'
 * (двоеточие занято внутри времени '20:00'), корт едет индексом в PADEL_COURTS.
 * Исключение — скип: его формат `skip:{date}` зафиксирован контрактом фазы 3,
 * потому что те же кнопки шлёт pre-drop сообщение планировщика.
 */

import { courtByName, COURTS } from '../reservio/types.js';

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

export const ADD_PROFILE_USAGE = [
  'Формат: /add_profile id;label;name;email;phone;chat_id',
  'Пример: /add_profile anna;Аня;Anna Ivanova;anna@example.com;+995555123456;123456789',
  'chat_id можно оставить пустым и привязать позже.',
  'chat_id — ЛИЧНЫЙ чат человека: из групп бот команды не принимает (группе только шлёт).',
].join('\n');

export const ADD_RULE_USAGE = [
  'Формат: /add_rule profile_id;времена;корты[;дни недели]',
  'Пример: /add_rule ilya;20:00,21:00;Padel Court 3,Padel Court 2;1,2,3,4,5',
  'Дни недели: 0–6, вс = 0. Не указаны — правило работает каждый день.',
].join('\n');

const PROFILE_ID_RE = /^[a-z0-9][a-z0-9_-]{1,31}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^\+\d{7,15}$/;
const CHAT_ID_RE = /^-?\d{5,20}$/;
const BOOKING_ID_RE = /^[A-Za-z0-9_-]{1,48}$/;
const RULE_ID_RE = /^[A-Za-z0-9_-]{1,48}$/;

/** Жёсткий лимит Telegram: более длинную callback_data API отвергает целиком. */
export const CALLBACK_DATA_MAX_BYTES = 64;

export interface AddProfileInput {
  id: string;
  label: string;
  name: string;
  email: string;
  phone: string;
  telegramChatId: string | null;
}

export interface AddRuleInput {
  profileId: string;
  times: string[];
  courts: string[];
  daysOfWeek: number[] | null;
}

function splitFields(raw: string): string[] {
  return raw.split(';').map((s) => s.trim());
}

function splitList(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

function fail<T>(error: string): ParseResult<T> {
  return { ok: false, error };
}

/** `/add_profile id;label;name;email;phone;chat_id` (chat_id необязателен). */
export function parseAddProfile(raw: string): ParseResult<AddProfileInput> {
  const text = raw.trim();
  if (text === '') return fail(`Нужны аргументы.\n${ADD_PROFILE_USAGE}`);

  const parts = splitFields(text);
  if (parts.length < 5 || parts.length > 6) {
    return fail(`Ожидалось 5–6 полей через «;», получено ${parts.length}.\n${ADD_PROFILE_USAGE}`);
  }

  const id = (parts[0] ?? '').toLowerCase();
  if (!PROFILE_ID_RE.test(id)) {
    return fail(`id профиля «${id}» некорректен: 2–32 символа, латиница/цифры/-/_ , начинается с буквы или цифры.`);
  }

  const label = parts[1] ?? '';
  if (label === '' || label.length > 64) return fail('Поле 2 (label) пустое или длиннее 64 символов.');

  const name = parts[2] ?? '';
  if (name === '' || name.length > 64) return fail('Поле 3 (name) пустое или длиннее 64 символов.');

  const email = parts[3] ?? '';
  // Значение не цитируем: email профиля — персональные данные, а ошибка остаётся в чате.
  if (!EMAIL_RE.test(email)) return fail('Поле 4 (email) не похоже на адрес почты. Значение не печатаю — это персональные данные.');

  const phone = (parts[4] ?? '').replace(/[\s()-]/g, '');
  if (!PHONE_RE.test(phone)) return fail('Поле 5 (phone) должно быть в формате +995XXXXXXXXX (только «+» и цифры).');

  const chatRaw = parts[5] ?? '';
  if (chatRaw !== '' && !CHAT_ID_RE.test(chatRaw)) {
    // Отрицательные id (группы) синтаксически допускаем: в них можно СЛАТЬ
    // отчёты. Но команды из групп бот не принимает (src/bot/auth.ts) — группа
    // это не человек, а все её участники сразу.
    return fail('Поле 6 (chat_id) должно быть числом Telegram (личный чат; «-» — группа, только для уведомлений) либо пустым.');
  }

  return {
    ok: true,
    value: { id, label, name, email, phone, telegramChatId: chatRaw === '' ? null : chatRaw },
  };
}

/** `/add_rule profile_id;20:00,21:00;Padel Court 3,Padel Court 2[;1,2,3]`. */
export function parseAddRule(raw: string): ParseResult<AddRuleInput> {
  const text = raw.trim();
  if (text === '') return fail(`Нужны аргументы.\n${ADD_RULE_USAGE}`);

  const parts = splitFields(text);
  if (parts.length < 3 || parts.length > 4) {
    return fail(`Ожидалось 3–4 поля через «;», получено ${parts.length}.\n${ADD_RULE_USAGE}`);
  }

  const profileId = (parts[0] ?? '').toLowerCase();
  if (!PROFILE_ID_RE.test(profileId)) {
    return fail(`id профиля «${profileId}» некорректен: 2–32 символа, латиница/цифры/-/_ .`);
  }

  const times = splitList(parts[1] ?? '');
  if (times.length === 0) return fail(`Поле 2 (времена) пустое.\n${ADD_RULE_USAGE}`);
  for (const t of times) {
    if (!TIME_RE.test(t)) return fail(`Время «${t}» не в формате HH:MM (00:00–23:59).`);
  }
  if (new Set(times).size !== times.length) return fail('В списке времён есть дубликаты.');

  const courtNames = splitList(parts[2] ?? '');
  if (courtNames.length === 0) return fail(`Поле 3 (корты) пустое.\n${ADD_RULE_USAGE}`);
  const courts: string[] = [];
  for (const name of courtNames) {
    try {
      // courtByName — единственный источник правды по кортам (src/reservio/types.ts):
      // сюда же попадает нормализация регистра, в базу ложится каноничное имя.
      courts.push(courtByName(name).name);
    } catch {
      return fail(`Корт «${name}» неизвестен. Доступны: ${COURTS.map((c) => c.name).join(', ')}.`);
    }
  }
  if (new Set(courts).size !== courts.length) return fail('В списке кортов есть дубликаты.');

  const daysRaw = parts[3];
  let daysOfWeek: number[] | null = null;
  if (daysRaw !== undefined && daysRaw !== '') {
    const items = splitList(daysRaw);
    if (items.length === 0) return fail('Поле 4 (дни недели) пустое — убери его или укажи числа 0–6.');
    const days: number[] = [];
    for (const s of items) {
      const n = Number(s);
      if (!Number.isInteger(n) || n < 0 || n > 6) {
        return fail(`День недели «${s}» вне диапазона 0–6 (вс = 0).`);
      }
      if (days.includes(n)) return fail(`День недели «${s}» указан дважды.`);
      days.push(n);
    }
    daysOfWeek = days.sort((a, b) => a - b);
  }

  return { ok: true, value: { profileId, times, courts, daysOfWeek } };
}

// ---------------------------------------------------------------------------
// callback_data
// ---------------------------------------------------------------------------

export type Callback =
  | { kind: 'slots-date'; date: string }
  | { kind: 'slots-court'; date: string; courtIndex: number }
  | { kind: 'book-date'; date: string }
  | { kind: 'book-court'; date: string; courtIndex: number }
  | { kind: 'book-time'; date: string; courtIndex: number; time: string }
  | { kind: 'book-confirm'; date: string; courtIndex: number; time: string }
  | { kind: 'cancel-pick'; bookingId: string }
  | { kind: 'cancel-confirm'; bookingId: string }
  | { kind: 'skip-toggle'; date: string }
  | { kind: 'rule-toggle'; ruleId: string }
  | { kind: 'close' }
  | { kind: 'noop' };

const SEP = '~';

/** Контракт фазы 3: pre-drop сообщение планировщика шлёт ровно `skip:{date}`. */
export const SKIP_CB_PREFIX = 'skip:';
/**
 * «Ничего не делать»: кнопка «✅ Бронируем» pre-drop сообщения планировщика.
 * Сообщение при этом НЕ перерисовывается — план вечера остаётся в истории.
 */
export const CB_NOOP = 'noop';
/** «Передумал» в наших же диалогах: сообщение схлопывается в «Отменено». */
export const CB_CLOSE = 'close';
const KEEP_CB_PREFIX = 'keep:';

export const CB_PREFIXES = {
  slots: 'sl',
  book: 'bk',
  cancel: 'cx',
  rule: 'rule',
} as const;

/**
 * Страховка от «кнопка молча не работает»: Telegram отвергает callback_data
 * длиннее 64 байт, и это видно только в проде. Пусть падает на тестах.
 */
function cb(data: string): string {
  const bytes = new TextEncoder().encode(data).length;
  if (bytes > CALLBACK_DATA_MAX_BYTES) {
    throw new RangeError(`callback_data «${data}» — ${bytes} байт при лимите ${CALLBACK_DATA_MAX_BYTES}`);
  }
  return data;
}

export const cbSlotsDate = (date: string): string => cb(`sl${SEP}d${SEP}${date}`);
export const cbSlotsCourt = (date: string, courtIndex: number): string => cb(`sl${SEP}c${SEP}${date}${SEP}${courtIndex}`);
export const cbBookDate = (date: string): string => cb(`bk${SEP}d${SEP}${date}`);
export const cbBookCourt = (date: string, courtIndex: number): string => cb(`bk${SEP}c${SEP}${date}${SEP}${courtIndex}`);
export const cbBookTime = (date: string, courtIndex: number, time: string): string =>
  cb(`bk${SEP}t${SEP}${date}${SEP}${courtIndex}${SEP}${time}`);
export const cbBookConfirm = (date: string, courtIndex: number, time: string): string =>
  cb(`bk${SEP}y${SEP}${date}${SEP}${courtIndex}${SEP}${time}`);
export const cbCancelPick = (bookingId: string): string => cb(`cx${SEP}p${SEP}${bookingId}`);
export const cbCancelConfirm = (bookingId: string): string => cb(`cx${SEP}y${SEP}${bookingId}`);
export const cbSkip = (date: string): string => cb(`${SKIP_CB_PREFIX}${date}`);
export const cbRuleToggle = (ruleId: string): string => cb(`${CB_PREFIXES.rule}${SEP}${ruleId}`);

function courtIndexOrNull(raw: string | undefined): number | null {
  if (raw === undefined || !/^\d{1,2}$/.test(raw)) return null;
  return Number(raw);
}

/**
 * Разбор callback_data. null — данные не наши/битые: хендлер на такое обязан
 * ответить answerCallbackQuery, иначе у пользователя вечно крутится спиннер.
 */
export function parseCallbackData(data: string): Callback | null {
  if (data === CB_CLOSE) return { kind: 'close' };
  if (data === CB_NOOP) return { kind: 'noop' };
  if (data.startsWith(KEEP_CB_PREFIX)) return { kind: 'noop' };

  if (data.startsWith(SKIP_CB_PREFIX)) {
    const date = data.slice(SKIP_CB_PREFIX.length);
    return DATE_RE.test(date) ? { kind: 'skip-toggle', date } : null;
  }

  const parts = data.split(SEP);
  const head = parts[0];

  if (head === CB_PREFIXES.rule) {
    const ruleId = parts[1];
    return parts.length === 2 && ruleId !== undefined && RULE_ID_RE.test(ruleId)
      ? { kind: 'rule-toggle', ruleId }
      : null;
  }

  if (head === CB_PREFIXES.cancel) {
    const bookingId = parts[2];
    if (parts.length !== 3 || bookingId === undefined || !BOOKING_ID_RE.test(bookingId)) return null;
    if (parts[1] === 'p') return { kind: 'cancel-pick', bookingId };
    if (parts[1] === 'y') return { kind: 'cancel-confirm', bookingId };
    return null;
  }

  if (head !== CB_PREFIXES.slots && head !== CB_PREFIXES.book) return null;

  const step = parts[1];
  const date = parts[2];
  if (date === undefined || !DATE_RE.test(date)) return null;

  if (step === 'd') {
    if (parts.length !== 3) return null;
    return head === CB_PREFIXES.slots ? { kind: 'slots-date', date } : { kind: 'book-date', date };
  }

  if (step === 'c') {
    if (parts.length !== 4) return null;
    const courtIndex = courtIndexOrNull(parts[3]);
    if (courtIndex === null) return null;
    return head === CB_PREFIXES.slots
      ? { kind: 'slots-court', date, courtIndex }
      : { kind: 'book-court', date, courtIndex };
  }

  if (head === CB_PREFIXES.book && (step === 't' || step === 'y')) {
    if (parts.length !== 5) return null;
    const courtIndex = courtIndexOrNull(parts[3]);
    const time = parts[4];
    if (courtIndex === null || time === undefined || !TIME_RE.test(time)) return null;
    return step === 't'
      ? { kind: 'book-time', date, courtIndex, time }
      : { kind: 'book-confirm', date, courtIndex, time };
  }

  return null;
}
