import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DropReport } from '../src/core/booking-engine.js';
import { formatDropReport, sendTelegram, telegramFromEnv } from '../src/core/notify.js';

const TOKEN = '123456:AAsecretTokenValueDoNotLeak';
const CHAT_ID = '-100987654321';
const TARGET = { botToken: TOKEN, chatId: CHAT_ID };

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** Мок fetch, который просто отдаёт готовый Response. */
function fetchStub(res: Response) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return res;
  }) as unknown as typeof fetch;
  return { fn, calls };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('telegramFromEnv', () => {
  it('оба ключа заданы — возвращает target', () => {
    expect(telegramFromEnv({ TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: CHAT_ID })).toEqual({
      botToken: TOKEN,
      chatId: CHAT_ID,
    });
  });

  it('обрезает пробелы по краям', () => {
    expect(telegramFromEnv({ TELEGRAM_BOT_TOKEN: `  ${TOKEN}  `, TELEGRAM_CHAT_ID: ` ${CHAT_ID} ` })).toEqual({
      botToken: TOKEN,
      chatId: CHAT_ID,
    });
  });

  it('не настроено — null, если чего-то не хватает', () => {
    expect(telegramFromEnv({})).toBeNull();
    expect(telegramFromEnv({ TELEGRAM_BOT_TOKEN: TOKEN })).toBeNull();
    expect(telegramFromEnv({ TELEGRAM_CHAT_ID: CHAT_ID })).toBeNull();
    expect(telegramFromEnv({ TELEGRAM_BOT_TOKEN: '', TELEGRAM_CHAT_ID: CHAT_ID })).toBeNull();
    expect(telegramFromEnv({ TELEGRAM_BOT_TOKEN: '   ', TELEGRAM_CHAT_ID: CHAT_ID })).toBeNull();
  });
});

describe('sendTelegram', () => {
  it('строит URL bot{token}/sendMessage и body с parse_mode=HTML', async () => {
    const { fn, calls } = fetchStub(jsonRes({ ok: true, result: {} }));
    const ok = await sendTelegram(TARGET, 'привет <b>мир</b>', { fetchFn: fn });

    expect(ok).toBe(true);
    expect(calls).toHaveLength(1);
    const { url, init } = calls[0]!;
    expect(url).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(JSON.parse(String(init.body))).toEqual({
      chat_id: CHAT_ID,
      text: 'привет <b>мир</b>',
      parse_mode: 'HTML',
    });
  });

  it('2xx от Telegram — true', async () => {
    const { fn } = fetchStub(jsonRes({ ok: true, result: {} }, 200));
    await expect(sendTelegram(TARGET, 'x', { fetchFn: fn })).resolves.toBe(true);
  });

  it('4xx/5xx от Telegram — false, без исключения', async () => {
    const bad = fetchStub(jsonRes({ ok: false, description: 'chat not found' }, 400));
    await expect(sendTelegram(TARGET, 'x', { fetchFn: bad.fn })).resolves.toBe(false);

    const down = fetchStub(jsonRes({}, 500));
    await expect(sendTelegram(TARGET, 'x', { fetchFn: down.fn })).resolves.toBe(false);
  });

  it('fetch кидает — false, а не исключение', async () => {
    const fn = vi.fn(async () => {
      throw new TypeError('network down');
    }) as unknown as typeof fetch;

    await expect(sendTelegram(TARGET, 'x', { fetchFn: fn })).resolves.toBe(false);
  });

  it('таймаут 5с — сигнал прерывается, результат false', async () => {
    vi.useFakeTimers();
    let aborted = false;
    const fn = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            aborted = true;
            reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
          });
        }),
    ) as unknown as typeof fetch;

    const p = sendTelegram(TARGET, 'x', { fetchFn: fn });
    await vi.advanceTimersByTimeAsync(4_999);
    expect(aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(2);

    expect(aborted).toBe(true);
    await expect(p).resolves.toBe(false);
  });

  it('текст длиннее лимита Telegram обрезается по границе строки, HTML не рвётся', async () => {
    // Иначе Telegram отвечает 400 и вечерний отчёт не доходит вообще —
    // ровно тот молчаливый провал, ради которого сообщение и существует.
    const { fn, calls } = fetchStub(jsonRes({ ok: true, result: {} }));
    const line = `<b>${'я'.repeat(200)}</b>`;
    const huge = Array.from({ length: 60 }, () => line).join('\n'); // ~12k символов

    await expect(sendTelegram(TARGET, huge, { fetchFn: fn })).resolves.toBe(true);

    const sent = JSON.parse(String(calls[0]!.init.body)).text as string;
    expect(sent.length).toBeLessThanOrEqual(4096);
    expect(sent).toContain('обрезано');
    // Разметка осталась парной: сколько открыли, столько и закрыли.
    expect((sent.match(/<b>/g) ?? []).length).toBe((sent.match(/<\/b>/g) ?? []).length);
  });

  it('одна строка длиннее лимита — теги снимаются, но сообщение уходит', async () => {
    const { fn, calls } = fetchStub(jsonRes({ ok: true, result: {} }));
    const oneLine = `<b>${'x'.repeat(9000)}</b>`;

    await expect(sendTelegram(TARGET, oneLine, { fetchFn: fn })).resolves.toBe(true);

    const sent = JSON.parse(String(calls[0]!.init.body)).text as string;
    expect(sent.length).toBeLessThanOrEqual(4096);
    expect(sent).not.toContain('<b>'); // незакрытого тега в сообщении нет
    expect(sent).toContain('обрезано');
  });

  it('текст в пределах лимита не трогается', async () => {
    const { fn, calls } = fetchStub(jsonRes({ ok: true, result: {} }));
    const text = '✅ <b>2026-08-06 20:00</b>\nКорт: Padel Court 3';

    await sendTelegram(TARGET, text, { fetchFn: fn });

    expect(JSON.parse(String(calls[0]!.init.body)).text).toBe(text);
  });

  it('токен не утекает: fetch кидает Error с URL (а значит и токеном) внутри — наружу и в консоль ничего не попадает', async () => {
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const fn = vi.fn(async (url: string | URL | Request) => {
      // Реалистичный кейс: сетевая ошибка со встроенным в message URL запроса.
      throw new Error(`fetch failed: ${String(url)}`);
    }) as unknown as typeof fetch;

    const result = await sendTelegram(TARGET, 'x', { fetchFn: fn }).catch((e: unknown) => e);

    expect(result).toBe(false); // не throw, не объект с деталями ошибки

    for (const spy of [consoleLog, consoleError, consoleWarn]) {
      for (const call of spy.mock.calls) {
        expect(call.join(' ')).not.toContain(TOKEN);
      }
    }
    // В идеале консоль вообще не трогается — sendTelegram сама ничего не логирует.
    expect(consoleLog).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
    expect(consoleWarn).not.toHaveBeenCalled();
  });
});

function baseReport(patch: Partial<DropReport> = {}): DropReport {
  return {
    ok: true,
    profileId: 'ilya',
    date: '2026-08-06',
    time: '20:00',
    timeline: [],
    ...patch,
  };
}

describe('formatDropReport', () => {
  it('успех: ✅, корт, бронь, скорость', () => {
    const msg = formatDropReport(
      baseReport({ ok: true, court: 'Padel Court 3', bookingId: 'b-1', token: 'super-secret-token', msFromSeenToBooked: 842 }),
      {},
    );

    expect(msg).toContain('✅');
    expect(msg).toContain('2026-08-06');
    expect(msg).toContain('20:00');
    expect(msg).toContain('Padel Court 3');
    expect(msg).toContain('b-1');
    expect(msg).toContain('842');
    expect(msg).not.toContain('super-secret-token');
  });

  it('никогда не включает token, даже если он есть в отчёте', () => {
    for (const ok of [true, false]) {
      const msg = formatDropReport(
        baseReport({ ok, token: 'MUST-NOT-LEAK-token-value', error: ok ? undefined : { kind: 'Timeout' } }),
        {},
      );
      expect(msg).not.toContain('MUST-NOT-LEAK-token-value');
    }
  });

  it('SlotTaken — ❌ и человекочитаемая причина', () => {
    const msg = formatDropReport(
      baseReport({ ok: false, error: { kind: 'SlotTaken', detail: 'слот появлялся, но POST отклонён (12 опросов)' } }),
      {},
    );
    expect(msg).toContain('❌');
    expect(msg).toContain('заняли раньше нас');
    expect(msg).toContain('12 опросов');
  });

  it('Timeout — ❌ и причина про дедлайн', () => {
    const msg = formatDropReport(baseReport({ ok: false, error: { kind: 'Timeout', detail: 'слот не появился' } }), {});
    expect(msg).toContain('❌');
    expect(msg).toContain('дедлайна');
  });

  it('AlreadyBooked — ℹ️, а не ❌: показывает существующую бронь, но без token', () => {
    // Идемпотентность сработала — слот забронирован. ❌ в 21:59 читается как
    // «вечер провален» и толкает оператора бронировать вручную → дубль.
    const msg = formatDropReport(
      baseReport({
        ok: false,
        court: 'Padel Court 2',
        bookingId: 'existing-booking-id',
        token: 'existing-secret-token',
        error: { kind: 'AlreadyBooked', detail: 'бронь existing-booking-id уже сохранена, state=confirmed' },
      }),
      {},
    );
    expect(msg).toContain('ℹ️');
    expect(msg).not.toContain('❌');
    expect(msg).toContain('existing-booking-id');
    expect(msg).toContain('уже была создана раньше');
    expect(msg).not.toContain('existing-secret-token');
  });

  it('stateWarning добавляется отдельной строкой с предупреждением', () => {
    const msg = formatDropReport(baseReport({ ok: true }), { stateWarning: 'state НЕ персистентен (Memory)' });
    expect(msg).toContain('⚠️');
    expect(msg).toContain('state НЕ персистентен (Memory)');
  });

  it('без stateWarning — предупреждения в сообщении нет', () => {
    const msg = formatDropReport(baseReport({ ok: true }), {});
    expect(msg).not.toContain('⚠️');
  });

  it('без token и без контактных полей ни при каких обстоятельствах', () => {
    const msg = formatDropReport(baseReport({ ok: true, token: 'x', bookingId: 'b-1' }), {});
    expect(msg).not.toMatch(/\bx\b/); // token НЕ просочился как отдельное слово
    expect(msg).not.toContain('email');
    expect(msg).not.toContain('phone');
    expect(msg).not.toContain('@');
  });

  it('очень длинный detail не вытесняет предупреждение о state', () => {
    // stateWarning — последняя строка отчёта: если detail её выдавит, оператор
    // не узнает, что идемпотентность в этом ране не работала.
    const msg = formatDropReport(
      baseReport({ ok: false, error: { kind: 'ApiChanged', detail: 'ы'.repeat(5000) } }),
      { stateWarning: 'state НЕ персистентен (Memory)' },
    );

    expect(msg.length).toBeLessThan(1000);
    expect(msg).toContain('state НЕ персистентен (Memory)');
    expect(msg).toContain('…');
  });

  it('экранирует HTML-спецсимволы из detail (parse_mode=HTML)', () => {
    const msg = formatDropReport(
      baseReport({ ok: false, error: { kind: 'ApiChanged', detail: '<script>&"тест"</script>' } }),
      {},
    );
    expect(msg).not.toContain('<script>');
    expect(msg).toContain('&lt;script&gt;&amp;"тест"&lt;/script&gt;');
  });
});
