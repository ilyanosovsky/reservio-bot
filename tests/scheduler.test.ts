import { describe, expect, it } from 'vitest';
import {
  TZ_OFFSET,
  dropDayOf,
  dropWatchWindow,
  slotEndISO,
  slotStartISO,
  targetDate,
  tbilisiDateOf,
  tbilisiStamp,
  weekdayOf,
} from '../src/core/scheduler.js';

/** Прогнать блок проверок в чужой локальной таймзоне процесса. */
function withTZ(tz: string, fn: () => void): void {
  const prev = process.env.TZ;
  process.env.TZ = tz;
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env.TZ;
    else process.env.TZ = prev;
  }
}

const FOREIGN_TZS = ['UTC', 'America/New_York', 'Asia/Tokyo', 'Pacific/Kiritimati', 'America/Anchorage'];

describe('окружение тестов', () => {
  it('локальная TZ процесса не совпадает с таймзоной клуба', () => {
    // Иначе тесты ниже не доказывали бы независимость от TZ хоста.
    expect(process.env.TZ).toBe('America/New_York');
    expect(new Date('2026-08-06T20:00:00+04:00').getHours()).not.toBe(20);
  });

  it('TZ_OFFSET — фиксированный +04:00', () => {
    expect(TZ_OFFSET).toBe('+04:00');
  });
});

describe('tbilisiDateOf', () => {
  it('23:30 UTC = 03:30 следующего дня в Тбилиси', () => {
    expect(tbilisiDateOf(new Date('2026-07-30T23:30:00Z'))).toBe('2026-07-31');
  });

  it('граница суток: 19:59:59Z ещё сегодня, 20:00:00Z уже завтра', () => {
    expect(tbilisiDateOf(new Date('2026-07-30T19:59:59.999Z'))).toBe('2026-07-30');
    expect(tbilisiDateOf(new Date('2026-07-30T20:00:00.000Z'))).toBe('2026-07-31');
  });

  it('граница месяца и года', () => {
    expect(tbilisiDateOf(new Date('2026-07-31T21:00:00Z'))).toBe('2026-08-01');
    expect(tbilisiDateOf(new Date('2026-12-31T20:00:00Z'))).toBe('2027-01-01');
    expect(tbilisiDateOf(new Date('2026-12-31T19:59:00Z'))).toBe('2026-12-31');
  });

  it('високосный февраль', () => {
    expect(tbilisiDateOf(new Date('2028-02-28T22:00:00Z'))).toBe('2028-02-29');
    expect(tbilisiDateOf(new Date('2028-02-29T22:00:00Z'))).toBe('2028-03-01');
  });

  it('результат не зависит от локальной TZ процесса', () => {
    const now = new Date('2026-07-30T23:30:00Z');
    for (const tz of FOREIGN_TZS) {
      withTZ(tz, () => {
        expect(tbilisiDateOf(now)).toBe('2026-07-31');
      });
    }
  });

  it('невалидный Date отвергается', () => {
    expect(() => tbilisiDateOf(new Date('нет такой даты'))).toThrow(RangeError);
  });
});

describe('targetDate', () => {
  it('T+7 внутри месяца', () => {
    expect(targetDate(new Date('2026-07-30T10:00:00Z'))).toBe('2026-08-06');
  });

  it('T+7 через границу месяца', () => {
    expect(targetDate(new Date('2026-08-28T10:00:00Z'))).toBe('2026-09-04');
  });

  it('T+7 через границу года', () => {
    expect(targetDate(new Date('2026-12-28T10:00:00Z'))).toBe('2027-01-04');
  });

  it('T+7 через високосный февраль', () => {
    expect(targetDate(new Date('2028-02-25T10:00:00Z'))).toBe('2028-03-03');
  });

  it('считает от даты Тбилиси, а не от UTC-даты', () => {
    // 30.07 23:30Z — в Тбилиси уже 31.07, значит цель 07.08, а не 06.08.
    expect(targetDate(new Date('2026-07-30T23:30:00Z'))).toBe('2026-08-07');
  });

  it('результат не зависит от локальной TZ процесса', () => {
    const now = new Date('2026-12-28T23:30:00Z');
    for (const tz of FOREIGN_TZS) {
      withTZ(tz, () => {
        expect(targetDate(now)).toBe('2027-01-05');
      });
    }
  });
});

describe('slotStartISO / slotEndISO', () => {
  it('формат с явным +04:00', () => {
    expect(slotStartISO('2026-08-06', '20:00')).toBe('2026-08-06T20:00:00+04:00');
    expect(slotStartISO('2026-08-06', '21:00')).toBe('2026-08-06T21:00:00+04:00');
  });

  it('конец слота = старт + 59 минут', () => {
    expect(slotEndISO('2026-08-06', '20:00')).toBe('2026-08-06T20:59:00+04:00');
    expect(slotEndISO('2026-08-06', '21:00')).toBe('2026-08-06T21:59:00+04:00');
    expect(slotEndISO('2026-08-06', '00:00')).toBe('2026-08-06T00:59:00+04:00');
  });

  it('последний час суток не уезжает на следующий день', () => {
    expect(slotStartISO('2026-08-06', '23:00')).toBe('2026-08-06T23:00:00+04:00');
    expect(slotEndISO('2026-08-06', '23:00')).toBe('2026-08-06T23:59:00+04:00');
  });

  it('старт и конец разделены ровно 59 минутами по абсолютному времени', () => {
    const start = new Date(slotStartISO('2026-12-31', '23:00'));
    const end = new Date(slotEndISO('2026-12-31', '23:00'));
    expect(end.getTime() - start.getTime()).toBe(59 * 60 * 1000);
  });

  it('строка парсится в правильный абсолютный момент', () => {
    expect(new Date(slotStartISO('2026-08-06', '20:00')).toISOString()).toBe('2026-08-06T16:00:00.000Z');
  });

  it('результат не зависит от локальной TZ процесса', () => {
    for (const tz of FOREIGN_TZS) {
      withTZ(tz, () => {
        expect(slotStartISO('2026-08-06', '20:00')).toBe('2026-08-06T20:00:00+04:00');
        expect(slotEndISO('2026-08-06', '23:00')).toBe('2026-08-06T23:59:00+04:00');
      });
    }
  });

  it('отвергает мусор во входных данных', () => {
    expect(() => slotStartISO('06.08.2026', '20:00')).toThrow(RangeError);
    expect(() => slotStartISO('2026-02-30', '20:00')).toThrow(RangeError);
    expect(() => slotStartISO('2026-13-01', '20:00')).toThrow(RangeError);
    expect(() => slotStartISO('2026-08-06', '24:00')).toThrow(RangeError);
    expect(() => slotStartISO('2026-08-06', '20:60')).toThrow(RangeError);
    expect(() => slotStartISO('2026-08-06', '8:00')).toThrow(RangeError);
    expect(() => slotEndISO('2026-08-06', '')).toThrow(RangeError);
  });
});

describe('dropDayOf', () => {
  it('день наблюдения T = целевая дата минус 7 суток', () => {
    expect(dropDayOf('2026-08-06')).toBe('2026-07-30');
  });

  it('обратна targetDate на границах месяца и года', () => {
    expect(dropDayOf('2026-09-04')).toBe('2026-08-28');
    expect(dropDayOf('2027-01-04')).toBe('2026-12-28');
    expect(dropDayOf('2028-03-03')).toBe('2028-02-25'); // високосный
    for (const now of ['2026-07-30T10:00:00Z', '2026-12-28T23:30:00Z', '2028-02-25T10:00:00Z']) {
      const d = new Date(now);
      expect(dropDayOf(targetDate(d))).toBe(tbilisiDateOf(d));
    }
  });

  it('отвергает мусор', () => {
    expect(() => dropDayOf('06.08.2026')).toThrow(RangeError);
  });
});

describe('weekdayOf', () => {
  it('0 = воскресенье … 6 = суббота', () => {
    expect(weekdayOf('2026-08-06')).toBe(4); // чт
    expect(weekdayOf('2026-08-09')).toBe(0); // вс
    expect(weekdayOf('2026-08-08')).toBe(6); // сб
  });

  it('не зависит от локальной TZ процесса (в America/New_York дата не «отъезжает» на день назад)', () => {
    for (const tz of FOREIGN_TZS) {
      withTZ(tz, () => {
        expect(weekdayOf('2026-08-06')).toBe(4);
      });
    }
  });
});

describe('tbilisiStamp', () => {
  it('метка времени всегда с явным +04:00', () => {
    expect(tbilisiStamp(new Date('2026-07-30T16:58:30.412Z'))).toBe('2026-07-30T20:58:30.412+04:00');
  });

  it('не зависит от локальной TZ процесса', () => {
    const at = new Date('2026-12-31T20:30:00.000Z');
    for (const tz of FOREIGN_TZS) {
      withTZ(tz, () => {
        expect(tbilisiStamp(at)).toBe('2027-01-01T00:30:00.000+04:00');
      });
    }
  });

  it('невалидный Date отвергается', () => {
    expect(() => tbilisiStamp(new Date('нет такой даты'))).toThrow(RangeError);
  });
});

describe('dropWatchWindow', () => {
  // Модель дропа: слот открывается, когда его КОНЕЦ входит в горизонт 7×24 ч,
  // т.е. в H:59:00 дня T — в ТОТ ЖЕ час, что и сам слот (docs/PROTOCOL.md,
  // живой замер 30.07.2026: слот 06.08 10:00 отсутствовал в 10:58:49.4
  // и появился в 10:58:59.9). Регрессия на «(H-1):58:30» — бот не бронирует
  // никогда: поллит на час раньше реального дропа.
  it('слот 20:00 дня T+7 — окно с 20:58:30 дня T (тот же час, не H-1)', () => {
    const { start, deadline } = dropWatchWindow('2026-07-30', '20:00');
    expect(start.toISOString()).toBe(new Date('2026-07-30T20:58:30+04:00').toISOString());
    expect(start.toISOString()).toBe('2026-07-30T16:58:30.000Z');
    expect(deadline.toISOString()).toBe('2026-07-30T17:03:30.000Z');
    expect(deadline.getTime() - start.getTime()).toBe(5 * 60 * 1000);
  });

  it('слот 21:00 — окно с 21:58:30', () => {
    const { start } = dropWatchWindow('2026-07-30', '21:00');
    expect(start.toISOString()).toBe(new Date('2026-07-30T21:58:30+04:00').toISOString());
  });

  it('окно накрывает зафиксированный живьём дроп слота 10:00 (30.07 в 10:58:59.9)', () => {
    const { start, deadline } = dropWatchWindow('2026-07-30', '10:00');
    const observed = new Date('2026-07-30T10:58:59.900+04:00');
    expect(start.getTime()).toBeLessThan(observed.getTime());
    expect(deadline.getTime()).toBeGreaterThan(observed.getTime());
    expect(start.toISOString()).toBe(new Date('2026-07-30T10:58:30+04:00').toISOString());
  });

  it('слот 00:00 — окно остаётся в дне T (00:58:30), сутки не съезжают', () => {
    const { start } = dropWatchWindow('2026-07-30', '00:00');
    expect(start.toISOString()).toBe(new Date('2026-07-30T00:58:30+04:00').toISOString());
  });

  it('окно 00:00 на границе года', () => {
    const { start } = dropWatchWindow('2027-01-01', '00:00');
    expect(start.toISOString()).toBe(new Date('2027-01-01T00:58:30+04:00').toISOString());
  });

  it('старт окна раньше КОНЦА слота T+7 ровно на 7 суток и 30 секунд', () => {
    for (const time of ['00:00', '10:00', '20:00', '23:00']) {
      const { start } = dropWatchWindow('2026-07-30', time);
      const slotEnd = new Date(slotEndISO('2026-08-06', time));
      expect(slotEnd.getTime() - start.getTime()).toBe(7 * 24 * 60 * 60 * 1000 + 30 * 1000);
    }
  });

  it('результат не зависит от локальной TZ процесса', () => {
    for (const tz of FOREIGN_TZS) {
      withTZ(tz, () => {
        const { start, deadline } = dropWatchWindow('2026-07-30', '20:00');
        expect(start.toISOString()).toBe('2026-07-30T16:58:30.000Z');
        expect(deadline.toISOString()).toBe('2026-07-30T17:03:30.000Z');
      });
    }
  });

  it('отвергает мусор во входных данных', () => {
    expect(() => dropWatchWindow('30-07-2026', '20:00')).toThrow(RangeError);
    expect(() => dropWatchWindow('2026-07-30', '20')).toThrow(RangeError);
  });
});
