// Таск trigger.dev "book-slot-drop" — ТОЛЬКО ручной запуск (дашборд / CLI /
// mcp__trigger__trigger_task). НИКАКОГО schedules/cron: автоматическое
// расписание запрещено до фазы 4 и явного одобрения пользователя
// (см. CLAUDE.md → "Пока идёт разработка (фазы 0–3) — никаких автоматических
// бронирований по cron").
//
// State в облаке: файловый better-sqlite3 недоступен на воркерах trigger.dev,
// поэтому здесь MemoryStateStore — состояние живёт только в рамках одного
// run и НЕ переживает рестарт/следующий запуск. Частичная защита от дубля:
// concurrencyLimit 1 (два параллельных run'а не столкнутся) + отказ от
// автоматических ретраев. ПОВТОРНЫЙ ручной запуск с live:true на уже
// забронированный слот всё ещё создаст дубль — идемпотентность между run'ами
// невозможна без общего хранилища.
// TODO(фаза 4): заменить на SupabaseStateStore (общий для воркеров и бота),
// тогда getBooking перед POST начнёт работать и между запусками.
//
// Приватность: контакт профиля (CLIENT_*) и guest-token в логи/output не
// попадают — CLAUDE.md запрещает логировать их, а output рана виден всем, у
// кого есть доступ к дашборду. Token живёт в state рана и в письме-подтверждении.

import { task, logger } from '@trigger.dev/sdk';
import { ReservioClient } from '../reservio/client.js';
import type { BookingCreated, ClientContact } from '../reservio/types.js';
import { loadProfiles, ruleAppliesOn } from '../core/profiles.js';
import { MemoryStateStore } from '../core/state.js';
import { bookSlotDrop, type EngineDeps, type DropReport } from '../core/booking-engine.js';

export interface BookSlotDropPayload {
  profileId: string;
  date: string; // YYYY-MM-DD
  time: string; // HH:MM
  live: boolean; // false = DRY-RUN (без реального POST), true = реальная бронь
  /** true — игнорировать ограничение rule.daysOfWeek профиля. */
  force?: boolean;
}

/** token — единственный ключ к брони: в output рана его быть не должно. */
function redactToken(report: DropReport): DropReport {
  if (!report.token) return report;
  return { ...report, token: '<скрыт: см. state/письмо-подтверждение>' };
}

export const bookSlotDropTask = task({
  id: 'book-slot-drop',
  // не ретраить: MemoryStateStore не персистентен между запусками, повторный
  // run() при live:true рискует создать вторую реальную бронь на тот же слот
  retry: { maxAttempts: 1 },
  // и по той же причине — никаких параллельных run'ов этого таска
  queue: { concurrencyLimit: 1 },
  run: async (payload: BookSlotDropPayload): Promise<DropReport> => {
    const { profileId, date, time, live } = payload;
    logger.info('book-slot-drop: старт', { profileId, date, time, live });

    const profiles = loadProfiles(process.env);
    const profile = profiles.find((p) => p.id === profileId);
    if (!profile) {
      throw new Error(`Профиль "${profileId}" не найден. Доступные: ${profiles.map((p) => p.id).join(', ')}`);
    }

    // Правило профиля может ограничивать дни недели — молча бронировать
    // «лишний» день нельзя, поэтому громкий отказ, а не тихий пропуск.
    if (!payload.force && !ruleAppliesOn(profile.rule, date)) {
      throw new Error(
        `Дата ${date} вне дней недели профиля "${profileId}" (daysOfWeek=${(profile.rule.daysOfWeek ?? []).join(',')}). ` +
          'Передай force:true, если бронь всё равно нужна.',
      );
    }

    const state = new MemoryStateStore();
    const realClient = new ReservioClient({ log: (msg) => logger.info(msg) });

    // DRY-RUN: тот же движок (polling, окно, идемпотентность), но createBooking
    // подменён заглушкой — реального POST в Reservio API не происходит
    const client: Pick<ReservioClient, 'getAvailability' | 'createBooking' | 'cancelBooking' | 'getBooking'> = live
      ? realClient
      : {
          getAvailability: realClient.getAvailability.bind(realClient),
          cancelBooking: realClient.cancelBooking.bind(realClient),
          getBooking: realClient.getBooking.bind(realClient),
          createBooking: async (bookArgs: {
            serviceId: string;
            start: string;
            end: string;
            contact: ClientContact;
          }): Promise<BookingCreated> => {
            // contact НЕ логируем: имя/email/телефон — персональные данные.
            logger.info('[DRY] бронировал бы', {
              serviceId: bookArgs.serviceId,
              start: bookArgs.start,
              end: bookArgs.end,
              profileId,
            });
            return { bookingId: `dry-${Date.now()}`, token: 'dry-token', state: 'confirmed' };
          },
        };

    const deps: EngineDeps = {
      client: client as ReservioClient,
      state,
      log: (msg: string) => logger.info(msg),
    };

    const report = await bookSlotDrop(profile, { date, time }, deps);
    logger.info('book-slot-drop: финиш', { ok: report.ok, court: report.court, error: report.error });
    if (report.ok && live) {
      logger.warn('token брони не выводится в логи/output — управлять бронью можно по ссылке из письма-подтверждения');
    }
    return redactToken(report);
  },
});
