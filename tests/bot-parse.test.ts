import { describe, expect, it } from 'vitest';
import {
  ADD_PROFILE_USAGE,
  ADD_RULE_USAGE,
  CALLBACK_DATA_MAX_BYTES,
  CB_CLOSE,
  CB_NOOP,
  cbBookConfirm,
  cbBookCourt,
  cbBookDate,
  cbBookTime,
  cbCancelConfirm,
  cbCancelPick,
  cbRuleToggle,
  cbSkip,
  cbSlotsCourt,
  cbSlotsDate,
  parseAddProfile,
  parseAddRule,
  parseCallbackData,
} from '../src/bot/parse.js';

const UUID = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';

function ok<T>(res: { ok: true; value: T } | { ok: false; error: string }): T {
  if (!res.ok) throw new Error(`ожидался успех, получено: ${res.error}`);
  return res.value;
}

function err(res: { ok: true; value: unknown } | { ok: false; error: string }): string {
  if (res.ok) throw new Error('ожидалась ошибка, получен успех');
  return res.error;
}

describe('parseAddProfile', () => {
  it('разбирает полный набор полей', () => {
    const v = ok(parseAddProfile('anna;Аня;Anna Ivanova;anna@example.com;+995555123456;123456789'));
    expect(v).toEqual({
      id: 'anna',
      label: 'Аня',
      name: 'Anna Ivanova',
      email: 'anna@example.com',
      phone: '+995555123456',
      telegramChatId: '123456789',
    });
  });

  it('chat_id необязателен: и пропущенное поле, и пустое дают null', () => {
    expect(ok(parseAddProfile('anna;Аня;Anna;anna@example.com;+995555123456')).telegramChatId).toBeNull();
    expect(ok(parseAddProfile('anna;Аня;Anna;anna@example.com;+995555123456;')).telegramChatId).toBeNull();
  });

  it('нормализует id к нижнему регистру и терпит пробелы вокруг полей', () => {
    const v = ok(parseAddProfile('  ANNA ; Аня ; Anna ; anna@example.com ; +995 555 123-456 ; 123456789 '));
    expect(v.id).toBe('anna');
    expect(v.phone).toBe('+995555123456');
  });

  it('принимает отрицательный chat_id (группы)', () => {
    expect(ok(parseAddProfile('team;Команда;Team;team@example.com;+995555123456;-1001234567')).telegramChatId).toBe(
      '-1001234567',
    );
  });

  it('пустой ввод возвращает подсказку формата', () => {
    expect(err(parseAddProfile('   '))).toContain(ADD_PROFILE_USAGE);
  });

  it('ругается на число полей', () => {
    expect(err(parseAddProfile('anna;Аня;Anna'))).toContain('5–6 полей');
    expect(err(parseAddProfile('a;b;c;d@e.com;+995555123456;1;лишнее'))).toContain('5–6 полей');
  });

  it('валидирует id профиля', () => {
    expect(err(parseAddProfile('a;Аня;Anna;a@e.com;+995555123456'))).toContain('id профиля');
    expect(err(parseAddProfile('ан на;Аня;Anna;a@e.com;+995555123456'))).toContain('id профиля');
    expect(err(parseAddProfile('-anna;Аня;Anna;a@e.com;+995555123456'))).toContain('id профиля');
  });

  it('валидирует email и НЕ печатает его значение (персональные данные)', () => {
    const message = err(parseAddProfile('anna;Аня;Anna;anna_at_example.com;+995555123456'));
    expect(message).toContain('email');
    expect(message).not.toContain('anna_at_example.com');
  });

  it('валидирует телефон и не печатает его значение', () => {
    const message = err(parseAddProfile('anna;Аня;Anna;anna@example.com;8005553535'));
    expect(message).toContain('+995');
    expect(message).not.toContain('8005553535');
  });

  it('валидирует chat_id', () => {
    expect(err(parseAddProfile('anna;Аня;Anna;anna@example.com;+995555123456;не-число'))).toContain('chat_id');
  });

  it('не пропускает пустые label/name', () => {
    expect(err(parseAddProfile('anna;;Anna;anna@example.com;+995555123456'))).toContain('label');
    expect(err(parseAddProfile('anna;Аня;;anna@example.com;+995555123456'))).toContain('name');
  });
});

describe('parseAddRule', () => {
  it('разбирает правило с днями недели', () => {
    const v = ok(parseAddRule('ilya;20:00,21:00;Padel Court 3,Padel Court 2;1,2,3,4,5'));
    expect(v).toEqual({
      profileId: 'ilya',
      times: ['20:00', '21:00'],
      courts: ['Padel Court 3', 'Padel Court 2'],
      daysOfWeek: [1, 2, 3, 4, 5],
    });
  });

  it('без дней недели — daysOfWeek null (каждый день)', () => {
    expect(ok(parseAddRule('ilya;20:00;Padel Court 3')).daysOfWeek).toBeNull();
    expect(ok(parseAddRule('ilya;20:00;Padel Court 3;')).daysOfWeek).toBeNull();
  });

  it('нормализует имена кортов через courtByName', () => {
    expect(ok(parseAddRule('ilya;20:00;padel court 3, PADEL COURT 2')).courts).toEqual([
      'Padel Court 3',
      'Padel Court 2',
    ]);
  });

  it('сортирует дни недели', () => {
    expect(ok(parseAddRule('ilya;20:00;Padel Court 3;5,0,2')).daysOfWeek).toEqual([0, 2, 5]);
  });

  it('пустой ввод возвращает подсказку формата', () => {
    expect(err(parseAddRule(''))).toContain(ADD_RULE_USAGE);
  });

  it('ловит неизвестный корт и перечисляет доступные', () => {
    const message = err(parseAddRule('ilya;20:00;Padel Court 9'));
    expect(message).toContain('Padel Court 9');
    expect(message).toContain('Padel Court 1');
    expect(message).toContain('Park Court 1');
  });

  it('ловит кривое время', () => {
    expect(err(parseAddRule('ilya;25:00;Padel Court 3'))).toContain('HH:MM');
    expect(err(parseAddRule('ilya;20:0;Padel Court 3'))).toContain('HH:MM');
    expect(err(parseAddRule('ilya;вечером;Padel Court 3'))).toContain('HH:MM');
  });

  it('ловит день недели вне диапазона', () => {
    expect(err(parseAddRule('ilya;20:00;Padel Court 3;7'))).toContain('0–6');
    expect(err(parseAddRule('ilya;20:00;Padel Court 3;-1'))).toContain('0–6');
  });

  it('дубликаты времён, кортов и дней — ошибка конфига, а не «и так сойдёт»', () => {
    expect(err(parseAddRule('ilya;20:00,20:00;Padel Court 3'))).toContain('дубликаты');
    expect(err(parseAddRule('ilya;20:00;Padel Court 3,padel court 3'))).toContain('дубликаты');
    expect(err(parseAddRule('ilya;20:00;Padel Court 3;1,1'))).toContain('дважды');
  });

  it('ругается на число полей и пустые списки', () => {
    expect(err(parseAddRule('ilya;20:00'))).toContain('3–4 поля');
    expect(err(parseAddRule('ilya;;Padel Court 3'))).toContain('времена');
    expect(err(parseAddRule('ilya;20:00;'))).toContain('корты');
  });
});

describe('callback_data: кодирование', () => {
  it('скип использует формат контракта фазы 3 — его же шлёт планировщик', () => {
    expect(cbSkip('2026-08-06')).toBe('skip:2026-08-06');
  });

  it('все кодировщики укладываются в лимит Telegram', () => {
    const samples = [
      cbSlotsDate('2026-08-06'),
      cbSlotsCourt('2026-08-06', 3),
      cbBookDate('2026-08-06'),
      cbBookCourt('2026-08-06', 3),
      cbBookTime('2026-08-06', 3, '21:00'),
      cbBookConfirm('2026-08-06', 3, '21:00'),
      cbCancelPick(UUID),
      cbCancelConfirm(UUID),
      cbRuleToggle(UUID),
      cbSkip('2026-08-06'),
      CB_CLOSE,
      CB_NOOP,
    ];
    for (const data of samples) {
      expect(new TextEncoder().encode(data).length).toBeLessThanOrEqual(CALLBACK_DATA_MAX_BYTES);
    }
  });

  it('слишком длинная callback_data падает на месте, а не молча в проде', () => {
    expect(() => cbCancelPick('x'.repeat(80))).toThrow(RangeError);
  });
});

describe('parseCallbackData', () => {
  it('roundtrip по всем кнопкам', () => {
    expect(parseCallbackData(cbSlotsDate('2026-08-06'))).toEqual({ kind: 'slots-date', date: '2026-08-06' });
    expect(parseCallbackData(cbSlotsCourt('2026-08-06', 2))).toEqual({
      kind: 'slots-court',
      date: '2026-08-06',
      courtIndex: 2,
    });
    expect(parseCallbackData(cbBookDate('2026-08-06'))).toEqual({ kind: 'book-date', date: '2026-08-06' });
    expect(parseCallbackData(cbBookCourt('2026-08-06', 0))).toEqual({
      kind: 'book-court',
      date: '2026-08-06',
      courtIndex: 0,
    });
    expect(parseCallbackData(cbBookTime('2026-08-06', 2, '20:00'))).toEqual({
      kind: 'book-time',
      date: '2026-08-06',
      courtIndex: 2,
      time: '20:00',
    });
    expect(parseCallbackData(cbBookConfirm('2026-08-06', 2, '21:00'))).toEqual({
      kind: 'book-confirm',
      date: '2026-08-06',
      courtIndex: 2,
      time: '21:00',
    });
    expect(parseCallbackData(cbCancelPick(UUID))).toEqual({ kind: 'cancel-pick', bookingId: UUID });
    expect(parseCallbackData(cbCancelConfirm(UUID))).toEqual({ kind: 'cancel-confirm', bookingId: UUID });
    expect(parseCallbackData(cbRuleToggle(UUID))).toEqual({ kind: 'rule-toggle', ruleId: UUID });
    expect(parseCallbackData(cbSkip('2026-08-06'))).toEqual({ kind: 'skip-toggle', date: '2026-08-06' });
  });

  it('скип планировщика разбирается даже без наших кодировщиков', () => {
    expect(parseCallbackData('skip:2026-08-13')).toEqual({ kind: 'skip-toggle', date: '2026-08-13' });
  });

  it('кнопка «Бронируем» планировщика — no-op, а не мусор', () => {
    expect(parseCallbackData(CB_NOOP)).toEqual({ kind: 'noop' });
    expect(parseCallbackData('keep:2026-08-13')).toEqual({ kind: 'noop' });
  });

  it('close схлопывает наш диалог', () => {
    expect(parseCallbackData(CB_CLOSE)).toEqual({ kind: 'close' });
  });

  it('битые и чужие данные дают null (хендлер на них гасит спиннер)', () => {
    for (const data of [
      '',
      'что-то',
      'skip:вчера',
      'skip:2026-13-45x',
      'sl~d~06.08.2026',
      'sl~c~2026-08-06',
      'sl~c~2026-08-06~x',
      'sl~t~2026-08-06~1~20:00',
      'bk~t~2026-08-06~1~25:00',
      'bk~t~2026-08-06~1',
      'bk~y~2026-08-06~1~20:00~лишнее',
      'cx~p~',
      'cx~z~' + UUID,
      'cx~p~' + UUID + '~хвост',
      'rule~',
      'rule~' + UUID + '~ещё',
    ]) {
      expect(parseCallbackData(data), `данные: ${data}`).toBeNull();
    }
  });

  it('дату из callback_data проверяет по формату, а не на веру', () => {
    expect(parseCallbackData('sl~d~2026-8-6')).toBeNull();
    expect(parseCallbackData('bk~d~2026-08-06')).not.toBeNull();
  });
});
