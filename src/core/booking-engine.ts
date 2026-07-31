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

export interface DropReport {
  ok: boolean;
  profileId: string;
  date: string;
  time: string;
  court?: string;
  bookingId?: string;
  token?: string;
  msFromSeenToBooked?: number;
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
 * id/token до нас не добрались. Пробовать после такого следующий корт — значит
 * получить две реальные брони, из которых первую нечем отменить.
 *
 * Экспортируется ради book-now.ts: правило «после неоднозначного отказа не
 * трогаем API повторно» обязано быть общим у дропа и у брони по запросу.
 */
export function isAmbiguousPostFailure(err: unknown): boolean {
  const e = err as { status?: number; code?: string } | null;
  if (e?.code === 'invalidArgument') return false; // запрос вообще не ушёл
  if (e?.code === 'unexpectedResponse') return true; // ответ пришёл, но без id
  if (e?.status === undefined) return true; // сеть/таймаут — статуса нет
  return e.status >= 500;
}

/**
 * Отрабатывает ОДИН дроп: ждёт окно, поллит availability и бронирует слот
 * `target` для профиля. Корты перебираются в порядке приоритета профиля.
 *
 * POST не ретраится НИКОГДА: на каждый корт приходится ровно одна попытка за
 * запуск, а неоднозначный отказ (таймаут/5xx) останавливает весь дроп.
 * Наружу исключения не летят — только DropReport.
 */
export async function bookSlotDrop(
  profile: Profile,
  target: { date: string; time: string },
  deps: EngineDeps,
): Promise<DropReport> {
  const { client, state } = deps;
  const now = deps.now ?? ((): Date => new Date());
  const sleep = deps.sleep ?? ((ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms)));
  const log = deps.log ?? ((): void => {});
  const { date, time } = target;

  const timeline: DropReport['timeline'] = [];
  const nowMs = (): number => now().getTime();
  const push = (event: string): void => {
    const at = tbilisiStamp(now());
    timeline.push({ at, event });
    log(`[${at}] ${profile.id} ${date} ${time}: ${event}`);
  };
  const report = (patch: Partial<DropReport> & { ok: boolean }): DropReport => ({
    profileId: profile.id,
    date,
    time,
    timeline,
    ...patch,
  });

  /**
   * Непогашенная бронь в state — стоп-сигнал: дубль хуже пропуска.
   * StateStore асинхронен (в облаке это сетевой Supabase), поэтому проверка
   * стоит десятки–сотни мс. Перед POST мы её всё равно платим: две реальные
   * брони на слот дороже, чем эта задержка в гонке за корт.
   */
  const activeBooking = async (): Promise<StoredBooking | null> => {
    const b = await state.getBooking(profile.id, date, time);
    return b && b.state !== 'canceled' ? b : null;
  };
  const alreadyBooked = (b: StoredBooking, when: string): DropReport => {
    push(`бронь уже в state (${when}): ${b.bookingId} (${b.state}) на ${b.court} — POST не делаем`);
    return report({
      ok: false,
      court: b.court,
      bookingId: b.bookingId,
      token: b.token,
      error: { kind: 'AlreadyBooked', detail: `бронь ${b.bookingId} уже сохранена, state=${b.state}` },
    });
  };

  async function attempt(): Promise<DropReport> {
    push(`старт: цель ${date} ${time}, корты ${profile.rule.courts.join(' → ')}`);

    // 1. Идемпотентность. Любая непогашенная бронь блокирует POST: дубль хуже,
    //    чем пропуск — отменять руками дороже, чем добронировать.
    const existing = await activeBooking();
    if (existing) return alreadyBooked(existing, 'старт');

    let courts: CourtInfo[];
    try {
      courts = profile.rule.courts.map((name) => courtByName(name));
    } catch (err) {
      // Ошибка конфига профиля, но наружу отдаём отчёт, а не исключение:
      // молчаливый провал — худший баг проекта.
      const detail = `корт из профиля не найден: ${describeError(err)}`;
      push(detail);
      return report({ ok: false, error: { kind: 'ApiChanged', detail } });
    }
    if (courts.length === 0) {
      const detail = 'в правиле профиля пустой список кортов';
      push(detail);
      return report({ ok: false, error: { kind: 'ApiChanged', detail } });
    }
    const serviceIds = new Set(courts.map((c) => c.serviceId));

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
      const meanwhile = await activeBooking();
      if (meanwhile) return alreadyBooked(meanwhile, 'после ожидания окна');
    }
    push(`окно открыто, дедлайн ${tbilisiStamp(watch.deadline)}, ищем start=${wantStart}`);

    let backoffStep = 0;
    let polls = 0;
    let slotSeen = false;
    let lastApiError: string | null = null;
    let lastPostError: string | null = null;
    let formatIssue: string | null = null;
    /** serviceId кортов, по которым POST уже уходил: второй раз — запрещено. */
    const posted = new Set<string>();

    for (;;) {
      polls += 1;
      let roundOk = false;
      let roundBackoff = false;

      // Корты за один цикл проверяются подряд без пауз: пауза только между циклами.
      for (const court of courts) {
        if (posted.has(court.serviceId)) continue; // свою единственную попытку корт уже израсходовал

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
        const rival = await activeBooking();
        if (rival) return alreadyBooked(rival, 'перед POST');

        const seenAtMs = nowMs();
        slotSeen = true;
        posted.add(court.serviceId);
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
            // Бронь МОГЛА быть создана — следующий корт дал бы вторую.
            const detail =
              `POST ${court.name} завершился неоднозначно (${describeError(err)}): бронь могла быть создана на сервере, ` +
              'id/token потеряны. Другие корты не пробуем — проверь почту профиля и клуб вручную';
            push(detail);
            // Ответ пришёл, но в неизвестной форме — это смена API, а не обрыв связи.
            const kind: DropErrorKind = isFormatError(err) ? 'ApiChanged' : 'Timeout';
            return report({ ok: false, court: court.name, error: { kind, detail } });
          }
          // Детерминированный отказ (4xx): брони точно нет — идём на следующий корт.
          lastPostError = `${court.name}: ${describeError(err)}`;
          push(`POST ${court.name} отклонён: ${describeError(err)} → следующий корт по приоритету`);
          continue;
        }

        if (typeof created?.bookingId !== 'string' || created.bookingId.length === 0) {
          const detail =
            `POST ${court.name}: в ответе нет bookingId — бронь могла быть создана, но её id потерян. ` +
            'Другие корты не пробуем — проверь почту профиля и клуб вручную';
          push(detail);
          return report({ ok: false, court: court.name, error: { kind: 'ApiChanged', detail } });
        }

        const msFromSeenToBooked = nowMs() - seenAtMs;
        const bookingState = typeof created.state === 'string' && created.state.length > 0 ? created.state : 'confirmed';
        const token = typeof created.token === 'string' ? created.token : '';
        if (token.length === 0) push('ВНИМАНИЕ: в ответе нет token — отменить бронь через API будет нельзя');
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
          push(`ВНИМАНИЕ: state.saveBooking упал: ${describeError(err)}`);
        }

        return report({
          ok: true,
          court: court.name,
          bookingId: created.bookingId,
          token,
          msFromSeenToBooked,
        });
      }

      if (roundOk) backoffStep = 0;
      else if (roundBackoff) backoffStep += 1;

      // Все корты израсходовали свою единственную попытку POST: дальше polling
      // бессмыслен, а повторный POST запрещён (риск дубля).
      if (posted.size >= serviceIds.size) {
        push(`POST отправлен по всем ${serviceIds.size} кортам — повторять запрещено, прекращаем`);
        break;
      }

      if (nowMs() >= deadlineMs) break;
      // 2s → 4s → 8s → 16s → 30s; сон не подрезается под дедлайн, иначе
      // нарушится минимальный интервал опроса.
      const delay = backoffStep > 0 ? Math.min(POLL_INTERVAL_MS * 2 ** (backoffStep - 1), BACKOFF_MAX_MS) : POLL_INTERVAL_MS;
      await sleep(delay);
      if (nowMs() >= deadlineMs) break;
    }

    if (formatIssue) {
      push(`итог: неожиданный формат availability после ${polls} опросов`);
      return report({ ok: false, error: { kind: 'ApiChanged', detail: formatIssue } });
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
