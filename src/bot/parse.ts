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
 * (двоеточие занято внутри времени '20:00'), корт едет индексом в BOOKABLE_COURTS.
 * Исключение — скип: его формат `skip:{date}` зафиксирован контрактом фазы 3,
 * потому что те же кнопки шлёт pre-drop сообщение планировщика.
 *
 * Мультивыборы мастера расписаний (дни/времена/корты) едут БИТМАСКАМИ в hex:
 * серверного состояния мастера нет, весь черновик сценария живёт в кнопке.
 * Нажатие галочки — это не «запомни выбор», а «нарисуй экран с уже
 * переключённым битом», поэтому кнопка сразу несёт СЛЕДУЮЩЕЕ состояние.
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
  'Формат: /add_rule profile_id;времена;корты[;дни недели][;режим]',
  'Пример: /add_rule ilya;20:00,21:00;Padel Court 3,Padel Court 4;1,2,3,4,5;all',
  'Дни недели: 0–6, вс = 0. Не указаны — правило работает каждый день.',
  'Режим: priority — первый доступный корт по приоритету (по умолчанию);',
  'all — бронировать КАЖДЫЙ появившийся корт набора (лишнее отменишь руками).',
  'Обычный путь — кнопка «⏰ Расписание»; команда осталась админским фолбэком.',
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

/**
 * Режим сценария (колонка schedule_rules.mode):
 *  - 'priority' — корты это приоритетный список, бронируем ПЕРВЫЙ доступный;
 *  - 'all' — корты это НАБОР, бронируем каждый появившийся (клуб держит
 *    вечерние Padel 2/3, поэтому пак 20:00+21:00 ловится вахтой по набору).
 */
export type RuleMode = 'priority' | 'all';

export const RULE_MODES: readonly RuleMode[] = ['priority', 'all'];

export interface AddRuleInput {
  profileId: string;
  times: string[];
  courts: string[];
  daysOfWeek: number[] | null;
  /** null — поле не указано: у существующего правила режим сохраняется как был. */
  mode: RuleMode | null;
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

/** `/add_rule profile_id;20:00,21:00;Padel Court 3,Padel Court 4[;1,2,3][;all]`. */
export function parseAddRule(raw: string): ParseResult<AddRuleInput> {
  const text = raw.trim();
  if (text === '') return fail(`Нужны аргументы.\n${ADD_RULE_USAGE}`);

  const parts = splitFields(text);
  if (parts.length < 3 || parts.length > 5) {
    return fail(`Ожидалось 3–5 полей через «;», получено ${parts.length}.\n${ADD_RULE_USAGE}`);
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

  // Режим необязателен. Не указан — null: перезапуск команды без этого поля не
  // должен молча разжаловать сценарий из 'all' обратно в 'priority'.
  const modeRaw = (parts[4] ?? '').toLowerCase();
  let mode: RuleMode | null = null;
  if (modeRaw !== '') {
    if (modeRaw === 'priority' || modeRaw === 'p') mode = 'priority';
    else if (modeRaw === 'all' || modeRaw === 'a') mode = 'all';
    else return fail(`Режим «${modeRaw}» неизвестен: priority (по приоритету) или all (все появившиеся).`);
  }

  return { ok: true, value: { profileId, times, courts, daysOfWeek, mode } };
}

// ---------------------------------------------------------------------------
// callback_data
// ---------------------------------------------------------------------------

export type Callback =
  // Шаг 0 мастера («Назад» с выбора корта): параметров нет, даты пересчитываются
  // от «сейчас» — иначе после полуночи вернёшься к вчерашнему списку.
  | { kind: 'slots-back-dates' }
  | { kind: 'book-back-dates' }
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
  // Конструктор сценариев расписания: список, правка, удаление и шаги мастера.
  | { kind: 'rules-list' }
  | { kind: 'rule-edit'; ruleId: string }
  | { kind: 'rule-delete-ask'; ruleId: string }
  | { kind: 'rule-delete'; ruleId: string }
  | { kind: 'rule-wizard'; step: RuleStep; draft: RuleDraft }
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
  /** Конструктор сценариев расписания (rule wizard). */
  rules: 'rw',
} as const;

// ---------------------------------------------------------------------------
// Битмаски мультивыбора (мастер расписаний)
// ---------------------------------------------------------------------------

/** Дни недели: бит N = день N (вс = 0). */
export const DAYS_MASK_MAX = 0x7f;
/** Времена: бит H = слот часа H. 24 бита — весь возможный диапазон суток. */
export const TIMES_MASK_MAX = 0xff_ffff;
/** Корты: бит N = индекс в BOOKABLE_COURTS (шесть кортов клуба). */
export const COURTS_MASK_MAX = 0x3f;

/** Маска в hex без ведущих нулей: '0' | '7f' | 'ffffff'. */
export function encodeMask(mask: number): string {
  if (!Number.isInteger(mask) || mask < 0 || mask > TIMES_MASK_MAX) {
    throw new RangeError(`битмаска «${mask}» вне диапазона 0..${TIMES_MASK_MAX}`);
  }
  return mask.toString(16);
}

/** null — не hex, пусто или бит вне разрешённого диапазона (чужая/битая кнопка). */
export function decodeMask(raw: string | undefined, max: number): number | null {
  if (raw === undefined || !/^[0-9a-f]{1,6}$/i.test(raw)) return null;
  const value = Number.parseInt(raw, 16);
  return value > max ? null : value;
}

/** Номера установленных битов по возрастанию: 0b1010 -> [1, 3]. */
export function bitsOf(mask: number): number[] {
  const out: number[] = [];
  for (let bit = 0; bit < 24; bit += 1) {
    if ((mask & (1 << bit)) !== 0) out.push(bit);
  }
  return out;
}

/** Переключение одной галочки мультивыбора. */
export function toggleBit(mask: number, bit: number): number {
  return mask ^ (1 << bit);
}

export function maskOfBits(bits: Iterable<number>): number {
  let mask = 0;
  for (const bit of bits) {
    if (Number.isInteger(bit) && bit >= 0 && bit < 24) mask |= 1 << bit;
  }
  return mask;
}

// ---------------------------------------------------------------------------
// Черновик сценария расписания
// ---------------------------------------------------------------------------

/**
 * Состояние мастера целиком: три битмаски, режим и id редактируемого сценария
 * (null — создаём новый). Никакого server-side state: это ровно то, что едет
 * в callback_data каждой кнопки мастера.
 */
export interface RuleDraft {
  days: number;
  times: number;
  courts: number;
  mode: RuleMode;
  /** null — новый сценарий; иначе правим существующий (владение проверяет хендлер). */
  ruleId: string | null;
}

export const EMPTY_RULE_DRAFT: RuleDraft = { days: 0, times: 0, courts: 0, mode: 'priority', ruleId: null };

/** Шаги мастера: дни → времена → корты → режим → подтверждение → запись. */
export type RuleStep = 'days' | 'times' | 'courts' | 'mode' | 'confirm' | 'save';

const RULE_STEP_CODE: Record<RuleStep, string> = {
  days: 'd',
  times: 't',
  courts: 'c',
  mode: 'm',
  confirm: 'y',
  save: 's',
};

const RULE_STEP_BY_CODE = new Map<string, RuleStep>(
  (Object.entries(RULE_STEP_CODE) as [RuleStep, string][]).map(([step, code]) => [code, step]),
);

const MODE_CODE: Record<RuleMode, string> = { priority: 'p', all: 'a' };

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

/**
 * «Назад» = переход на шаг с МЕНЬШИМ числом параметров, поэтому отдельные
 * кодировщики нужны только для возврата на шаг 0 (выбор даты) — все остальные
 * возвраты переиспользуют кодировщики самих шагов: с шага времени назад ведёт
 * cbBookDate(date), с подтверждения — cbBookCourt(date, courtIndex). Никакого
 * серверного состояния мастера нет: весь контекст едет в callback_data.
 */
export const cbSlotsBackDates = (): string => cb(`sl${SEP}b`);
export const cbBookBackDates = (): string => cb(`bk${SEP}b`);

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

/**
 * Кнопки конструктора сценариев.
 *
 * Худший случай — шаг мастера с id правки: 'rw~c~7f~ffffff~3f~a~' + uuid(36)
 * = 56 байт при лимите 64. Запас съел бы только id длиннее uuid — на такой
 * cb() бросит RangeError, и это правильно: молча мёртвая кнопка хуже.
 */
export const cbRulesList = (): string => cb(`${CB_PREFIXES.rules}${SEP}l`);
export const cbRuleEdit = (ruleId: string): string => cb(`${CB_PREFIXES.rules}${SEP}ed${SEP}${ruleId}`);
export const cbRuleDeleteAsk = (ruleId: string): string => cb(`${CB_PREFIXES.rules}${SEP}rm${SEP}${ruleId}`);
export const cbRuleDelete = (ruleId: string): string => cb(`${CB_PREFIXES.rules}${SEP}ok${SEP}${ruleId}`);

export function cbRuleWizard(step: RuleStep, draft: RuleDraft): string {
  const fields = [
    CB_PREFIXES.rules,
    RULE_STEP_CODE[step],
    encodeMask(draft.days),
    encodeMask(draft.times),
    encodeMask(draft.courts),
    MODE_CODE[draft.mode],
    draft.ruleId ?? '',
  ];
  return cb(fields.join(SEP));
}

/**
 * Ветка 'rw': либо действие над готовым сценарием (список/правка/удаление,
 * 2–3 поля), либо шаг мастера с черновиком (ровно 7 полей). Коды шагов и коды
 * действий не пересекаются, поэтому спутать их нельзя.
 */
function parseRulesCallback(parts: string[]): Callback | null {
  const code = parts[1];
  if (code === undefined) return null;

  if (code === 'l') return parts.length === 2 ? { kind: 'rules-list' } : null;

  if (code === 'ed' || code === 'rm' || code === 'ok') {
    const ruleId = parts[2];
    if (parts.length !== 3 || ruleId === undefined || !RULE_ID_RE.test(ruleId)) return null;
    if (code === 'ed') return { kind: 'rule-edit', ruleId };
    if (code === 'rm') return { kind: 'rule-delete-ask', ruleId };
    return { kind: 'rule-delete', ruleId };
  }

  const step = RULE_STEP_BY_CODE.get(code);
  if (step === undefined || parts.length !== 7) return null;

  const days = decodeMask(parts[2], DAYS_MASK_MAX);
  const times = decodeMask(parts[3], TIMES_MASK_MAX);
  const courts = decodeMask(parts[4], COURTS_MASK_MAX);
  if (days === null || times === null || courts === null) return null;

  const modeCode = parts[5];
  const mode: RuleMode | null = modeCode === 'p' ? 'priority' : modeCode === 'a' ? 'all' : null;
  if (mode === null) return null;

  // Пустой хвост — новый сценарий. Непустой обязан выглядеть как id: сам по
  // себе он ничего не доказывает, владение проверяет хендлер.
  const idRaw = parts[6] ?? '';
  if (idRaw !== '' && !RULE_ID_RE.test(idRaw)) return null;

  return { kind: 'rule-wizard', step, draft: { days, times, courts, mode, ruleId: idRaw === '' ? null : idRaw } };
}

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

  if (head === CB_PREFIXES.rules) return parseRulesCallback(parts);

  if (head === CB_PREFIXES.cancel) {
    const bookingId = parts[2];
    if (parts.length !== 3 || bookingId === undefined || !BOOKING_ID_RE.test(bookingId)) return null;
    if (parts[1] === 'p') return { kind: 'cancel-pick', bookingId };
    if (parts[1] === 'y') return { kind: 'cancel-confirm', bookingId };
    return null;
  }

  if (head !== CB_PREFIXES.slots && head !== CB_PREFIXES.book) return null;

  const step = parts[1];

  // Шаг 0 — единственный без даты, поэтому разбирается до проверки формата даты.
  if (step === 'b') {
    if (parts.length !== 2) return null;
    return head === CB_PREFIXES.slots ? { kind: 'slots-back-dates' } : { kind: 'book-back-dates' };
  }

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
