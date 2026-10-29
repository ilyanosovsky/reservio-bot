import type { Profile } from './profiles.js';
import type { StateStore, StoredBooking } from './state.js';
import type { ReservioClient } from '../reservio/client.js';
import type { BookingCreated, CourtInfo, Slot } from '../reservio/types.js';
import { courtByName } from '../reservio/types.js';
import { dropDayOf, dropWatchWindow, slotEndISO, slotStartISO, tbilisiStamp } from './scheduler.js';

export interface EngineDeps {
  client: ReservioClient;
  state: StateStore;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  log?: (msg: string) => void;
}

/**
 * `Timeout` — слот так и не появился до дедлайна. `AmbiguousPost` — слот был,
 * POST ушёл, но ответа нет (таймаут, обрыв, 5xx): бронь могла быть создана, а
 * id/token потеряны. Раньше второе шло под `Timeout`, и в Telegram писалось
 * «не дождались слота» — при том что слот был и, скорее всего, уже наш.
 */
export type DropErrorKind = 'SlotTaken' | 'ApiChanged' | 'Timeout' | 'AmbiguousPost' | 'AlreadyBooked';

/**
 * Что делать с набором кортов.
 *
 * `priority` — исходное поведение фазы 2: корты перебираются по приоритету,
 *   ПЕРВАЯ удачная бронь завершает ран, а любая живая бронь этого часа (на
 *   любом корте) запрещает POST вовсе.
 *
 * `all` — вечерняя вахта. Клуб (подтверждено админами клуба) держит Padel Court
 *   2 и 3 на 20:00–22:00 большую часть дней недели, и в публичный дроп они не
 *   выходят: 21:00 стабильно доступен только на Court 4. Поэтому вечером
 *   бронируется КАЖДЫЙ появившийся корт набора, а лишнее владелец отменяет
 *   руками: пропущенный корт вернуть нельзя, лишнюю бронь отменить можно.
 *   Идемпотентность в этом режиме по-кортовая — одна бронь на
 *   (профиль, дата, время, КОРТ).
 */
export type DropMode = 'priority' | 'all';

export interface DropTarget {
  /** YYYY-MM-DD — день игры (T+7). */
  date: string;
  /** HH:MM — час слота. */
  time: string;
  /** Имена кортов: в 'priority' это порядок приоритета, в 'all' — набор вахты. Пустым быть не может. */
  courts: string[];
  /** По умолчанию 'priority' — старое поведение. */
  mode?: DropMode;
}

/** Итог по одному корту набора: ровно одна строка на корт, в порядке набора. */
export interface DropCourtResult {
  court: string;
  ok: boolean;
  bookingId?: string;
  msFromSeenToBooked?: number;
  /** Почему на этом корте брони нет — человекочитаемо, уходит в сводку Telegram. */
  error?: string;
  /**
   * POST по этому корту завершился НЕОДНОЗНАЧНО: бронь могла быть создана на
   * сервере, а id/token до нас не доехали. Отдельный флаг, а не разбор текста
   * `error`: в режиме 'all' успех на соседнем корте делает отчёт зелёным
   * (`ok: true`, корневой `error` пуст), и без этого признака вызывающему не из
   * чего собрать предупреждение «сходи проверь почту и клуб» — фантомная бронь
   * осталась бы незамеченной до дедлайна отмены.
   */
  ambiguous?: boolean;
}

export interface DropReport {
  ok: boolean;
  profileId: string;
  date: string;
  time: string;
  /** Первая успешная бронь рана — корневые поля оставлены для совместимости с фазой 2. */
  court?: string;
  bookingId?: string;
  token?: string;
  msFromSeenToBooked?: number;
  /** Полная картина по набору кортов: и брони, и промахи, в порядке набора. */
  results: DropCourtResult[];
  timeline: Array<{ at: string; event: string }>;
  error?: { kind: DropErrorKind; detail?: string };
}

/** Базовый интервал polling. Ниже опускать нельзя (правило «не DDoS-ить API»). */
const POLL_INTERVAL_MS = 2000;
/** Потолок экспоненциального backoff при 429/5xx. */
const BACKOFF_MAX_MS = 30_000;
/**
 * Дальше этого окно не ждём. Для цели T+7 дроп всегда меньше чем через сутки
 * (окно = дата−7 суток, тот же час), так что порог отсекает именно промах с
 * датой: молча спать больше суток — это не работа, а тихий провал.
 */
const MAX_WAIT_TO_WINDOW_MS = 24 * 60 * 60 * 1000;
/**
 * Минимальный интервал между стартами POST за ран (режим 'all'). Следующий POST
 * и так ждёт ответа предыдущего, но быстрый ответ (~0,8 с) без паузы дал бы
 * интервал меньше проверенных в проде 1,5–3 с (PROTOCOL.md → «Лимиты»).
 */
const MIN_POST_GAP_MS = 1_000;
/**
 * Сколько POST максимум на корт за ран в режиме 'all': первый и до двух
 * повторов. Повтор — только после ответа 5xx И только если слот этого корта
 * на следующем опросе всё ещё свободен (см. isServerError).
 */
const MAX_POST_ATTEMPTS_PER_COURT = 3;

function describeError(err: unknown): string {
  if (err instanceof Error) {
    const { status, code } = err as Error & { status?: number; code?: string };
    return [err.message, status === undefined ? null : `status=${status}`, code ? `code=${code}` : null]
      .filter((p): p is string => p !== null && p !== '')
      .join(' ');
  }
  return String(err);
}

/** Backoff растёт только на «сетевых» отказах: 429, 5xx, обрыв связи. */
function isBackoffWorthy(err: unknown): boolean {
  const status = (err as { status?: number } | null)?.status;
  if (status === undefined) return true; // сеть/таймаут — статуса нет
  return status === 429 || status >= 500;
}

/** Клиент сам валидирует форму ответа и кидает `unexpectedResponse` — это смена API, не сеть. */
function isFormatError(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === 'unexpectedResponse';
}

/**
 * Отказ POST, после которого НЕЛЬЗЯ утверждать, что брони нет: таймаут,
 * обрыв связи, 5xx, 2xx без data.id. Запрос мог дойти и создать бронь, а
 * id/token до нас не добрались.
 *
 * В режиме 'priority' такой отказ останавливает весь дроп: цель там — ровно
 * одна бронь на час, и бронь на следующем корте оказалась бы второй, причём
 * первую нечем отменить. В режиме 'all' он закрывает только свой корт: корты
 * набора — разные service и разные ресурсы, дубля на соседнем не будет, а
 * упустить его из-за потерянного ответа по чужому корту — прямой убыток.
 *
 * Экспортируется ради book-now.ts: правило «после неоднозначного отказа не
 * трогаем этот корт повторно» обязано быть общим у дропа и у брони по запросу.
 */
export function isAmbiguousPostFailure(err: unknown): boolean {
  const e = err as { status?: number; code?: string } | null;
  if (e?.code === 'invalidArgument') return false; // запрос вообще не ушёл
  if (e?.code === 'unexpectedResponse') return true; // ответ пришёл, но без id
  if (e?.status === undefined) return true; // сеть/таймаут — статуса нет
  return e.status >= 500;
}

/**
 * Неоднозначный отказ, после которого корт в режиме 'all' можно попробовать
 * ещё раз: сервер ОТВЕТИЛ 5xx (а не промолчал), значит обработку запроса он
 * закончил и availability уже показывает итог. Если слот после этого всё ещё
 * в списке свободных — брони нет, и повторный POST дубля не создаст: занятый
 * слот Reservio отклоняет детерминированно (400 timeNotAvailable).
 *
 * Таймаут и обрыв связи сюда не входят: сервер мог ещё создавать бронь, и
 * availability в этот момент ничего не доказывает.
 *
 * Октябрь 2026: два наложившихся POST в 19:59 получили 500 «Something
 * happened», брони не создались, а слот Court 4 так и остался свободным.
 */
function isServerError(err: unknown): boolean {
  const status = (err as { status?: number } | null)?.status;
  return status !== undefined && status >= 500;
}

/**
 * POST не отправлен: очередь продержала его до дедлайна окна. Запрос в Reservio
 * не уходил — это не отказ сервера и не неоднозначность.
 */
class PostSkippedError extends Error {}

/** Бронь, созданная за ран: первая из них — корневые поля отчёта. */
interface BookedCourt {
  court: string;
  bookingId: string;
  token: string;
  msFromSeenToBooked: number;
}

/** Итог одного POST по корту. `retry` — только в 'all': 5xx, корт вернулся в вахту. */
type PostOutcome =
  | { kind: 'booked'; booked: BookedCourt }
  | { kind: 'ambiguous'; errorKind: DropErrorKind; detail: string }
  | { kind: 'rejected' }
  | { kind: 'retry' };

/** Прогресс по одному корту набора: ровно одна строка в отчёте на корт. */
interface CourtProgress {
  info: CourtInfo;
  /** Корт выбыл из работы: POST израсходованы, бронь уже была или отказ окончателен. */
  finished: boolean;
  /** availability по корту хоть раз спрашивали. */
  polled: boolean;
  /** Слот на корте хоть раз был виден. */
  seen: boolean;
  /** Когда слот впервые увидели: от этого момента считается скорость брони, в том числе с повтора. */
  firstSeenAtMs?: number;
  /** Сколько POST по корту отправлено за ран (в 'priority' — не больше одного). */
  attempts: number;
  /**
   * Последний POST по корту получил 5xx, и корт ждёт следующего опроса: слот
   * свободен — повторяем, слот пропал — корт закрывается как неоднозначный.
   */
  pendingRetry?: { kind: DropErrorKind; detail: string };
  /**
   * Хоть один POST по корту получил 5xx. Если повтор потом отклонён как
   * «занято», корт остаётся неоднозначным: слот мог занять наш же первый POST.
   */
  serverErrorDetail?: string;
  /** Итог; пока корт в работе — undefined (в отчёте достраивается по флагам). */
  result?: DropCourtResult;
}

/**
 * Отрабатывает ОДИН дроп: ждёт окно, поллит availability и бронирует слот
 * `target` для профиля по набору `target.courts`.
 *
 * Вслепую POST не повторяется НИКОГДА. В 'priority' на корт приходится ровно
 * одна попытка за запуск. В 'all' повтор возможен только после ответа 5xx и
 * только если следующий опрос показал слот этого корта свободным (не больше
 * MAX_POST_ATTEMPTS_PER_COURT попыток). Наружу исключения не летят — только
 * DropReport.
 *
 * В режиме 'all' ответа POST вахта не ждёт: пока Reservio создаёт бронь на
 * одном корте, остальные корты набора опрашиваются дальше. Сами POST при этом
 * идут строго по одному — следующий уходит только после ответа на предыдущий
 * (октябрь 2026: два наложившихся POST при медленном Reservio оба получили
 * 500, хотя по одному такие POST проходили). Отчёт строится только после
 * ответов на все отправленные POST — даже если для этого приходится ждать
 * после дедлайна окна (ожидание ограничено таймаутом POST в клиенте).
 */
export async function bookSlotDrop(
  profile: Profile,
  target: DropTarget,
  deps: EngineDeps,
): Promise<DropReport> {
  const { client, state } = deps;
  const now = deps.now ?? ((): Date => new Date());
  const sleep = deps.sleep ?? ((ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms)));
  const log = deps.log ?? ((): void => {});
  const { date, time } = target;
  const mode: DropMode = target.mode ?? 'priority';

  const timeline: DropReport['timeline'] = [];
  const nowMs = (): number => now().getTime();
  const push = (event: string): void => {
    const at = tbilisiStamp(now());
    timeline.push({ at, event });
    log(`[${at}] ${profile.id} ${date} ${time}: ${event}`);
  };

  /** Корты набора в порядке, заданном вызывающим. Заполняется после разбора конфига. */
  const courts: CourtProgress[] = [];

  /** POST режима 'all', отправленные без ожидания ответа. Не реджектятся никогда. */
  const inflight: Array<Promise<void>> = [];

  /** Что писать в отчёт про корт, оставшийся без явного итога. */
  const unfinishedReason = (c: CourtProgress): string => {
    if (!c.polled) return 'не проверялся: ран завершился раньше';
    if (c.seen) return 'слот появлялся, но брони на этом корте нет';
    return 'слот не появился до дедлайна';
  };

  const collectResults = (): DropCourtResult[] =>
    courts.map((c) => c.result ?? { court: c.info.name, ok: false, error: unfinishedReason(c) });

  const report = (patch: Partial<DropReport> & { ok: boolean }): DropReport => ({
    profileId: profile.id,
    date,
    time,
    results: collectResults(),
    timeline,
    ...patch,
  });

  /**
   * Непогашенные брони этого часа по ВСЕМ кортам. StateStore асинхронен (в
   * облаке это сетевой Supabase), поэтому проверка стоит десятки–сотни мс.
   * Перед POST мы её всё равно платим: лишняя реальная бронь дороже, чем эта
   * задержка в гонке за корт. Длительность — в таймлайн: зависший state
   * должен быть виден в output рана, а не восстанавливаться по косвенным
   * признакам (сентябрь 2026: где именно ран потерял 1,5 с, вычисляли по
   * сдвигу события «окно открыто»).
   */
  const activeSlotBookings = async (when: string): Promise<StoredBooking[]> => {
    const started = nowMs();
    const rows = await state.listBookingsForSlot(profile.id, date, time);
    push(`state: брони часа (${when}) — ${nowMs() - started} мс`);
    return Array.isArray(rows) ? rows.filter((b) => b && b.state !== 'canceled') : [];
  };

  /** Непогашенная бронь КОНКРЕТНОГО корта — точечная проверка режима 'all'. */
  const activeCourtBooking = async (court: string): Promise<StoredBooking | null> => {
    const started = nowMs();
    const b = await state.getBooking(profile.id, date, time, court);
    push(`state: бронь ${court} (перед POST) — ${nowMs() - started} мс`);
    return b && b.state !== 'canceled' ? b : null;
  };

  /** Найденные за ран чужие/старые брони этого часа: нужны для классификации итога. */
  const existing: StoredBooking[] = [];

  /** Закрывает корт по уже существующей брони: POST по нему не пойдёт. */
  const markExisting = (b: StoredBooking, when: string): void => {
    // Проверок state за ран несколько (старт, после сна, перед POST), и одна и
    // та же бронь приходит в каждой. Без дедупликации она попала бы в `existing`
    // дважды и в отчёте владельцу корт перечислялся бы по два раза.
    if (existing.some((x) => x.bookingId === b.bookingId)) return;
    existing.push(b);
    const needle = (b.court ?? '').trim().toLowerCase();
    const c = courts.find((x) => x.info.name.toLowerCase() === needle);
    if (c === undefined || c.finished) return;
    c.finished = true;
    c.pendingRetry = undefined; // корт уже наш — повторять POST после 5xx незачем
    c.result = {
      court: c.info.name,
      ok: false,
      bookingId: b.bookingId,
      error: `бронь уже была в state (${b.bookingId}, ${b.state}) — POST не делали`,
    };
    push(`бронь на ${c.info.name} уже в state (${when}): ${b.bookingId} (${b.state}) — корт пропускаем`);
  };

  /** Отчёт «ничего не делали, бронь уже есть»: сработавшая идемпотентность, а не провал. */
  const alreadyBooked = (b: StoredBooking, when: string, what: string): DropReport => {
    push(`${what} (${when})`);
    return report({
      ok: false,
      court: b.court,
      bookingId: b.bookingId,
      token: b.token,
      error: { kind: 'AlreadyBooked', detail: `${what}; бронь ${b.bookingId}, state=${b.state}` },
    });
  };

  const allFinished = (): boolean => courts.length > 0 && courts.every((c) => c.finished);

  /**
   * Перечитывает state и решает, можно ли продолжать.
   * В 'priority' любая живая бронь часа останавливает ран; в 'all' закрывается
   * только соответствующий корт, и ран останавливается, лишь когда закрыты все.
   */
  const stopOnExistingBookings = async (when: string): Promise<DropReport | null> => {
    const rows = await activeSlotBookings(when);
    if (mode === 'priority') {
      const blocking = rows[0];
      if (blocking === undefined) return null;
      return alreadyBooked(
        blocking,
        when,
        `бронь на этот час уже в state: ${blocking.bookingId} на ${blocking.court} — POST не делаем`,
      );
    }
    for (const b of rows) markExisting(b, when);
    if (!allFinished()) return null;
    return alreadyBooked(
      existing[0]!,
      when,
      `все корты набора уже забронированы (${existing.map((b) => b.court).join(', ')}) — POST не делаем`,
    );
  };

  async function attempt(): Promise<DropReport> {
    push(
      `старт: цель ${date} ${time}, режим ${mode === 'all' ? 'бронируем все появившиеся' : 'первый доступный по приоритету'}, ` +
        `корты ${target.courts.join(mode === 'all' ? ', ' : ' → ')}`,
    );

    // 1. Конфиг набора кортов. Разбираем ДО обращения к state: неизвестное имя
    //    корта — ошибка человека в правиле, сеть тут трогать незачем.
    if (!Array.isArray(target.courts) || target.courts.length === 0) {
      const detail = 'в цели дропа пустой список кортов — бронировать нечего';
      push(detail);
      return report({ ok: false, error: { kind: 'ApiChanged', detail } });
    }
    const takenServiceIds = new Set<string>();
    for (const name of target.courts) {
      let info: CourtInfo;
      try {
        info = courtByName(name);
      } catch (err) {
        // Ошибка конфига профиля, но наружу отдаём отчёт, а не исключение:
        // молчаливый провал — худший баг проекта.
        const detail = `корт из набора не найден: ${describeError(err)}`;
        push(detail);
        return report({ ok: false, error: { kind: 'ApiChanged', detail } });
      }
      // Дубль в наборе означал бы два POST на один и тот же service, то есть
      // две реальные брони на один корт. Схлопываем.
      if (takenServiceIds.has(info.serviceId)) {
        push(`корт ${info.name} указан в наборе дважды — вторую копию игнорируем`);
        continue;
      }
      takenServiceIds.add(info.serviceId);
      courts.push({ info, finished: false, polled: false, seen: false, attempts: 0 });
    }

    // 2. Идемпотентность на старте (первая из трёх проверок: старт, после сна,
    //    перед каждым POST).
    const blockedAtStart = await stopOnExistingBookings('старт');
    if (blockedAtStart !== null) return blockedAtStart;

    const wantStart = slotStartISO(date, time);
    const wantEnd = slotEndISO(date, time);

    // День наблюдения = целевая дата МИНУС 7 суток, а не «сегодня»: иначе для
    // ночных слотов и для запусков не в день дропа окно уезжает на чужие сутки.
    const dayT = dropDayOf(date);
    const watch = dropWatchWindow(dayT, time);
    const deadlineMs = watch.deadline.getTime();
    const waitMs = watch.start.getTime() - nowMs();

    if (nowMs() >= deadlineMs) {
      const detail =
        `окно дропа уже закрыто: ${tbilisiStamp(watch.start)} … ${tbilisiStamp(watch.deadline)} (день наблюдения T=${dayT}) — ` +
        'запуск не на ближайший дроп, поллить нечего';
      push(detail);
      return report({ ok: false, error: { kind: 'Timeout', detail } });
    }
    if (waitMs > MAX_WAIT_TO_WINDOW_MS) {
      const detail =
        `окно дропа откроется только ${tbilisiStamp(watch.start)} (через ${Math.round(waitMs / 60_000)} мин) — ` +
        `это не ближайший дроп, ждать не будем (цель ${date} ${time}, день наблюдения T=${dayT})`;
      push(detail);
      return report({ ok: false, error: { kind: 'Timeout', detail } });
    }
    if (waitMs > 0) {
      push(`ждём окно дропа ${waitMs} мс, старт ${tbilisiStamp(watch.start)}`);
      await sleep(waitMs);
      // Пока спали, слот мог забронировать параллельный прогон той же джобы.
      const blockedAfterWait = await stopOnExistingBookings('после ожидания окна');
      if (blockedAfterWait !== null) return blockedAfterWait;
    }
    push(`окно открыто, дедлайн ${tbilisiStamp(watch.deadline)}, ищем start=${wantStart}`);

    let backoffStep = 0;
    let polls = 0;
    let slotSeen = false;
    let lastApiError: string | null = null;
    let formatIssue: string | null = null;
    /**
     * Итоги POST по рану. Объект, а не let-переменные: в режиме 'all' их пишут
     * обработчики POST в полёте, а присваиваний внутри замыканий TS в потоке
     * управления не видит (сузил бы `let x = null` до null навсегда).
     */
    const posts: {
      /** Первая успешная бронь рана — корневые поля отчёта. */
      firstOk: BookedCourt | null;
      /** Первый неоднозначный отказ POST: о нём человек обязан узнать, даже если остальное сложилось. */
      ambiguous: { court: string; kind: DropErrorKind; detail: string } | null;
      lastError: string | null;
    } = { firstOk: null, ambiguous: null, lastError: null };
    let postsInFlight = 0;
    /** Очередь POST режима 'all': каждый ждёт ОТВЕТА на предыдущий. */
    let postGate: Promise<void> = Promise.resolve();
    /** POST, отправленные или стоящие в очереди и ещё без ответа. */
    let postsUnanswered = 0;
    let lastPostStartMs = Number.NEGATIVE_INFINITY;

    /**
     * Закрывает корт, ждавший повтора после 5xx, как неоднозначный: повторить
     * не вышло, а первый POST мог провести бронь, ответив ошибкой.
     */
    const closePendingRetry = (c: CourtProgress, why: string): void => {
      const pending = c.pendingRetry;
      if (pending === undefined) return;
      c.pendingRetry = undefined;
      c.finished = true;
      const detail = `${pending.detail}. ${why}`;
      push(detail);
      c.result = { court: c.info.name, ok: false, ambiguous: true, error: detail };
      if (posts.ambiguous === null) posts.ambiguous = { court: c.info.name, kind: pending.kind, detail };
    };

    /**
     * POST режима 'all' строго по одному: следующий уходит только после ответа
     * на предыдущий и не раньше чем через MIN_POST_GAP_MS после его старта.
     * Опрос остальных кортов при этом не ждёт — ждёт только их POST.
     */
    const postInTurn = (courtName: string, args: Parameters<ReservioClient['createBooking']>[0]): Promise<BookingCreated> => {
      if (postsUnanswered > 0) push(`POST ${courtName} в очереди: ждём ответа на предыдущий POST`);
      postsUnanswered += 1;
      const request = postGate.then(async () => {
        const gapMs = lastPostStartMs + MIN_POST_GAP_MS - nowMs();
        if (gapMs > 0) {
          push(`пауза ${gapMs} мс перед POST ${courtName}: между POST не меньше ${MIN_POST_GAP_MS} мс`);
          await sleep(gapMs);
        }
        // Очередь могла продержать POST за дедлайн окна. Такой не отправляем:
        // цепочка медленных POST после дедлайна съела бы запас maxDuration, а
        // ран, убитый до отчёта, хуже упущенного корта.
        if (nowMs() >= deadlineMs) throw new PostSkippedError(`POST ${courtName} не ушёл до дедлайна окна`);
        lastPostStartMs = nowMs();
        return client.createBooking(args);
      });
      postGate = request.then(
        () => {
          postsUnanswered -= 1;
        },
        () => {
          postsUnanswered -= 1;
        },
      );
      return request;
    };

    /**
     * Единственный POST по корту и всё, что из него следует: c.result, итоги
     * рана в `posts`, сохранение брони в state. Не бросает: в режиме 'all' его
     * никто не ждёт до конца рана, и исключение стало бы молчаливым провалом.
     */
    const bookCourt = async (c: CourtProgress, found: Slot, seenAtMs: number): Promise<PostOutcome> => {
      const court = c.info;
      const args = {
        serviceId: court.serviceId,
        start: wantStart,
        // end берём из ответа API, если он есть: он авторитетнее нашей арифметики.
        end: typeof found.end === 'string' && found.end.length > 0 ? found.end : wantEnd,
        contact: profile.contact,
      };

      let created: BookingCreated;
      try {
        // Очередь с паузой нужна только в 'all': в 'priority' следующий POST
        // и так уходит лишь после ответа на предыдущий.
        created = await (mode === 'all' ? postInTurn(court.name, args) : client.createBooking(args));
      } catch (err) {
        if (err instanceof PostSkippedError) {
          if (c.serverErrorDetail !== undefined) {
            // Это был повтор после 5xx: первый POST мог провести бронь.
            const detail =
              `POST ${court.name}: после ответа ${c.serverErrorDetail} повтор не успел уйти до дедлайна окна — ` +
              'бронь могла быть создана первым POST, id/token потеряны — проверь почту профиля и клуб вручную';
            push(detail);
            c.result = { court: court.name, ok: false, ambiguous: true, error: detail };
            if (posts.ambiguous === null) posts.ambiguous = { court: court.name, kind: 'AmbiguousPost', detail };
            return { kind: 'ambiguous', errorKind: 'AmbiguousPost', detail };
          }
          const detail = 'слот появлялся, но POST не ушёл: ждал ответа на предыдущий POST до дедлайна окна';
          push(`${court.name}: ${detail}`);
          c.result = { court: court.name, ok: false, error: detail };
          return { kind: 'rejected' };
        }
        if (mode === 'all' && isServerError(err)) c.serverErrorDetail = describeError(err);
        if (mode === 'all' && isServerError(err) && c.attempts < MAX_POST_ATTEMPTS_PER_COURT) {
          // Сервер ответил 5xx: обработку он закончил. Корт возвращается в
          // вахту — следующий опрос покажет, свободен ли слот (тогда брони нет
          // и POST повторяется) или занят (тогда корт неоднозначный).
          c.finished = false;
          c.pendingRetry = {
            kind: 'AmbiguousPost',
            detail:
              `POST ${court.name} завершился неоднозначно (${describeError(err)}): бронь могла быть создана на сервере, ` +
              'id/token потеряны — проверь почту профиля и клуб вручную',
          };
          push(
            `POST ${court.name}: ${describeError(err)} (попытка ${c.attempts} из ${MAX_POST_ATTEMPTS_PER_COURT}) → ` +
              'повторим, если на следующем опросе слот ещё свободен',
          );
          return { kind: 'retry' };
        }
        if (isAmbiguousPostFailure(err)) {
          // Бронь МОГЛА быть создана, а id/token до нас не добрались.
          // Ответ пришёл, но в неизвестной форме — это смена API, а не обрыв связи.
          const errorKind: DropErrorKind = isFormatError(err) ? 'ApiChanged' : 'AmbiguousPost';
          const detail =
            `POST ${court.name} завершился неоднозначно (${describeError(err)}): бронь могла быть создана на сервере, ` +
            'id/token потеряны — проверь почту профиля и клуб вручную' +
            (mode === 'priority'
              ? '. Другие корты не пробуем: вторая бронь на этот час была бы лишней, а первую нечем отменить'
              : '. Остальные корты набора продолжаем: это другие ресурсы, дубля на них не будет');
          push(detail);
          c.result = { court: court.name, ok: false, ambiguous: true, error: detail };
          if (posts.ambiguous === null) posts.ambiguous = { court: court.name, kind: errorKind, detail };
          return { kind: 'ambiguous', errorKind, detail };
        }
        if (c.serverErrorDetail !== undefined) {
          // Повтор после 5xx отклонён: слот уже занят — возможно, нашим же
          // первым POST, который сервер провёл, но ответил ошибкой.
          const detail =
            `POST ${court.name}: после ответа ${c.serverErrorDetail} повтор отклонён (${describeError(err)}) — ` +
            'слот мог занять наш же первый POST, id/token потеряны — проверь почту профиля и клуб вручную';
          push(detail);
          c.result = { court: court.name, ok: false, ambiguous: true, error: detail };
          if (posts.ambiguous === null) posts.ambiguous = { court: court.name, kind: 'AmbiguousPost', detail };
          return { kind: 'ambiguous', errorKind: 'AmbiguousPost', detail };
        }
        // Детерминированный отказ (4xx): брони точно нет — работаем дальше.
        posts.lastError = `${court.name}: ${describeError(err)}`;
        c.result = { court: court.name, ok: false, error: `POST отклонён: ${describeError(err)}` };
        push(
          `POST ${court.name} отклонён: ${describeError(err)} → ` +
            (mode === 'priority' ? 'следующий корт по приоритету' : 'следующий корт набора'),
        );
        return { kind: 'rejected' };
      }

      if (typeof created?.bookingId !== 'string' || created.bookingId.length === 0) {
        const detail =
          `POST ${court.name}: в ответе нет bookingId — бронь могла быть создана, но её id потерян. ` +
          'Проверь почту профиля и клуб вручную' +
          (mode === 'priority' ? '. Другие корты не пробуем' : '');
        push(detail);
        c.result = { court: court.name, ok: false, ambiguous: true, error: detail };
        if (posts.ambiguous === null) posts.ambiguous = { court: court.name, kind: 'ApiChanged', detail };
        return { kind: 'ambiguous', errorKind: 'ApiChanged', detail };
      }

      const msFromSeenToBooked = nowMs() - seenAtMs;
      const bookingState = typeof created.state === 'string' && created.state.length > 0 ? created.state : 'confirmed';
      const token = typeof created.token === 'string' ? created.token : '';
      if (token.length === 0) push(`ВНИМАНИЕ: в ответе нет token (${court.name}) — отменить бронь через API будет нельзя`);
      push(
        `бронь ${created.bookingId} (${bookingState}) на ${court.name}, ${msFromSeenToBooked} мс от появления слота` +
          (c.attempts > 1 ? ` (с попытки ${c.attempts})` : ''),
      );

      const saveStartedMs = nowMs();
      try {
        await state.saveBooking({
          profileId: profile.id,
          date,
          time,
          court: court.name,
          bookingId: created.bookingId,
          token,
          state: bookingState,
          createdAt: tbilisiStamp(now()),
        });
        push(`state: бронь ${court.name} сохранена — ${nowMs() - saveStartedMs} мс`);
      } catch (err) {
        // Бронь в API уже есть — отчёт с token остаётся единственным её следом.
        push(`ВНИМАНИЕ: state.saveBooking упал (${court.name}): ${describeError(err)}`);
      }

      const booked: BookedCourt = { court: court.name, bookingId: created.bookingId, token, msFromSeenToBooked };
      c.result = { court: court.name, ok: true, bookingId: created.bookingId, msFromSeenToBooked };
      if (posts.firstOk === null) posts.firstOk = booked;
      return { kind: 'booked', booked };
    };

    for (;;) {
      polls += 1;
      let roundOk = false;
      let roundBackoff = false;

      // Корты за один цикл проверяются подряд без пауз: пауза только между циклами.
      for (const c of courts) {
        if (c.finished) continue; // свою единственную попытку корт уже израсходовал
        const court = c.info;
        c.polled = true;

        let slots: Slot[];
        try {
          slots = await client.getAvailability(court.serviceId, date);
          roundOk = true;
        } catch (err) {
          lastApiError = `${court.name}: ${describeError(err)}`;
          if (isFormatError(err)) formatIssue = `availability ${court.name}: ${describeError(err)}`;
          else if (isBackoffWorthy(err)) roundBackoff = true;
          push(`availability ${court.name} — ошибка: ${describeError(err)}`);
          continue;
        }

        // Защита от смены формата: типы обещают массив, API — нет.
        if (!Array.isArray(slots)) {
          formatIssue = `availability ${court.name}: ответ не массив слотов`;
          push(formatIssue);
          continue;
        }

        const found = slots.find((slot) => slot?.start === wantStart);
        if (!found) {
          if (slots.length > 0 && !slots.some((slot) => typeof slot?.start === 'string')) {
            formatIssue = `availability ${court.name}: в слотах нет строкового start`;
            push(formatIssue);
          }
          // После 5xx слот пропал: занял его либо наш же POST (сервер провёл
          // бронь, но ответил ошибкой), либо кто-то другой. Повторять нечего.
          closePendingRetry(c, 'После ответа 5xx слот пропал из свободных — возможно, это наша же бронь');
          continue;
        }

        // Последняя проверка перед POST: между стартом и этой секундой бронь
        // мог создать параллельный прогон (два терминала, двойной trigger).
        // В 'priority' блокирует любая бронь часа, в 'all' — только бронь
        // ЭТОГО корта: соседние корты набора от неё не зависят.
        if (mode === 'priority') {
          const rival = (await activeSlotBookings('перед POST'))[0];
          if (rival !== undefined) {
            return alreadyBooked(
              rival,
              'перед POST',
              `бронь на этот час уже в state: ${rival.bookingId} на ${rival.court} — POST не делаем`,
            );
          }
        } else {
          const rival = await activeCourtBooking(court.name);
          if (rival !== null) {
            markExisting(rival, 'перед POST');
            continue;
          }
        }

        const seenAtMs = c.firstSeenAtMs ?? nowMs();
        c.firstSeenAtMs = seenAtMs;
        c.seen = true;
        slotSeen = true;
        c.finished = true; // попытка POST израсходована; 5xx в 'all' может вернуть корт в вахту
        c.attempts += 1;
        if (c.pendingRetry !== undefined) {
          // Сервер ответил 5xx, а слот всё ещё в списке свободных: брони нет.
          c.pendingRetry = undefined;
          push(
            `слот на ${court.name} всё ещё свободен (опрос #${polls}) → прошлый POST брони не создал, ` +
              `повтор (попытка ${c.attempts} из ${MAX_POST_ATTEMPTS_PER_COURT})`,
          );
        } else {
          push(`слот виден на ${court.name} (опрос #${polls}) → POST немедленно`);
        }

        if (mode === 'all') {
          // Ответа POST не ждём: пока Reservio создаёт бронь этого корта, вахта
          // по остальным кортам набора идёт дальше. Октябрь 2026: POST висел до
          // 5 с, и всё это время соседние корты не опрашивались и не бронировались.
          postsInFlight += 1;
          inflight.push(
            bookCourt(c, found, seenAtMs)
              .then(() => undefined)
              .catch((err: unknown) => {
                // bookCourt не бросает; это страховка от будущих правок.
                const detail =
                  `внутренний сбой при POST ${court.name}: ${describeError(err)} — бронь могла быть создана, ` +
                  'проверь почту профиля и клуб вручную';
                push(detail);
                if (c.result === undefined) c.result = { court: court.name, ok: false, ambiguous: true, error: detail };
                if (posts.ambiguous === null) posts.ambiguous = { court: court.name, kind: 'AmbiguousPost', detail };
              })
              .finally(() => {
                postsInFlight -= 1;
              }),
          );
          continue;
        }

        // 'priority': одна бронь на час — следующий корт пробуем, только если
        // POST по этому окончательно отклонён.
        const outcome = await bookCourt(c, found, seenAtMs);
        if (outcome.kind === 'booked') return report({ ok: true, ...outcome.booked });
        if (outcome.kind === 'ambiguous') {
          return report({ ok: false, court: court.name, error: { kind: outcome.errorKind, detail: outcome.detail } });
        }
      }

      if (roundOk) backoffStep = 0;
      else if (roundBackoff) backoffStep += 1;

      // Все корты набора отработали свои попытки. Если POST ещё без ответа —
      // ждём их: ответ 5xx вернёт корт в вахту, и опрос продолжится.
      if (allFinished() && postsInFlight > 0) {
        push(`ждём ответ Reservio по ${postsInFlight} POST в полёте`);
        await Promise.all(inflight);
      }
      if (allFinished()) {
        push(`по всем ${courts.length} кортам набора работа закончена — прекращаем`);
        break;
      }

      if (nowMs() >= deadlineMs) break;
      // 2s → 4s → 8s → 16s → 30s; сон не подрезается под дедлайн, иначе
      // нарушится минимальный интервал опроса.
      const delay = backoffStep > 0 ? Math.min(POLL_INTERVAL_MS * 2 ** (backoffStep - 1), BACKOFF_MAX_MS) : POLL_INTERVAL_MS;
      await sleep(delay);
      if (nowMs() >= deadlineMs) break;
    }

    // 'all': POST в полёте — тоже итог рана. Ждём их и после дедлайна: ожидание
    // ограничено таймаутом POST в клиенте, а бронь без строки в отчёте — это
    // молчаливо потерянный token.
    if (postsInFlight > 0) push(`ждём ответ Reservio по ${postsInFlight} POST в полёте`);
    await Promise.all(inflight);
    // 5xx пришёл, а повторить до дедлайна не успели — корт неоднозначный.
    for (const c of courts) closePendingRetry(c, 'Повторить до дедлайна окна не успели');

    const { firstOk, ambiguous } = posts;

    // Хотя бы одна бронь = успех рана. В 'priority' сюда доходят только неудачи:
    // успех там возвращается сразу из цикла.
    //
    // Неоднозначный отказ по ДРУГОМУ корту при этом никуда не девается: корневой
    // error у успешного рана занимать нельзя (он значит «дроп провалился»), но в
    // results этот корт помечен `ambiguous: true` — по нему вызывающий обязан
    // выдать предупреждение (см. src/trigger/book-drop.ts → ambiguousWarning).
    if (firstOk !== null) {
      const booked = courts.filter((c) => c.result?.ok === true).map((c) => c.info.name);
      push(`итог: забронировано ${booked.length} из ${courts.length} (${booked.join(', ')}) за ${polls} опросов`);
      if (ambiguous !== null) {
        push(`ВНИМАНИЕ: POST на ${ambiguous.court} завершился неоднозначно — бронь там могла быть создана, проверь вручную`);
      }
      return report({ ok: true, ...firstOk });
    }

    // Неоднозначный отказ важнее прочего: бронь МОГЛА быть создана, и человек
    // обязан это проверить, даже если остальные корты просто не появились.
    if (ambiguous !== null) {
      push(`итог: неоднозначный отказ POST на ${ambiguous.court} (${polls} опросов)`);
      return report({ ok: false, court: ambiguous.court, error: { kind: ambiguous.kind, detail: ambiguous.detail } });
    }
    if (formatIssue) {
      push(`итог: неожиданный формат availability после ${polls} опросов`);
      return report({ ok: false, error: { kind: 'ApiChanged', detail: formatIssue } });
    }
    // Новых броней нет, но старые есть — это сработавшая идемпотентность, а не
    // провал вечера: час занят нами же. Маркер в Telegram будет ℹ️, а не ❌.
    const kept = existing[0];
    if (kept !== undefined) {
      push(`итог: новых броней нет, на этом часе уже стоят наши: ${existing.map((b) => `${b.court} (${b.bookingId})`).join(', ')}`);
      return report({
        ok: false,
        court: kept.court,
        bookingId: kept.bookingId,
        token: kept.token,
        error: {
          kind: 'AlreadyBooked',
          detail:
            `новых броней нет; уже были: ${existing.map((b) => `${b.court} ${b.bookingId}`).join(', ')}` +
            (slotSeen ? '; на остальных кортах слот появлялся, но POST не прошёл' : '; на остальных кортах слот не появился'),
        },
      });
    }
    if (slotSeen) {
      push(`итог: слот появлялся, но забронировать не удалось (${polls} опросов)`);
      return report({
        ok: false,
        error: {
          kind: 'SlotTaken',
          detail: posts.lastError
            ? `слот появлялся, но POST отклонён на всех кортах (${polls} опросов); последний отказ — ${posts.lastError}`
            : `слот появлялся, но все POST провалились (${polls} опросов)`,
        },
      });
    }
    push(`итог: слот не появился до дедлайна (${polls} опросов)`);
    return report({
      ok: false,
      error: {
        kind: 'Timeout',
        detail: lastApiError
          ? `слот не появился до дедлайна (${polls} опросов); последняя ошибка API — ${lastApiError}`
          : `слот не появился до дедлайна (${polls} опросов)`,
      },
    });
  }

  try {
    return await attempt();
  } catch (err) {
    // Кривые date/time, падение state, любая внутренняя ошибка — наружу всё
    // равно уходит отчёт: без него в Telegram не уйдёт ни одного сообщения.
    const detail = `внутренний сбой движка: ${describeError(err)}`;
    push(detail);
    // POST в полёте всё равно дожидаемся: их брони реальные, и без строки в
    // results отчёт о них промолчал бы.
    await Promise.all(inflight);
    return report({ ok: false, error: { kind: 'ApiChanged', detail } });
  }
}
