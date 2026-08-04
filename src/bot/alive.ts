/**
 * Пульс процесса бота: отметка settings.bot_alive_at, по которой таск heartbeat
 * (src/trigger/heartbeat.ts) в 22:12 Тбилиси понимает, что бот жив.
 *
 * Умерший бот сам о себе сообщить не может — человек просто перестаёт получать
 * ответы и не догадывается об этом, пока не понадобится «Пропустить» или отмена
 * брони.
 *
 * Почему перед записью отметки идёт ПРОБА Telegram (обычно `bot.api.getMe()`).
 * Живой Node-процесс, который видит Supabase, — ещё не работающий бот. grammY на
 * сетевую ошибку getUpdates не падает, а бесконечно ретраит: если хост потерял
 * маршрут именно до api.telegram.org (DNS, блокировка провайдера), процесс жив и
 * глух, а таймерная отметка каждые 5 минут рапортовала бы «бот жив». Проба идёт
 * тем же сетевым путём, что и long-polling, и стоит один запрос в 5 минут:
 * не прошла — отметку НЕ обновляем, и heartbeat увидит протухшую.
 *
 * Отметка вспомогательная: её сбой не имеет права ни уронить бота, ни залить
 * лог. Первый сбой печатаем всегда (иначе heartbeat разбудит админов, а в логах
 * бота будет пусто), повторные — только под BOT_DEBUG.
 *
 * Модуль намеренно не импортирует grammY: проба приходит функцией снаружи
 * (src/bot/index.ts), поэтому пульс проверяется тестами без живого бота.
 */

import { BOT_ALIVE_KEY } from '../core/heartbeat-logic.js';
import { tbilisiStamp } from '../core/scheduler.js';
import { safeErrorText } from './errors.js';

/**
 * Как часто бот отмечается живым. Таск heartbeat считает отметку старше
 * BOT_STALE_MS = 15 минут признаком смерти процесса, так что интервал в 5 минут
 * даёт запас на две пропущенные отметки подряд (сетевой сбой, рестарт хостинга)
 * без ложной тревоги.
 */
export const ALIVE_BEAT_MS = 5 * 60_000;

export interface AliveBeaconDeps {
  settings: { set(key: string, value: string): Promise<void> };
  /** Проба живого канала к Telegram — обычно `() => bot.api.getMe()`. */
  probe: () => Promise<unknown>;
  log: (msg: string) => void;
  /** BOT_DEBUG: печатать ли КАЖДЫЙ сбой, а не только первый. */
  debug?: boolean;
  /** Только для тестов: подмена часов и интервала. */
  now?: () => Date;
  intervalMs?: number;
}

export interface AliveBeacon {
  /** Одна отметка. true — проба прошла и stamp записан. Не бросает исключений. */
  beat(): Promise<boolean>;
  /** Ставит первый удар и таймер (unref — не удерживает процесс при остановке). */
  start(): void;
  /** Останавливает таймер (для тестов и штатной остановки). */
  stop(): void;
}

export function createAliveBeacon(deps: AliveBeaconDeps): AliveBeacon {
  const now = deps.now ?? ((): Date => new Date());
  const intervalMs = deps.intervalMs ?? ALIVE_BEAT_MS;
  let failures = 0;
  let timer: ReturnType<typeof setInterval> | null = null;

  /** Сбой пульса: первый — всегда в лог, повторные — только под BOT_DEBUG. */
  const noteFailure = (what: string): void => {
    failures += 1;
    if (failures === 1 || deps.debug === true) deps.log(what);
  };

  const beat = async (): Promise<boolean> => {
    try {
      await deps.probe();
    } catch (err) {
      // Канал до Telegram лёг: отметку НЕ обновляем — пусть протухнет и
      // heartbeat скажет об этом вслух, вместо того чтобы врать «бот жив».
      noteFailure(`Telegram не отвечает, отметка живости не обновлена: ${safeErrorText(err)}`);
      return false;
    }
    try {
      await deps.settings.set(BOT_ALIVE_KEY, tbilisiStamp(now()));
      failures = 0;
      return true;
    } catch (err) {
      noteFailure(`отметка живости не сохранилась: ${safeErrorText(err)}`);
      return false;
    }
  };

  return {
    beat,
    start(): void {
      void beat();
      if (timer !== null) return;
      timer = setInterval(() => void beat(), intervalMs);
      // unref: таймер живости не должен удерживать процесс при остановке бота.
      timer.unref?.();
    },
    stop(): void {
      if (timer === null) return;
      clearInterval(timer);
      timer = null;
    },
  };
}
