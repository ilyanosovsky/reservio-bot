import { describe, expect, it } from 'vitest';
import type { StoredBooking } from '../src/core/state.js';
import type { ScheduleRuleRow } from '../src/core/repos.js';
import type { Slot } from '../src/reservio/types.js';
import {
  CANCEL_DEADLINE_MS,
  PADEL_COURTS,
  activeBookings,
  bookingButtonLabel,
  cancelDeadlinePassed,
  courtByIndex,
  courtIndexOf,
  escapeHtml,
  formatBookingsList,
  formatDateShort,
  formatDays,
  formatProfilesList,
  formatRulesList,
  formatSkipsList,
  formatSlotsList,
  freeTimes,
  humanizeCancelError,
  maskEmail,
  maskTail,
  ruleButtonLabel,
  skipButtonLabel,
  slotTimeLabel,
  upcomingDates,
} from '../src/bot/format.js';

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
  it('в меню ровно четыре падел-корта', () => {
    expect(PADEL_COURTS.map((c) => c.name)).toEqual([
      'Padel Court 1',
      'Padel Court 2',
      'Padel Court 3',
      'Padel Court 4',
    ]);
  });

  it('индекс из callback_data превращается в корт, мусор — в null', () => {
    expect(courtByIndex(2)?.name).toBe('Padel Court 3');
    expect(courtByIndex(9)).toBeNull();
    expect(courtByIndex(-1)).toBeNull();
  });

  it('обратное преобразование терпит регистр', () => {
    expect(courtIndexOf('padel court 3')).toBe(2);
    expect(courtIndexOf('Park Court 1')).toBe(-1);
  });
});

describe('escapeHtml', () => {
  it('экранирует ровно три спецсимвола Telegram', () => {
    expect(escapeHtml('<b>a & b</b>')).toBe('&lt;b&gt;a &amp; b&lt;/b&gt;');
  });
});
