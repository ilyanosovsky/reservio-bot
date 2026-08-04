// Свободные запросы (фаза 5): человек пишет боту обычным текстом, модель
// превращает текст в СТРУКТУРУ, а всё остальное делает детерминированный код.
//
// Границы, за которые эта ветка не выходит (CLAUDE.md, путь A):
//  - модель НЕ разговаривает с человеком: ни одна её строка в чат не уходит,
//    наружу едут только наши тексты из format.ts;
//  - модель НЕ бронирует: любой путь заканчивается ТЕМ ЖЕ экраном подтверждения,
//    что и мастер «📆 Бронировать» (callback `bk~`), а POST делает bookNow —
//    после того, как человек нажал «✅ Бронировать»;
//  - структуре от модели не верим ни в одном поле: даты, времена и корты
//    перепроверяются здесь ещё раз (парсер их уже чистил, но он про сегодняшний
//    горизонт и про наш список кортов знает только из промпта).
//
// Место в цепочке: роутер стоит ПОСЛЕДНИМ обработчиком текста
// (handlers/index.ts). Мастер профиля, команды и кнопки меню разбирают своё
// раньше и до сюда не доходят — иначе нажатие «⏰ Расписание» уезжало бы в
// платный API вместо того, чтобы открыть расписание.
//
// Приватность: в модель уходит ТОЛЬКО текст запроса. Ни имя, ни email, ни
// телефон, ни chat_id профиля в промпт не попадают — модели они не нужны, а
// бронь всё равно создаётся из профиля уже нашим кодом. В лог пишем факт и
// разобранный вид запроса, но не сам текст и никогда не ключ.

import { InlineKeyboard } from 'grammy';
import type { BookingIntent } from '../../core/intent.js';
import { MAX_SLOT_OPTIONS, countSlotOptions, searchSlots, slotKey } from '../../core/slot-search.js';
import { tbilisiDateOf, weekdayOf } from '../../core/scheduler.js';
import type { Slot } from '../../reservio/types.js';
import type { BotContext, BotDeps, FreeQueryDeps } from '../context.js';
import { safeErrorText } from '../errors.js';
import {
  BOOKABLE_COURTS,
  FREE_QUERY_API_DOWN,
  FREE_QUERY_STORE_DOWN,
  courtByIndex,
  courtIndexOf,
  formatFreeQueryContact,
  formatFreeQueryEmpty,
  formatFreeQueryHelp,
  formatFreeQueryOff,
  formatFreeQueryOptions,
  formatFreeQueryOutOfHorizon,
  formatFreeQueryQuota,
  formatFreeQuerySlotTaken,
  formatFreeQueryTooLong,
  formatFreeQueryTooWide,
  freeQueryButtonLabel,
  freeTimes,
  upcomingDates,
} from '../format.js';
import { cbBookTime, isProfileEmail, isProfilePhone, normalizePhone } from '../parse.js';
import { UI_DAYS_AHEAD, reply } from '../ui.js';
import { bookingConfirmView } from './book.js';
import { logOf, nowOf } from './shared.js';

/**
 * Сколько свободных запросов в сутки на профиль. Лимит — единственное, что
 * стоит между чужим текстом и платным API, поэтому без счётчика (SettingsLike)
 * ветка не включается вовсе.
 */
export const FREE_QUERY_DAILY_LIMIT = 20;

/**
 * Потолок обращений к Reservio на один запрос (дни × корты). 8 дней горизонта
 * на 6 кортов — это 48 запросов ради одной фразы; такой запрос просим сузить,
 * а не устраиваем клубу мини-DDoS (CLAUDE.md: «не превращать polling в DDoS»).
 */
export const FREE_QUERY_MAX_LOOKUPS = 14;

/** Длиннее в модель не отправляем: `/start` может принести килобайт мусора. */
export const FREE_QUERY_MAX_CHARS = 400;

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * Сообщение выглядит как контакт (адрес почты или номер телефона).
 *
 * Такой текст в модель не уходит НИКОГДА, и вот почему. Про истёкший черновик
 * мастера профиля бот объясняет ровно один раз (ProfileDraftStore.get гасит
 * пометку первым же сообщением), а мастер собирает ИМЯ, EMAIL и ТЕЛЕФОН
 * третьего человека. Админ, вернувшийся к брошенному мастеру, получает
 * «черновик истёк» на первую строку и спокойно дописывает вторую — она уже
 * никем не съедена и по общему правилу поехала бы в Anthropic API как
 * свободный запрос. Обещание docs/wiki/Bot.md («персональные данные наружу не
 * уходят») на этом пути было бы нарушено.
 *
 * Отказ здесь ничего не стоит: запросом про корты одинокий email или +995…
 * не бывает, а человек получает подсказку, а не тишину.
 */
function looksLikeContact(text: string): boolean {
  const value = text.trim();
  return isProfileEmail(value) || isProfilePhone(normalizePhone(value));
}

/** Ключ суточного счётчика. Дата — в зоне клуба, а не сервера. */
const quotaKey = (profileId: string, date: string): string => `llm_quota:${profileId}:${date}`;

/** «Этому профилю сегодня уже сказали, что свободные запросы выключены». */
const noticeKey = (profileId: string, date: string): string => `llm_off_notice:${profileId}:${date}`;

/**
 * Свободный текст авторизованного профиля.
 *
 * Молчим (как бот вёл себя до фазы 5) в двух случаях: ветка не собрана и текст
 * не наш (команда/пустое). Во всех остальных человек получает ответ: молчаливо
 * съеденное сообщение выглядит как зависший бот.
 */
export async function handleFreeQuery(ctx: BotContext, deps: BotDeps): Promise<void> {
  const text = (ctx.message?.text ?? '').trim();
  // Неизвестная команда — не свободный запрос: `/фигня` разбирать моделью
  // незачем, а известные команды сюда и не доходят.
  if (text === '' || text.startsWith('/')) return;

  const fq = deps.freeQuery;
  if (fq === undefined) return;

  const profileId = ctx.state.profile.id;
  const today = tbilisiDateOf(nowOf(deps));

  if (text.length > FREE_QUERY_MAX_CHARS) {
    await reply(ctx, formatFreeQueryTooLong(FREE_QUERY_MAX_CHARS));
    return;
  }

  // Контакт наружу не отправляем ни при каком состоянии ключа и квоты — это
  // жёсткая граница приватности, а не оптимизация (см. looksLikeContact).
  // В лог, разумеется, уходит только факт: ни адреса, ни номера.
  if (looksLikeContact(text)) {
    logOf(deps)(`свободный запрос: профиль ${profileId} — текст похож на контакт, парсер не зову`);
    await reply(ctx, formatFreeQueryContact());
    return;
  }

  // Ключа нет — модель не зовём вовсе, поэтому и квоту не тратим.
  if (fq.apiKey === '') {
    await noticeOffOnce(ctx, deps, fq, profileId, today);
    return;
  }

  if (!(await takeQuota(ctx, deps, fq, profileId, today))) return;

  const intent = await parseSafely(deps, fq, text, today);
  if (intent === null || intent.kind === 'unknown') {
    logOf(deps)(`свободный запрос: профиль ${profileId} — не разобран`);
    await reply(ctx, formatFreeQueryHelp());
    return;
  }

  if (intent.kind === 'find') {
    await runFind(ctx, deps, intent);
    return;
  }
  if (intent.kind === 'book') {
    await runBook(ctx, deps, intent);
    return;
  }

  // Недостижимо: never отобьёт новый kind без ветки. Ветка нужна именно
  // поэтому — молча съеденный запрос выглядит как зависший бот (CLAUDE.md).
  const unhandled: never = intent.kind;
  logOf(deps)(`свободный запрос: kind без обработчика — ${JSON.stringify(unhandled)}`);
  await reply(ctx, formatFreeQueryHelp());
}

// ---------------------------------------------------------------------------
// Лимит и выключенный ключ
// ---------------------------------------------------------------------------

/**
 * Сообщение «свободные запросы не настроены» — один раз в сутки на профиль.
 * Молчать нельзя (человек решит, что бот его не слышит), повторять на каждое
 * сообщение — тоже: бот превратится в эхо на любую реплику в чате.
 *
 * Хранилище недоступно — отвечаем всё равно: сказать лишний раз честнее, чем
 * промолчать.
 */
async function noticeOffOnce(
  ctx: BotContext,
  deps: BotDeps,
  fq: FreeQueryDeps,
  profileId: string,
  today: string,
): Promise<void> {
  const key = noticeKey(profileId, today);
  try {
    if ((await fq.settings.get(key)) !== null) return;
    await fq.settings.set(key, '1');
  } catch (err) {
    logOf(deps)(`свободный запрос: счётчик недоступен — ${safeErrorText(err)}`);
  }
  await reply(ctx, formatFreeQueryOff());
}

/**
 * Списывает один запрос из суточной квоты. false — дальше идти нельзя (человеку
 * уже ответили).
 *
 * Инкремент не атомарный: два сообщения в одну секунду могут списать одну
 * единицу. Это осознанно — цена ошибки здесь один лишний вызов Haiku, а
 * атомарный счётчик потребовал бы RPC-функции в Postgres ради этого одного
 * места. Зато хранилище легло — запрос НЕ проходит (fail-closed): лимит без
 * счётчика не лимит.
 *
 * Оценка «один лишний вызов» верна ровно потому, что апдейты разбираются
 * ПОСЛЕДОВАТЕЛЬНО: бот живёт на встроенном long-polling grammY (bot.start() в
 * src/bot/index.ts). При переезде на параллельную обработку (webhooks или
 * @grammyjs/runner) бёрст из двадцати сообщений прочитает used = 0 двадцать
 * раз и обойдёт суточный потолок целиком — вместе с таким переездом нужен
 * sequentialize по chat_id либо атомарный инкремент в хранилище.
 */
async function takeQuota(
  ctx: BotContext,
  deps: BotDeps,
  fq: FreeQueryDeps,
  profileId: string,
  today: string,
): Promise<boolean> {
  const key = quotaKey(profileId, today);
  let used: number;
  try {
    const raw = await fq.settings.get(key);
    const parsed = raw === null ? 0 : Number.parseInt(raw, 10);
    // Мусор в значении читаем как 0: он не должен ни отключать лимит, ни
    // намертво закрывать профилю свободные запросы.
    used = Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
    if (used >= FREE_QUERY_DAILY_LIMIT) {
      logOf(deps)(`свободный запрос: профиль ${profileId} исчерпал суточный лимит`);
      await reply(ctx, formatFreeQueryQuota(FREE_QUERY_DAILY_LIMIT));
      return false;
    }
    await fq.settings.set(key, String(used + 1));
  } catch (err) {
    // Текст про хранилище, а НЕ про Reservio: клуб тут ни при чём, и врать про
    // него нельзя — человек пойдёт проверять не то.
    logOf(deps)(`свободный запрос: счётчик лимита недоступен — ${safeErrorText(err)}`);
    await reply(ctx, FREE_QUERY_STORE_DOWN);
    return false;
  }
  return true;
}

/**
 * Вызов парсера. По контракту он не бросает (любая ошибка — null), но ловим
 * всё равно: свободный текст не должен ронять хендлер.
 *
 * В лог не уходит ни текст запроса, ни тем более ключ — только факт.
 */
async function parseSafely(
  deps: BotDeps,
  fq: FreeQueryDeps,
  text: string,
  today: string,
): Promise<BookingIntent | null> {
  try {
    return await fq.parseIntent(
      text,
      { todayTbilisi: today, weekday: weekdayOf(today), courts: BOOKABLE_COURTS.map((c) => c.name) },
      { apiKey: fq.apiKey },
    );
  } catch (err) {
    logOf(deps)(`свободный запрос: парсер не ответил — ${safeErrorText(err)}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Горизонт, даты и корты: всё, что пришло от модели, проверяется здесь заново
// ---------------------------------------------------------------------------

/** Даты клуба от сегодня до T+7 включительно — тот же горизонт, что у мастеров. */
function horizonDates(deps: BotDeps): string[] {
  return upcomingDates(nowOf(deps), UI_DAYS_AHEAD);
}

/**
 * Даты запроса внутри горизонта. Границы интента только СУЖАЮТ список: выйти
 * за горизонт клуба не может ни одна из них, что бы ни насочиняла модель.
 */
function datesOf(intent: BookingIntent, all: string[]): string[] {
  return all.filter(
    (d) =>
      (intent.dateFrom === undefined || d >= intent.dateFrom) && (intent.dateTo === undefined || d <= intent.dateTo),
  );
}

/**
 * Корты запроса. Имена приводятся к каноническим через courtIndexOf; пусто или
 * сплошной мусор — смотрим все корты клуба. Отказывать из-за выдуманного
 * названия незачем: в ответе всё равно написано, что именно нашлось.
 *
 * Канонизация тут одна на всю ветку: этот же список едет и в searchSlots
 * (см. searchIntent в runFind), иначе фильтр поиска и запросы к Reservio
 * разъехались бы по именам.
 *
 * Одиночное `court` учитываем наравне со списком: его же читает searchSlots, и
 * без этого «найди в субботу на третьем» тянуло бы availability всех шести
 * кортов только чтобы отфильтровать пять из них уже у себя.
 */
function courtsOf(intent: BookingIntent): { name: string; serviceId: string }[] {
  const picked = new Set<number>();
  for (const name of [...(intent.courts ?? []), ...(intent.court === undefined ? [] : [intent.court])]) {
    const i = courtIndexOf(name);
    if (i >= 0) picked.add(i);
  }
  if (picked.size === 0) return BOOKABLE_COURTS.map((c) => ({ name: c.name, serviceId: c.serviceId }));
  return [...picked]
    .sort((a, b) => a - b)
    .map((i) => courtByIndex(i))
    .filter((c): c is NonNullable<typeof c> => c !== null)
    .map((c) => ({ name: c.name, serviceId: c.serviceId }));
}

// ---------------------------------------------------------------------------
// kind 'find' — поиск и список вариантов
// ---------------------------------------------------------------------------

async function runFind(ctx: BotContext, deps: BotDeps, intent: BookingIntent): Promise<void> {
  const all = horizonDates(deps);
  const from = all[0] ?? '';
  const to = all[all.length - 1] ?? '';
  const dates = datesOf(intent, all);
  if (dates.length === 0) {
    await reply(ctx, formatFreeQueryOutOfHorizon(from, to));
    return;
  }

  const courts = courtsOf(intent);
  if (dates.length * courts.length > FREE_QUERY_MAX_LOOKUPS) {
    await reply(ctx, formatFreeQueryTooWide(dates.length, courts.length, FREE_QUERY_MAX_LOOKUPS));
    return;
  }

  // Параллельно: последовательный обход 14 дат занял бы десятки секунд, и
  // человек успел бы решить, что бот молчит.
  let availability: Map<string, Slot[]>;
  try {
    const pairs = dates.flatMap((date) => courts.map((court) => ({ date, court })));
    const rows = await Promise.all(
      pairs.map(
        async (p): Promise<[string, Slot[]]> => [
          slotKey(p.court.name, p.date),
          await deps.client.getAvailability(p.court.serviceId, p.date),
        ],
      ),
    );
    availability = new Map(rows);
  } catch (err) {
    // Честный текст вместо тишины: чужую ошибку не цитируем, но и не молчим.
    logOf(deps)(`свободный запрос: availability не ответил — ${safeErrorText(err)}`);
    await reply(ctx, FREE_QUERY_API_DOWN);
    return;
  }

  // В поиск отдаём НЕ имена от модели, а ровно те корты, которые спросили у
  // Reservio. searchSlots сверяет имена с ключами карты точным совпадением, а
  // карта собрана из канонических имён: выдуманный моделью «Wimbledon Centre
  // Court» прошёл бы сюда насквозь и не совпал бы ни с чем — шесть запросов в
  // клуб ради гарантированного «ничего не нашёл». Канонизация живёт в одном
  // месте (courtsOf), и оба модуля смотрят на один и тот же список.
  const searchIntent: BookingIntent = { ...intent, courts: courts.map((c) => c.name), court: undefined };

  const options = searchSlots(availability, searchIntent, { from, to });
  logOf(deps)(
    `свободный запрос: профиль ${ctx.state.profile.id}, поиск по ${dates.length} дн. × ${courts.length} корт. — ${options.length} вариантов`,
  );
  if (options.length === 0) {
    await reply(ctx, formatFreeQueryEmpty());
    return;
  }
  // Сколько вариантов НЕ поместилось: без пересчёта «ровно восемь» и «восемь из
  // сорока» выглядели бы одинаково, и человек не понял бы, что надо сузить.
  const hidden =
    options.length < MAX_SLOT_OPTIONS
      ? 0
      : Math.max(0, countSlotOptions(availability, searchIntent, { from, to }) - options.length);
  await reply(ctx, formatFreeQueryOptions(options, hidden), optionsKeyboard(options));
}

/**
 * Кнопка на КАЖДЫЙ час варианта, а не одна на вариант: слот Reservio длится
 * 59 минут, «два часа подряд» — это две отдельные брони (CLAUDE.md), и одна
 * кнопка физически не может создать обе. Честнее показать два подтверждения,
 * чем забронировать половину запрошенного и промолчать про вторую.
 *
 * callback_data — существующая схема `bk~t`: она ведёт ровно на тот же экран
 * подтверждения, что и мастер «📆 Бронировать». Ничего нового про бронь эта
 * ветка не изобретает.
 */
function optionsKeyboard(options: readonly { court: string; date: string; times: string[] }[]): InlineKeyboard {
  const kb = new InlineKeyboard();
  // Один и тот же час попадает в РАЗНЫЕ варианты: связка «20:00+21:00» и те же
  // часы поодиночке — это три варианта, но всего два бронируемых слота. Две
  // кнопки с одинаковой подписью и одинаковым callback_data выбора не дают, а
  // только сбивают с толку: ведут они в один и тот же экран подтверждения.
  const seen = new Set<string>();
  for (const option of options) {
    const index = courtIndexOf(option.court);
    // Корт не из нашего списка — кнопку не рисуем: она вела бы в никуда.
    if (index < 0) continue;
    let drawn = false;
    for (const time of option.times) {
      if (!TIME_RE.test(time)) continue;
      const data = cbBookTime(option.date, index, time);
      if (seen.has(data)) continue;
      seen.add(data);
      kb.text(freeQueryButtonLabel(option.date, time, option.court), data);
      drawn = true;
    }
    if (drawn) kb.row();
  }
  // Хвостовой пустой ряд остаётся после последнего .row() — Telegram он не нужен.
  const rows = kb.inline_keyboard;
  while (rows.length > 0 && (rows[rows.length - 1]?.length ?? 0) === 0) rows.pop();
  return kb;
}

// ---------------------------------------------------------------------------
// kind 'book' — сразу экран подтверждения конкретного слота
// ---------------------------------------------------------------------------

/**
 * «Забронируй пятницу 20:00 на Padel Court 3». Сама бронь отсюда НЕ создаётся:
 * человек получает штатный экран подтверждения, и только его кнопка «✅
 * Бронировать» дойдёт до bookNow.
 *
 * Доступность проверяем ДО экрана: подтверждать бронь занятого слота, чтобы
 * потом показать отказ, — худший из вариантов.
 */
async function runBook(ctx: BotContext, deps: BotDeps, intent: BookingIntent): Promise<void> {
  const date = intent.date ?? '';
  const time = intent.time ?? '';
  const courtIndex = courtIndexOf(intent.court ?? '');
  const court = courtIndex < 0 ? null : courtByIndex(courtIndex);

  // Модель не дала конкретики (или дала мусор) — не угадываем за человека, что
  // именно бронировать: цена ошибки здесь настоящий корт.
  if (court === null || !TIME_RE.test(time) || !horizonDates(deps).includes(date)) {
    logOf(deps)(`свободный запрос: профиль ${ctx.state.profile.id} — бронь без конкретики`);
    await reply(ctx, formatFreeQueryHelp());
    return;
  }

  let times: string[];
  try {
    times = freeTimes(await deps.client.getAvailability(court.serviceId, date));
  } catch (err) {
    logOf(deps)(`свободный запрос: availability не ответил — ${safeErrorText(err)}`);
    await reply(ctx, FREE_QUERY_API_DOWN);
    return;
  }

  if (!times.includes(time)) {
    await reply(ctx, formatFreeQuerySlotTaken(date, time, court.name));
    return;
  }

  const view = bookingConfirmView(date, courtIndex, time);
  if (view === null) {
    await reply(ctx, formatFreeQueryHelp());
    return;
  }
  logOf(deps)(`свободный запрос: профиль ${ctx.state.profile.id} — экран подтверждения ${date} ${time}`);
  await reply(ctx, view.text, view.keyboard);
}
