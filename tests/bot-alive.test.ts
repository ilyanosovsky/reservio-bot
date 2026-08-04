// Тесты пульса процесса бота (src/bot/alive.ts).
//
// Главное, что здесь проверяется: отметка bot_alive_at не имеет права пережить
// потерю связи с Telegram. Живой Node-процесс, который видит Supabase, — ещё не
// работающий бот: grammY на сетевую ошибку getUpdates не падает, а бесконечно
// ретраит, так что таймерная отметка «просто по расписанию» рапортовала бы
// heartbeat'у «бот жив», пока человек не может ни пропустить день, ни отменить
// бронь.
import { describe, expect, it, vi } from 'vitest';
import { createAliveBeacon, ALIVE_BEAT_MS } from '../src/bot/alive.js';
import { BOT_ALIVE_KEY } from '../src/core/heartbeat-logic.js';

const NOW = new Date('2026-08-04T18:00:00.000Z'); // 22:00 Тбилиси
const STAMP = '2026-08-04T22:00:00.000+04:00';

function makeBeacon(over: {
  probe?: () => Promise<unknown>;
  set?: (key: string, value: string) => Promise<void>;
  debug?: boolean;
} = {}) {
  const set = vi.fn(over.set ?? (async () => undefined));
  const probe = vi.fn(over.probe ?? (async () => ({ username: 'padel_bot' })));
  const lines: string[] = [];
  const beacon = createAliveBeacon({
    settings: { set },
    probe,
    log: (msg) => lines.push(msg),
    ...(over.debug === undefined ? {} : { debug: over.debug }),
    now: () => NOW,
  });
  return { beacon, set, probe, lines };
}

describe('createAliveBeacon', () => {
  it('проба прошла — пишет тбилисский stamp в bot_alive_at', async () => {
    const { beacon, set, probe } = makeBeacon();

    await expect(beacon.beat()).resolves.toBe(true);

    expect(probe).toHaveBeenCalledTimes(1);
    expect(set).toHaveBeenCalledWith(BOT_ALIVE_KEY, STAMP);
  });

  it('Telegram не отвечает — отметку НЕ обновляем: пусть протухнет и heartbeat скажет вслух', async () => {
    const { beacon, set, lines } = makeBeacon({
      probe: async () => {
        throw new Error('getaddrinfo ENOTFOUND api.telegram.org');
      },
    });

    await expect(beacon.beat()).resolves.toBe(false);

    expect(set).not.toHaveBeenCalled();
    expect(lines[0]).toContain('Telegram не отвечает');
  });

  it('токен из текста ошибки в лог не попадает', async () => {
    const { beacon, lines } = makeBeacon({
      probe: async () => {
        throw new Error('fetch failed: https://api.telegram.org/bot12345:AAH-secret-token/getMe');
      },
    });

    await beacon.beat();

    expect(lines[0]).not.toContain('AAH-secret-token');
    expect(lines[0]).toContain('bot***');
  });

  it('сбой записи в Supabase — только лог, исключение наружу не летит', async () => {
    const { beacon, lines } = makeBeacon({
      set: async () => {
        throw new Error('PostgREST 503');
      },
    });

    await expect(beacon.beat()).resolves.toBe(false);
    expect(lines[0]).toContain('отметка живости не сохранилась');
  });

  it('повторные сбои молчат без BOT_DEBUG и печатаются с ним', async () => {
    const failing = { set: async (): Promise<void> => Promise.reject(new Error('PostgREST 503')) };
    const quiet = makeBeacon(failing);
    await quiet.beacon.beat();
    await quiet.beacon.beat();
    await quiet.beacon.beat();
    expect(quiet.lines).toHaveLength(1); // первый сбой виден всегда

    const loud = makeBeacon({ ...failing, debug: true });
    await loud.beacon.beat();
    await loud.beacon.beat();
    expect(loud.lines).toHaveLength(2);
  });

  it('после успеха счётчик сбоев сбрасывается — следующий сбой снова виден', async () => {
    let broken = true;
    const { beacon, lines } = makeBeacon({
      set: async () => {
        if (broken) throw new Error('PostgREST 503');
      },
    });

    await beacon.beat(); // сбой №1 — в лог
    broken = false;
    await beacon.beat(); // успех
    broken = true;
    await beacon.beat(); // снова первый сбой — в лог

    expect(lines).toHaveLength(2);
  });

  it('start ставит первый удар сразу и повторяет раз в 5 минут; stop его снимает', async () => {
    vi.useFakeTimers();
    try {
      const { beacon, set } = makeBeacon();

      beacon.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(set).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(ALIVE_BEAT_MS);
      expect(set).toHaveBeenCalledTimes(2);

      beacon.stop();
      await vi.advanceTimersByTimeAsync(ALIVE_BEAT_MS * 3);
      expect(set).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('интервал — 5 минут: три пропущенных отметки подряд ещё укладываются в 15 минут heartbeat’а', () => {
    expect(ALIVE_BEAT_MS).toBe(5 * 60_000);
  });
});
