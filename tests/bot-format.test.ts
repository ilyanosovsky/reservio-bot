import { describe, expect, it, vi } from 'vitest';
import { GrammyError } from 'grammy';
import type { BotContext } from '../src/bot/context.js';
import type { StoredBooking } from '../src/core/state.js';
import type { ScheduleRuleRow } from '../src/core/repos.js';
import type { Slot } from '../src/reservio/types.js';
import {
  CANCEL_DEADLINE_MS,
  BOOKABLE_COURTS,
  activeBookings,
  bookingButtonLabel,
  cancelDeadlinePassed,
  courtByIndex,
  courtIndexOf,
  escapeHtml,
  formatBookingsList,
  formatBookCourtsStep,
  formatBookDatesStep,
  formatBookNoTimes,
  formatBookTimesStep,
  formatDateShort,
  formatDays,
  formatProfilesList,
  formatRulesList,
  formatSkipsList,
  formatSlotsCourtsStep,
  formatSlotsDatesStep,
  formatSlotsList,
  freeTimes,
  humanizeCancelError,
  maskEmail,
  maskTail,
  ruleButtonLabel,
  skipButtonLabel,
  slotTimeLabel,
  upcomingDates,
  wizardCrumbs,
} from '../src/bot/format.js';
import {
  BACK_LABEL,
  backKeyboard,
  confirmKeyboard,
  courtKeyboard,
  dateKeyboard,
  edit,
  isNotModifiedError,
  timeKeyboard,
} from '../src/bot/ui.js';

// vitest.config.ts фиксирует TZ=America/New_York — любые расчёты ниже обязаны
// давать календарь Тбилиси (+04:00), а не хоста.

function booking(over: Partial<StoredBooking> = {}): StoredBooking {
  return {
    profileId: 'ilya',
    date: '2026-08-06',
    time: '20:00',
    court: 'Padel Court 3',
    bookingId: 'b-1',
    token: 't-1',
    state: 'confirmed',
    createdAt: '2026-07-30T20:59:01+04:00',
    ...over,
  };
}

const slot = (start: string, end: string): Slot => ({ start, end });

describe('formatDateShort', () => {
  it('даёт день.месяц и день недели в зоне клуба', () => {
    expect(formatDateShort('2026-08-06')).toBe('06.08 (чт)');
    expect(formatDateShort('2026-08-02')).toBe('02.08 (вс)');
    expect(formatDateShort('2026-07-31')).toBe('31.07 (пт)');
  });

  it('кривую дату отдаёт как есть, не выдумывая день недели', () => {
    expect(formatDateShort('позавчера')).toBe('позавчера');
    expect(formatDateShort('2026-02-30')).toBe('2026-02-30');
  });
});

describe('upcomingDates', () => {
  it('считает даты по календарю Тбилиси, а не хоста', () => {
    // 23:30 UTC = 03:30 следующего дня в Тбилиси: наивный расчёт дал бы 05.08
    const now = new Date('2026-08-05T23:30:00Z');
    expect(upcomingDates(now, 3)).toEqual(['2026-08-06', '2026-08-07', '2026-08-08']);
  });

  it('переносит через границу месяца', () => {
    expect(upcomingDates(new Date('2026-07-30T12:00:00Z'), 4)).toEqual([
      '2026-07-30',
      '2026-07-31',
      '2026-08-01',
      '2026-08-02',
    ]);
  });

  it('offsetDays сдвигает первую дату (меню скипов начинается с T+7)', () => {
    expect(upcomingDates(new Date('2026-07-30T12:00:00Z'), 2, 7)).toEqual(['2026-08-06', '2026-08-07']);
  });
});

describe('slotTimeLabel / freeTimes', () => {
  it('вытаскивает HH:MM из ISO с оффсетом', () => {
    expect(slotTimeLabel('2026-08-06T20:00:00+04:00')).toBe('20:00');
  });

  it('чужой формат не коверкает', () => {
    expect(slotTimeLabel('нет времени')).toBe('нет времени');
  });

  it('сортирует и дедуплицирует времена (порядок API не гарантирован)', () => {
    const slots = [
      slot('2026-08-06T21:00:00+04:00', '2026-08-06T21:59:00+04:00'),
      slot('2026-08-06T00:00:00+04:00', '2026-08-06T00:59:00+04:00'),
      slot('2026-08-06T09:00:00+04:00', '2026-08-06T09:59:00+04:00'),
      slot('2026-08-06T09:00:00+04:00', '2026-08-06T09:59:00+04:00'),
    ];
    expect(freeTimes(slots)).toEqual(['00:00', '09:00', '21:00']);
  });

  it('игнорирует слоты без строкового start', () => {
    const broken = [{ end: 'x' } as unknown as Slot, slot('2026-08-06T10:00:00+04:00', 'x')];
    expect(freeTimes(broken)).toEqual(['10:00']);
  });
});

describe('activeBookings', () => {
  const now = new Date('2026-08-06T16:30:00Z'); // 20:30 в Тбилиси

  it('отбрасывает отменённые', () => {
    const rows = activeBookings([booking(), booking({ bookingId: 'b-2', time: '21:00', state: 'canceled' })], now);
    expect(rows.map((b) => b.bookingId)).toEqual(['b-1']);
  });

  it('идущий прямо сейчас слот остаётся в списке (граница — конец слота)', () => {
    // 20:00–20:59, сейчас 20:30
    expect(activeBookings([booking()], now)).toHaveLength(1);
  });

  it('закончившийся слот уходит', () => {
    const later = new Date('2026-08-06T17:30:00Z'); // 21:30 в Тбилиси
    expect(activeBookings([booking()], later)).toHaveLength(0);
  });

  it('сортирует по дате и времени', () => {
    const rows = activeBookings(
      [
        booking({ bookingId: 'c', date: '2026-08-07', time: '19:00' }),
        booking({ bookingId: 'b', time: '21:00' }),
        booking({ bookingId: 'a' }),
      ],
      now,
    );
    expect(rows.map((b) => b.bookingId)).toEqual(['a', 'b', 'c']);
  });

  it('запись с неразбираемой датой не прячет (иначе бронь исчезнет из интерфейса)', () => {
    const rows = activeBookings([booking({ bookingId: 'x', date: 'позавчера' })], now);
    expect(rows.map((b) => b.bookingId)).toEqual(['x']);
  });
});

describe('formatBookingsList', () => {
  const now = new Date('2026-08-01T12:00:00Z');

  it('пустой список объясняет, что делать', () => {
    const text = formatBookingsList([], now);
    expect(text).toContain('Активных броней нет');
    expect(text).toContain('📆 Бронировать');
  });

  it('печатает дату, время и корт', () => {
    const text = formatBookingsList([booking(), booking({ bookingId: 'b-2', time: '21:00' })], now);
    expect(text).toContain('06.08 (чт) 20:00 — Padel Court 3');
    expect(text).toContain('06.08 (чт) 21:00 — Padel Court 3');
  });

  it('не выводит booking_id и token', () => {
    const text = formatBookingsList([booking({ token: 'secret-token', bookingId: 'secret-id' })], now);
    expect(text).not.toContain('secret-token');
    expect(text).not.toContain('secret-id');
  });

  it('экранирует HTML в имени корта', () => {
    const text = formatBookingsList([booking({ court: 'Court <b>3</b>' })], now);
    expect(text).toContain('Court &lt;b&gt;3&lt;/b&gt;');
  });
});

describe('bookingButtonLabel / formatSlotsList', () => {
  it('подпись кнопки короткая и однозначная', () => {
    expect(bookingButtonLabel(booking())).toBe('06.08 (чт) 20:00 · Padel Court 3');
  });

  it('список слотов показывает количество и времена', () => {
    const text = formatSlotsList('Padel Court 3', '2026-08-06', [
      slot('2026-08-06T20:00:00+04:00', '2026-08-06T20:59:00+04:00'),
      slot('2026-08-06T08:00:00+04:00', '2026-08-06T08:59:00+04:00'),
    ]);
    expect(text).toContain('Padel Court 3');
    expect(text).toContain('06.08 (чт)');
    expect(text).toContain('Свободно (2): 08:00, 20:00');
  });

  it('пустая выдача — честное «нет слотов», а не пустая строка', () => {
    expect(formatSlotsList('Padel Court 3', '2026-08-06', [])).toContain('Свободных слотов нет');
  });
});

describe('cancelDeadlinePassed', () => {
  // Дедлайн отмены — час до начала слота (docs/PROTOCOL.md).
  it('за полтора часа до слота отменять можно', () => {
    expect(cancelDeadlinePassed('2026-08-06', '20:00', new Date('2026-08-06T14:30:00Z'))).toBe(false);
  });

  it('ровно за час — ещё можно', () => {
    const start = new Date('2026-08-06T16:00:00Z').getTime(); // 20:00 +04:00
    expect(cancelDeadlinePassed('2026-08-06', '20:00', new Date(start - CANCEL_DEADLINE_MS))).toBe(false);
  });

  it('за 59 минут — уже поздно', () => {
    const start = new Date('2026-08-06T16:00:00Z').getTime();
    expect(cancelDeadlinePassed('2026-08-06', '20:00', new Date(start - CANCEL_DEADLINE_MS + 60_000))).toBe(true);
  });

  it('неразбираемую дату дедлайном не считает — решать API', () => {
    expect(cancelDeadlinePassed('когда-нибудь', '20:00', new Date())).toBe(false);
  });
});

describe('humanizeCancelError', () => {
  it('notCanceled объясняет дедлайн отмены', () => {
    expect(humanizeCancelError({ code: 'notCanceled' })).toContain('дедлайн отмены');
  });

  it('403/404 — про токен и уже отменённую бронь', () => {
    expect(humanizeCancelError({ status: 403 })).toContain('токен');
    expect(humanizeCancelError({ status: 404 })).toContain('токен');
  });

  it('сеть — предлагает повтор и не врёт про отмену', () => {
    expect(humanizeCancelError({ code: 'timeout' })).toContain('осталась активной');
  });

  it('никогда не тащит сырой message наружу', () => {
    const text = humanizeCancelError({ message: 'cancelBooking: HTTP 500 token=abcdef', status: 500 });
    expect(text).not.toContain('token=');
    expect(text).not.toContain('HTTP 500');
  });
});

describe('formatDays / правила', () => {
  it('null = каждый день', () => {
    expect(formatDays(null)).toBe('каждый день');
  });

  it('сортирует и переводит дни', () => {
    expect(formatDays([5, 1, 3])).toBe('пн, ср, пт');
    expect(formatDays([0])).toBe('вс');
  });

  it('пустой список — явное «ни одного дня», а не «каждый»', () => {
    expect(formatDays([])).toBe('ни одного дня');
  });

  const rule = (over: Partial<ScheduleRuleRow> = {}): ScheduleRuleRow => ({
    id: 'r-1',
    profileId: 'ilya',
    times: ['20:00', '21:00'],
    courts: ['Padel Court 3', 'Padel Court 2'],
    daysOfWeek: null,
    enabled: true,
    ...over,
  });

  it('подпись кнопки показывает состояние правила', () => {
    expect(ruleButtonLabel(rule())).toBe('✅ 20:00, 21:00');
    expect(ruleButtonLabel(rule({ enabled: false }))).toBe('⛔ 20:00, 21:00');
  });

  it('список правил печатает времена, корты и дни', () => {
    const text = formatRulesList([rule({ daysOfWeek: [2, 4] })]);
    expect(text).toContain('20:00, 21:00');
    expect(text).toContain('Padel Court 3 → Padel Court 2');
    expect(text).toContain('вт, чт');
  });

  it('пустое расписание отправляет к админу', () => {
    expect(formatRulesList([])).toContain('/add_rule');
  });
});

describe('скипы', () => {
  it('отметка кнопки различает пропуск и игру', () => {
    expect(skipButtonLabel('2026-08-06', true)).toBe('⏭ 06.08 (чт)');
    expect(skipButtonLabel('2026-08-06', false)).toBe('▶️ 06.08 (чт)');
  });

  it('перечисляет только пропущенные даты', () => {
    const text = formatSkipsList(['2026-08-06', '2026-08-07'], new Set(['2026-08-07']));
    expect(text).toContain('Пропускаем: 07.08 (пт)');
    expect(text).not.toContain('Пропускаем: 06.08');
  });

  it('без скипов говорит об этом прямо', () => {
    expect(formatSkipsList(['2026-08-06'], new Set())).toContain('Сейчас ничего не пропускаем');
  });
});

describe('маскирование персональных данных', () => {
  it('email показывает только первую букву', () => {
    expect(maskEmail('ilya@example.com')).toBe('i***@example.com');
  });

  it('мусор вместо email не притворяется адресом', () => {
    expect(maskEmail('не-почта')).toBe('—');
    expect(maskEmail('@example.com')).toBe('—');
  });

  it('хвост показывает последние символы', () => {
    expect(maskTail('123456789')).toBe('…6789');
    expect(maskTail('12')).toBe('…');
    expect(maskTail('   ')).toBe('—');
  });

  it('список профилей не печатает email и chat_id целиком', () => {
    const text = formatProfilesList([
      { id: 'ilya', label: 'Илья', name: 'Ilya X', email: 'ilya@example.com', phone: '+995555111222', telegramChatId: '123456789', isAdmin: true },
      { id: 'anna', label: 'Аня', name: 'Anna Y', email: 'anna@example.com', phone: '+995555333444', telegramChatId: null, isAdmin: false },
    ]);
    expect(text).not.toContain('ilya@example.com');
    expect(text).not.toContain('123456789');
    expect(text).not.toContain('+995555111222');
    expect(text).toContain('i***@example.com');
    expect(text).toContain('…6789');
    expect(text).toContain('админ');
    expect(text).toContain('chat не привязан');
  });
});

describe('корты интерфейса', () => {
  it('в меню все шесть кортов клуба, падел первыми (индексы 0–3 стабильны)', () => {
    expect(BOOKABLE_COURTS.map((c) => c.name)).toEqual([
      'Padel Court 1',
      'Padel Court 2',
      'Padel Court 3',
      'Padel Court 4',
      'Park Court 1',
      'Park Court 2',
    ]);
  });

  it('индекс из callback_data превращается в корт, мусор — в null', () => {
    expect(courtByIndex(2)?.name).toBe('Padel Court 3');
    expect(courtByIndex(9)).toBeNull();
    expect(courtByIndex(-1)).toBeNull();
  });

  it('обратное преобразование терпит регистр', () => {
    expect(courtIndexOf('padel court 3')).toBe(2);
    expect(courtIndexOf('park court 1')).toBe(4);
    expect(courtIndexOf('Court X')).toBe(-1);
  });
});

describe('escapeHtml', () => {
  it('экранирует ровно три спецсимвола Telegram', () => {
    expect(escapeHtml('<b>a & b</b>')).toBe('&lt;b&gt;a &amp; b&lt;/b&gt;');
  });
});

describe('хлебные крошки мастеров', () => {
  // Смысл крошек: на любом шаге видно ВЕСЬ накопленный контекст. Серверного
  // состояния мастера нет, так что текст сообщения — единственное место, где
  // человек может прочитать, что он уже выбрал.
  it('шаг даты называет мастер и просит дату', () => {
    expect(formatBookDatesStep()).toBe('📆 <b>Бронь</b> · выбери дату');
    expect(formatSlotsDatesStep()).toBe('🔍 <b>Слоты</b> · выбери дату');
  });

  it('шаг корта показывает выбранную дату', () => {
    expect(formatBookCourtsStep('2026-08-06')).toBe('📆 <b>Бронь</b> · 06.08 (чт) · выбери корт');
    expect(formatSlotsCourtsStep('2026-08-06')).toBe('🔍 <b>Слоты</b> · 06.08 (чт) · выбери корт');
  });

  it('шаг времени показывает дату и корт', () => {
    expect(formatBookTimesStep('2026-08-06', 'Park Court 1')).toBe(
      '📆 <b>Бронь</b> · 06.08 (чт) · Park Court 1 · выбери время',
    );
  });

  it('дата в крошках всегда через formatDateShort, а не сырым ISO', () => {
    expect(formatBookCourtsStep('2026-08-06')).not.toContain('2026-08-06');
    expect(formatSlotsCourtsStep('2026-08-02')).toContain('02.08 (вс)');
  });

  it('тупик «нет слотов» сохраняет контекст и зовёт назад', () => {
    const text = formatBookNoTimes('2026-08-06', 'Padel Court 3');
    expect(text).toContain('06.08 (чт)');
    expect(text).toContain('Padel Court 3');
    expect(text).toContain('свободных слотов нет');
    expect(text).toContain('назад');
  });

  it('экранирует имя корта, но не ломает разметку заголовка', () => {
    const text = wizardCrumbs('book', { date: '2026-08-06', court: 'Court <b>3</b>' }, 'выбери время');
    expect(text).toContain('Court &lt;b&gt;3&lt;/b&gt;');
    expect(text.startsWith('📆 <b>Бронь</b>')).toBe(true);
  });

  it('хвост (prompt) экранируется наравне с датой и кортом', () => {
    // Хвост когда-нибудь станет динамическим (причина отказа Reservio). Сырой
    // '<' отдал бы Telegram невалидный HTML: правка упала бы на разборе
    // разметки, а фолбэк отправил бы ТОТ ЖЕ битый текст — тап без реакции.
    const text = wizardCrumbs('slots', { date: '2026-08-06' }, 'нет слотов: <api> & retry');
    expect(text).toContain('нет слотов: &lt;api&gt; &amp; retry');
    expect(text).not.toContain('<api>');
    expect(text.startsWith('🔍 <b>Слоты</b>')).toBe(true);
  });

  it('обычные подсказки шагов от экранирования не меняются', () => {
    expect(formatBookDatesStep()).toBe('📆 <b>Бронь</b> · выбери дату');
    expect(formatBookTimesStep('2026-08-06', 'Padel Court 3')).toBe(
      '📆 <b>Бронь</b> · 06.08 (чт) · Padel Court 3 · выбери время',
    );
  });
});

describe('клавиатуры мастера: кнопка «Назад»', () => {
  const rowsOf = (kb: { inline_keyboard: { text: string; callback_data?: string }[][] }) => kb.inline_keyboard;
  const lastRow = (kb: { inline_keyboard: { text: string; callback_data?: string }[][] }) =>
    kb.inline_keyboard[kb.inline_keyboard.length - 1]!;

  it('первый шаг (даты) — без «Назад»: возвращаться некуда', () => {
    const kb = dateKeyboard(['2026-08-06', '2026-08-07', '2026-08-08'], (d) => `bk~d~${d}`);
    expect(rowsOf(kb).flat().map((b) => b.text)).not.toContain(BACK_LABEL);
  });

  it('пустых рядов в клавиатуре не остаётся', () => {
    const kbs = [
      dateKeyboard(['2026-08-06', '2026-08-07'], (d) => `bk~d~${d}`),
      courtKeyboard((i) => `bk~c~2026-08-06~${i}`, 'bk~b'),
      timeKeyboard(['20:00', '21:00', '22:00'], (t) => `bk~t~2026-08-06~2~${t}`, 'bk~d~2026-08-06'),
    ];
    for (const kb of kbs) {
      expect(rowsOf(kb).every((row) => row.length > 0)).toBe(true);
    }
  });

  it('«Назад» стоит ОТДЕЛЬНЫМ последним рядом, чтобы не ловить случайные тапы', () => {
    const courts = courtKeyboard((i) => `bk~c~2026-08-06~${i}`, 'bk~b');
    expect(lastRow(courts)).toEqual([{ text: BACK_LABEL, callback_data: 'bk~b' }]);

    const times = timeKeyboard(['20:00', '21:00'], (t) => `bk~t~2026-08-06~2~${t}`, 'bk~d~2026-08-06');
    expect(lastRow(times)).toEqual([{ text: BACK_LABEL, callback_data: 'bk~d~2026-08-06' }]);
  });

  it('подтверждение брони: «Назад» ниже «Бронировать» и «Отмена»', () => {
    const kb = confirmKeyboard('bk~y~2026-08-06~2~21:00', 'close', '✅ Бронировать', 'bk~c~2026-08-06~2');
    expect(rowsOf(kb)).toHaveLength(2);
    expect(rowsOf(kb)[0]!.map((b) => b.text)).toEqual(['✅ Бронировать', '↩️ Отмена']);
    expect(lastRow(kb)).toEqual([{ text: BACK_LABEL, callback_data: 'bk~c~2026-08-06~2' }]);
  });

  it('без backData клавиатуры остаются прежними (отмена брони «Назад» не показывает)', () => {
    expect(rowsOf(confirmKeyboard('cx~y~b-1', 'close'))).toHaveLength(1);
    expect(rowsOf(courtKeyboard((i) => `sl~c~2026-08-06~${i}`)).flat().map((b) => b.text)).not.toContain(BACK_LABEL);
  });

  it('экран-результат («Слоты») — одна кнопка возврата к выбору корта', () => {
    expect(rowsOf(backKeyboard('sl~d~2026-08-06'))).toEqual([
      [{ text: BACK_LABEL, callback_data: 'sl~d~2026-08-06' }],
    ]);
  });
});

describe('isNotModifiedError', () => {
  // Двойной тап по «Назад» — обычное дело на мобильной сети. Telegram отвечает
  // 400, но экран уже такой, какой просили: пользователю сообщать не о чем.
  it('узнаёт ошибку Telegram и в description, и в message', () => {
    expect(isNotModifiedError({ description: 'Bad Request: message is not modified' })).toBe(true);
    expect(isNotModifiedError(new Error('400: Bad Request: message is not modified'))).toBe(true);
  });

  it('прочие ошибки не глотает — их человек обязан увидеть', () => {
    expect(isNotModifiedError({ description: 'Bad Request: message to edit not found' })).toBe(false);
    expect(isNotModifiedError(new Error('network error'))).toBe(false);
    expect(isNotModifiedError(null)).toBe(false);
    expect(isNotModifiedError('message is not modified')).toBe(false);
  });
});

describe('edit(): что делает обёртка с ошибкой правки', () => {
  // Проверять один предикат мало: требование «не плодить дубли экрана» держится
  // на том, что edit() им ПОЛЬЗУЕТСЯ до фолбэка ctx.reply. Тесты ниже фиксируют
  // именно это — переставленный catch-блок обязан их уронить.

  function grammyError(description: string): GrammyError {
    return new GrammyError(
      "Call to 'editMessageText' failed!",
      { ok: false, error_code: 400, description },
      'editMessageText',
      {},
    );
  }

  function ctxThrowing(err: unknown): {
    ctx: BotContext;
    editMessageText: ReturnType<typeof vi.fn>;
    reply: ReturnType<typeof vi.fn>;
  } {
    const editMessageText = vi.fn(async () => {
      throw err;
    });
    const reply = vi.fn(async () => ({}));
    return { ctx: { editMessageText, reply } as unknown as BotContext, editMessageText, reply };
  }

  it('«message is not modified» (двойной тап по «Назад») — НИ одного исходящего сообщения', async () => {
    const { ctx, editMessageText, reply } = ctxThrowing(
      grammyError('Bad Request: message is not modified: specified new message content and reply markup are exactly the same'),
    );

    await edit(ctx, '📆 <b>Бронь</b> · выбери дату');

    expect(editMessageText).toHaveBeenCalledTimes(1);
    expect(reply).not.toHaveBeenCalled();
  });

  it('прочая ошибка правки — экран всё равно показан новым сообщением', async () => {
    const { ctx, reply } = ctxThrowing(grammyError('Bad Request: message to edit not found'));

    await edit(ctx, '📆 <b>Бронь</b> · выбери дату');

    expect(reply).toHaveBeenCalledTimes(1);
    expect(reply.mock.calls[0]?.[0]).toBe('📆 <b>Бронь</b> · выбери дату');
  });

  it('чат недоступен (упал и фолбэк) — исключение наружу не летит', async () => {
    const { ctx, reply } = ctxThrowing(new Error('network error'));
    reply.mockRejectedValue(new Error('Forbidden: bot was blocked by the user'));

    await expect(edit(ctx, 'текст')).resolves.toBeUndefined();
    expect(reply).toHaveBeenCalledTimes(1);
  });
});
