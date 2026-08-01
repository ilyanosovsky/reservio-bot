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

export type DropErrorKind = 'SlotTaken' | 'ApiChanged' | 'Timeout' | 'AlreadyBooked';

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

/** Прогресс по одному корту набора: у каждого ровно одна попытка POST и ровно одна строка в отчёте. */
interface CourtProgress {
  info: CourtInfo;
  /** Корт выбыл из работы: POST израсходован, бронь уже была или отказ окончателен. */
  finished: boolean;
  /** availability по корту хоть раз спрашивали. */
  polled: boolean;
  /** Слот на корте хоть раз был виден. */
  seen: boolean;
  /** Итог; пока корт в работе — undefined (в отчёте достраивается по флагам). */
  result?: DropCourtResult;
}

/**
 * Отрабатывает ОДИН дроп: ждёт окно, поллит availability и бронирует слот
 * `target` для профиля по набору `target.courts`.
 *
 * POST не ретраится НИКОГДА: на каждый корт приходится ровно одна попытка за
 * запуск. Наружу исключения не летят — только DropReport.
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
   * задержка в гонке за корт.
   */
  const activeSlotBookings = async (): Promise<StoredBooking[]> => {
    const rows = await state.listBookingsForSlot(profile.id, date, time);
    return Array.isArray(rows) ? rows.filter((b) => b && b.state !== 'canceled') : [];
  };

  /** Непогашенная бронь КОНКРЕТНОГО корта — точечная проверка режима 'all'. */
  const activeCourtBooking = async (court: string): Promise<StoredBooking | null> => {
    const b = await state.getBooking(profile.id, date, time, court);
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
    const rows = await activeSlotBookings();
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
      courts.push({ info, finished: false, polled: false, seen: false });
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
    let lastPostError: string | null = null;
    let formatIssue: string | null = null;
    /** Первая успешная бронь рана — корневые поля отчёта. */
    let firstOk: { court: string; bookingId: string; token: string; msFromSeenToBooked: number } | null = null;
    /** Первый неоднозначный отказ POST: о нём человек обязан узнать, даже если остальное сложилось. */
    let ambiguous: { court: string; kind: DropErrorKind; detail: string } | null = null;

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
          continue;
        }

        // Последняя проверка перед POST: между стартом и этой секундой бронь
        // мог создать параллельный прогон (два терминала, двойной trigger).
        // В 'priority' блокирует любая бронь часа, в 'all' — только бронь
        // ЭТОГО корта: соседние корты набора от неё не зависят.
        if (mode === 'priority') {
          const rival = (await activeSlotBookings())[0];
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

        const seenAtMs = nowMs();
        c.seen = true;
        slotSeen = true;
        c.finished = true; // единственная попытка POST на корт — израсходована
        push(`слот виден на ${court.name} (опрос #${polls}) → POST немедленно`);

        let created: BookingCreated;
        try {
          created = await client.createBooking({
            serviceId: court.serviceId,
            start: wantStart,
            // end берём из ответа API, если он есть: он авторитетнее нашей арифметики.
            end: typeof found.end === 'string' && found.end.length > 0 ? found.end : wantEnd,
            contact: profile.contact,
          });
        } catch (err) {
          if (isAmbiguousPostFailure(err)) {
            // Бронь МОГЛА быть создана, а id/token до нас не добрались.
            // Ответ пришёл, но в неизвестной форме — это смена API, а не обрыв связи.
            const kind: DropErrorKind = isFormatError(err) ? 'ApiChanged' : 'Timeout';
            const detail =
              `POST ${court.name} завершился неоднозначно (${describeError(err)}): бронь могла быть создана на сервере, ` +
              'id/token потеряны — проверь почту профиля и клуб вручную' +
              (mode === 'priority'
                ? '. Другие корты не пробуем: вторая бронь на этот час была бы лишней, а первую нечем отменить'
                : '. Остальные корты набора продолжаем: это другие ресурсы, дубля на них не будет');
            push(detail);
            c.result = { court: court.name, ok: false, ambiguous: true, error: detail };
            if (ambiguous === null) ambiguous = { court: court.name, kind, detail };
            if (mode === 'priority') return report({ ok: false, court: court.name, error: { kind, detail } });
            continue;
          }
          // Детерминированный отказ (4xx): брони точно нет — работаем дальше.
          lastPostError = `${court.name}: ${describeError(err)}`;
          c.result = { court: court.name, ok: false, error: `POST отклонён: ${describeError(err)}` };
          push(
            `POST ${court.name} отклонён: ${describeError(err)} → ` +
              (mode === 'priority' ? 'следующий корт по приоритету' : 'следующий корт набора'),
          );
          continue;
        }

        if (typeof created?.bookingId !== 'string' || created.bookingId.length === 0) {
          const detail =
            `POST ${court.name}: в ответе нет bookingId — бронь могла быть создана, но её id потерян. ` +
            'Проверь почту профиля и клуб вручную' +
            (mode === 'priority' ? '. Другие корты не пробуем' : '');
          push(detail);
          c.result = { court: court.name, ok: false, ambiguous: true, error: detail };
          if (ambiguous === null) ambiguous = { court: court.name, kind: 'ApiChanged', detail };
          if (mode === 'priority') return report({ ok: false, court: court.name, error: { kind: 'ApiChanged', detail } });
          continue;
        }

        const msFromSeenToBooked = nowMs() - seenAtMs;
        const bookingState = typeof created.state === 'string' && created.state.length > 0 ? created.state : 'confirmed';
        const token = typeof created.token === 'string' ? created.token : '';
        if (token.length === 0) push(`ВНИМАНИЕ: в ответе нет token (${court.name}) — отменить бронь через API будет нельзя`);
        push(`бронь ${created.bookingId} (${bookingState}) на ${court.name}, ${msFromSeenToBooked} мс от появления слота`);

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
        } catch (err) {
          // Бронь в API уже есть — отчёт с token остаётся единственным её следом.
          push(`ВНИМАНИЕ: state.saveBooking упал (${court.name}): ${describeError(err)}`);
        }

        c.result = { court: court.name, ok: true, bookingId: created.bookingId, msFromSeenToBooked };
        if (firstOk === null) {
          firstOk = { court: court.name, bookingId: created.bookingId, token, msFromSeenToBooked };
        }
        // 'priority': цель достигнута, остальные корты не нужны.
        // 'all': продолжаем вахту по оставшимся кортам набора до дедлайна.
        if (mode === 'priority') {
          return report({ ok: true, court: court.name, bookingId: created.bookingId, token, msFromSeenToBooked });
        }
      }

      if (roundOk) backoffStep = 0;
      else if (roundBackoff) backoffStep += 1;

      // Все корты набора отработали свою единственную попытку: дальше polling
      // бессмыслен, а повторный POST запрещён (риск дубля).
      if (allFinished()) {
        push(`по всем ${courts.length} кортам набора работа закончена — повторный POST запрещён, прекращаем`);
        break;
      }

      if (nowMs() >= deadlineMs) break;
      // 2s → 4s → 8s → 16s → 30s; сон не подрезается под дедлайн, иначе
      // нарушится минимальный интервал опроса.
      const delay = backoffStep > 0 ? Math.min(POLL_INTERVAL_MS * 2 ** (backoffStep - 1), BACKOFF_MAX_MS) : POLL_INTERVAL_MS;
      await sleep(delay);
      if (nowMs() >= deadlineMs) break;
    }

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
          detail: lastPostError
            ? `слот появлялся, но POST отклонён на всех кортах (${polls} опросов); последний отказ — ${lastPostError}`
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
    return report({ ok: false, error: { kind: 'ApiChanged', detail } });
  }
}
