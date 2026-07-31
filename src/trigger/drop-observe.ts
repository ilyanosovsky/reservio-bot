// Таск trigger.dev "drop-observe" — ДИАГНОСТИКА дропа, броней НЕ делает.
// Поллит полные списки availability нескольких кортов на целевую дату T+7 и
// фиксирует секунду появления КАЖДОГО нового слота. Нужен, чтобы разделить
// гипотезы аномалии 21:00 (см. docs/PROTOCOL.md, «Аномалия 21:00»):
// админ-бронь клуба (слот не выходит в публичный дроп вовсе) vs ранний дроп.
//
// Нагрузка на API сознательно щадящая: 2 c в «горячие» минуты вокруг границы
// часа (XX:57:00–XX+1:03:00 — по замерам дроп в H:58:50–59:05), 10 c в
// остальное время. Ручной/отложенный запуск, НИКАКОГО cron.

import { logger, task } from '@trigger.dev/sdk';
import { ReservioClient } from '../reservio/client.js';
import { COURTS, courtByName, type CourtInfo } from '../reservio/types.js';
import { dropDayOf, slotStartISO, tbilisiStamp } from '../core/scheduler.js';
import { sendTelegram, telegramFromEnv } from '../core/notify.js';

export interface DropObservePayload {
  /** Целевая дата слотов (T+7), например '2026-08-07'. Наблюдение идёт в день date−7. */
  date: string;
  /** Окно наблюдения по Тбилиси, по умолчанию 20:50–22:10. */
  fromTime?: string;
  toTime?: string;
  /** Имена кортов; по умолчанию все 4 падел-корта. */
  courts?: string[];
}

export interface SlotAppearance {
  court: string;
  slotStart: string; // '2026-08-07T21:00:00+04:00'
  seenAt: string; // tbilisiStamp момента обнаружения
  /** Мс с предыдущего успешного опроса этого корта: точность фиксации. */
  sincePrevPollMs: number;
}

export interface DropObserveResult {
  date: string;
  windowTbilisi: { from: string; to: string };
  /** Слоты, уже видимые на первом опросе (дропнули раньше окна). */
  initialSnapshot: Record<string, string[]>;
  appearances: SlotAppearance[];
  /** Вечерние часы (19–23), так и не появившиеся ни разу, по кортам. */
  neverAppeared: Record<string, string[]>;
  pollStats: Record<string, { polls: number; errors: number }>;
}

const EVENING_HOURS = ['19:00', '20:00', '21:00', '22:00', '23:00'];
const HOT_INTERVAL_MS = 2_000;
const IDLE_INTERVAL_MS = 10_000;

/** «Горячие» минуты вокруг границы часа: 57–59 и 0–3. Экспорт — для тестов. */
export function pollIntervalMs(minuteTbilisi: number): number {
  return minuteTbilisi >= 57 || minuteTbilisi <= 3 ? HOT_INTERVAL_MS : IDLE_INTERVAL_MS;
}

function tbilisiMinute(now: Date): number {
  return new Date(now.getTime() + 4 * 3_600_000).getUTCMinutes();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const dropObserve = task({
  id: 'drop-observe',
  maxDuration: 2 * 3600,
  retry: { maxAttempts: 1 },
  run: async (payload: DropObservePayload): Promise<DropObserveResult> => {
    const { date } = payload;
    const fromTime = payload.fromTime ?? '20:50';
    const toTime = payload.toTime ?? '22:10';
    const courts: CourtInfo[] = (payload.courts ?? COURTS.slice(0, 4).map((c) => c.name)).map(
      courtByName,
    );

    const dayT = dropDayOf(date); // день наблюдения = целевая дата − 7 суток
    const windowStart = new Date(slotStartISO(dayT, fromTime));
    const windowEnd = new Date(slotStartISO(dayT, toTime));
    if (Number.isNaN(windowStart.getTime()) || Number.isNaN(windowEnd.getTime())) {
      throw new Error(`невалидное окно наблюдения: ${fromTime}–${toTime}`);
    }

    const client = new ReservioClient({ log: (m) => logger.debug(m) });
    const seen = new Map<string, Set<string>>(courts.map((c) => [c.name, new Set()]));
    const lastPollAt = new Map<string, number>();
    const initialSnapshot: Record<string, string[]> = {};
    const appearances: SlotAppearance[] = [];
    const pollStats: Record<string, { polls: number; errors: number }> = Object.fromEntries(
      courts.map((c) => [c.name, { polls: 0, errors: 0 }]),
    );

    logger.info(
      `drop-observe: дата ${date}, день наблюдения ${dayT}, окно ${fromTime}–${toTime} (+04:00), корты: ${courts
        .map((c) => c.name)
        .join(', ')}`,
    );

    // Ждём начала окна (отложенный запуск может прийти раньше).
    while (Date.now() < windowStart.getTime()) {
      const waitMs = windowStart.getTime() - Date.now();
      if (waitMs > 60_000) {
        logger.info(`до окна наблюдения ${Math.round(waitMs / 1000)} с`);
        await sleep(60_000);
      } else {
        await sleep(waitMs);
      }
    }

    let firstCycle = true;
    while (Date.now() < windowEnd.getTime()) {
      const cycleStart = Date.now();
      await Promise.all(
        courts.map(async (court) => {
          const stats = pollStats[court.name];
          try {
            const slots = await client.getAvailability(court.serviceId, date);
            const now = new Date();
            const prev = lastPollAt.get(court.name);
            stats.polls += 1;
            const courtSeen = seen.get(court.name)!;
            for (const slot of slots) {
              if (courtSeen.has(slot.start)) continue;
              courtSeen.add(slot.start);
              if (firstCycle || prev === undefined) continue; // снапшот, не «появление»
              const appearance: SlotAppearance = {
                court: court.name,
                slotStart: slot.start,
                seenAt: tbilisiStamp(now),
                sincePrevPollMs: now.getTime() - prev,
              };
              appearances.push(appearance);
              logger.info(
                `ПОЯВИЛСЯ: ${court.name} ${slot.start} (замечен ${appearance.seenAt}, зазор ${appearance.sincePrevPollMs} мс)`,
              );
            }
            lastPollAt.set(court.name, now.getTime());
            if (initialSnapshot[court.name] === undefined) {
              initialSnapshot[court.name] = [...courtSeen].sort();
            }
          } catch (err) {
            stats.errors += 1;
            logger.warn(`опрос ${court.name} упал: ${err instanceof Error ? err.message : String(err)}`);
          }
        }),
      );
      firstCycle = false;
      const interval = pollIntervalMs(tbilisiMinute(new Date()));
      const elapsed = Date.now() - cycleStart;
      await sleep(Math.max(interval - elapsed, 500));
    }

    const neverAppeared: Record<string, string[]> = {};
    for (const court of courts) {
      const courtSeen = seen.get(court.name)!;
      neverAppeared[court.name] = EVENING_HOURS.map((t) => slotStartISO(date, t)).filter(
        (s) => !courtSeen.has(s),
      );
    }

    const result: DropObserveResult = {
      date,
      windowTbilisi: { from: `${dayT}T${fromTime}+04:00`, to: `${dayT}T${toTime}+04:00` },
      initialSnapshot,
      appearances,
      neverAppeared,
      pollStats,
    };

    // Компактный отчёт в Telegram (диагностика, без секретов).
    const target = telegramFromEnv(process.env);
    if (target) {
      const lines = [
        `🔬 <b>Дроп-диагностика ${date}</b> (окно ${fromTime}–${toTime})`,
        ...appearances.map(
          (a) => `• ${a.slotStart.slice(11, 16)} ${a.court.replace('Padel Court', 'C')} — появился в ${a.seenAt.slice(11, 19)} (±${Math.round(a.sincePrevPollMs / 1000)}с)`,
        ),
        ...(appearances.length === 0 ? ['За окно не появилось ни одного нового слота.'] : []),
        `Не появились (19–23): ${courts
          .map((c) => `${c.name.replace('Padel Court', 'C')}: ${neverAppeared[c.name].map((s) => s.slice(11, 16)).join(',') || '—'}`)
          .join(' | ')}`,
      ];
      await sendTelegram(target, lines.join('\n'));
    } else {
      logger.warn('Telegram не настроен — отчёт только в output рана');
    }

    return result;
  },
});
