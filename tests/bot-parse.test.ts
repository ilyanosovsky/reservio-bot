import { describe, expect, it } from 'vitest';
import {
  ADD_PROFILE_USAGE,
  ADD_RULE_USAGE,
  CALLBACK_DATA_MAX_BYTES,
  CB_CLOSE,
  CB_NOOP,
  COURTS_MASK_MAX,
  DAYS_MASK_MAX,
  EMPTY_RULE_DRAFT,
  TIMES_MASK_MAX,
  type RuleDraft,
  bitsOf,
  cbBookBackDates,
  cbBookConfirm,
  cbBookCourt,
  cbBookDate,
  cbBookTime,
  cbCancelConfirm,
  cbCancelPick,
  cbRuleDelete,
  cbRuleDeleteAsk,
  cbRuleEdit,
  cbRuleToggle,
  cbRuleWizard,
  cbRulesList,
  cbSkip,
  cbSlotsBackDates,
  cbSlotsCourt,
  cbSlotsDate,
  decodeMask,
  encodeMask,
  maskOfBits,
  parseAddProfile,
  parseAddRule,
  parseCallbackData,
  toggleBit,
  PROFILE_NAME_MAX,
  cbProfileCancel,
  cbProfileCreate,
  cbProfileInvite,
  cbProfileNew,
  isProfileEmail,
  isProfileId,
  isProfileName,
  isProfilePhone,
  normalizePhone,
  parseInviteStart,
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
      mode: null,
    });
  });

  it('пятое поле задаёт режим (мультикорт-вечер)', () => {
    expect(ok(parseAddRule('ilya;20:00;Padel Court 3,Padel Court 4;1,3;all')).mode).toBe('all');
    expect(ok(parseAddRule('ilya;20:00;Padel Court 3;;priority')).mode).toBe('priority');
    expect(ok(parseAddRule('ilya;20:00;Padel Court 3;;A')).mode).toBe('all');
  });

  it('режим не указан — null, а не «priority»', () => {
    // Иначе повтор команды без пятого поля молча разжаловал бы сценарий 'all'
    // обратно в 'priority', и вечерняя вахта по набору кортов сломалась бы.
    expect(ok(parseAddRule('ilya;20:00;Padel Court 3')).mode).toBeNull();
    expect(ok(parseAddRule('ilya;20:00;Padel Court 3;1,3;')).mode).toBeNull();
  });

  it('неизвестный режим — ошибка, а не «и так сойдёт»', () => {
    expect(err(parseAddRule('ilya;20:00;Padel Court 3;;оба'))).toContain('Режим');
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
    expect(err(parseAddRule('ilya;20:00'))).toContain('3–5 полей');
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
      cbSlotsBackDates(),
      cbBookBackDates(),
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

describe('callback_data: кнопка «Назад»', () => {
  it('возврат на шаг 0 — отдельное действие без параметров', () => {
    expect(parseCallbackData(cbSlotsBackDates())).toEqual({ kind: 'slots-back-dates' });
    expect(parseCallbackData(cbBookBackDates())).toEqual({ kind: 'book-back-dates' });
  });

  it('кодируется коротко и различает мастера', () => {
    expect(cbSlotsBackDates()).toBe('sl~b');
    expect(cbBookBackDates()).toBe('bk~b');
  });

  it('лишние поля у шага 0 — мусор, а не «и так сойдёт»', () => {
    for (const data of ['sl~b~2026-08-06', 'bk~b~', 'bk~b~2026-08-06~1', 'cx~b']) {
      expect(parseCallbackData(data), `данные: ${data}`).toBeNull();
    }
  });

  it('возврат с глубоких шагов переиспользует кодировщики самих шагов', () => {
    // время → корт (та же дата)
    expect(parseCallbackData(cbBookDate('2026-08-06'))).toEqual({ kind: 'book-date', date: '2026-08-06' });
    // подтверждение → время (та же дата и корт)
    expect(parseCallbackData(cbBookCourt('2026-08-06', 4))).toEqual({
      kind: 'book-court',
      date: '2026-08-06',
      courtIndex: 4,
    });
    // список слотов → корт (та же дата)
    expect(parseCallbackData(cbSlotsDate('2026-08-06'))).toEqual({ kind: 'slots-date', date: '2026-08-06' });
  });
});

describe('битмаски мультивыбора', () => {
  // Мультивыборы мастера расписаний едут в callback_data битмасками: серверного
  // состояния мастера нет, поэтому кодек — единственное место, где выбор может
  // потеряться. Границы (пусто/всё) проверяем явно.

  it('пустой выбор — «0», а не пустая строка', () => {
    expect(encodeMask(0)).toBe('0');
    expect(decodeMask('0', DAYS_MASK_MAX)).toBe(0);
    expect(bitsOf(0)).toEqual([]);
  });

  it('полный выбор каждого типа кодируется и читается обратно', () => {
    expect(encodeMask(DAYS_MASK_MAX)).toBe('7f');
    expect(encodeMask(COURTS_MASK_MAX)).toBe('3f');
    expect(encodeMask(TIMES_MASK_MAX)).toBe('ffffff');
    expect(decodeMask('7f', DAYS_MASK_MAX)).toBe(DAYS_MASK_MAX);
    expect(decodeMask('3f', COURTS_MASK_MAX)).toBe(COURTS_MASK_MAX);
    expect(decodeMask('ffffff', TIMES_MASK_MAX)).toBe(TIMES_MASK_MAX);
    expect(bitsOf(DAYS_MASK_MAX)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(bitsOf(TIMES_MASK_MAX)).toHaveLength(24);
  });

  it('roundtrip произвольного набора битов', () => {
    for (const bits of [[0], [3, 6], [7, 20, 21, 23], [1, 2, 3, 4, 5]]) {
      const mask = maskOfBits(bits);
      expect(decodeMask(encodeMask(mask), TIMES_MASK_MAX)).toBe(mask);
      expect(bitsOf(mask)).toEqual(bits);
    }
  });

  it('галочка переключается туда и обратно', () => {
    const once = toggleBit(0, 20);
    expect(bitsOf(once)).toEqual([20]);
    expect(toggleBit(once, 20)).toBe(0);
    expect(bitsOf(toggleBit(once, 21))).toEqual([20, 21]);
  });

  it('бит вне разрешённого диапазона типа — null (чужая кнопка), а не тихий мусор', () => {
    // 0x80 это восьмой «день недели», 0x40 — седьмой корт: таких нет.
    expect(decodeMask('80', DAYS_MASK_MAX)).toBeNull();
    expect(decodeMask('40', COURTS_MASK_MAX)).toBeNull();
    expect(decodeMask('ffffff', DAYS_MASK_MAX)).toBeNull();
  });

  it('не-hex, пустое и слишком длинное — null', () => {
    for (const raw of ['', 'zz', '0x7f', '-1', '1234567', undefined]) {
      expect(decodeMask(raw, TIMES_MASK_MAX), `значение: ${String(raw)}`).toBeNull();
    }
  });

  it('маска вне 24 бит до callback_data не доезжает', () => {
    expect(() => encodeMask(1 << 24)).toThrow(RangeError);
    expect(() => encodeMask(-1)).toThrow(RangeError);
  });

  it('maskOfBits игнорирует мусорные номера битов', () => {
    expect(maskOfBits([0, -1, 24, 99, 3])).toBe(maskOfBits([0, 3]));
  });
});

describe('callback_data мастера расписаний', () => {
  const draft = (over: Partial<RuleDraft> = {}): RuleDraft => ({ ...EMPTY_RULE_DRAFT, ...over });

  it('шаг мастера везёт черновик целиком и читается обратно', () => {
    const d = draft({ days: 0b0111110, times: maskOfBits([20, 21]), courts: 0b000100, mode: 'all', ruleId: UUID });
    for (const step of ['days', 'times', 'courts', 'mode', 'confirm', 'save'] as const) {
      expect(parseCallbackData(cbRuleWizard(step, d))).toEqual({ kind: 'rule-wizard', step, draft: d });
    }
  });

  it('пустой черновик нового сценария — самая короткая кнопка мастера', () => {
    expect(cbRuleWizard('days', EMPTY_RULE_DRAFT)).toBe('rw~d~0~0~0~p~');
    expect(parseCallbackData('rw~d~0~0~0~p~')).toEqual({
      kind: 'rule-wizard',
      step: 'days',
      draft: { days: 0, times: 0, courts: 0, mode: 'priority', ruleId: null },
    });
  });

  it('худший случай мастера укладывается в лимит Telegram', () => {
    const worst = cbRuleWizard('courts', {
      days: DAYS_MASK_MAX,
      times: TIMES_MASK_MAX,
      courts: COURTS_MASK_MAX,
      mode: 'all',
      ruleId: UUID,
    });
    expect(worst).toBe(`rw~c~7f~ffffff~3f~a~${UUID}`);
    expect(new TextEncoder().encode(worst).length).toBeLessThanOrEqual(CALLBACK_DATA_MAX_BYTES);
  });

  it('кнопки списка сценариев короткие и различимые', () => {
    expect(cbRulesList()).toBe('rw~l');
    expect(parseCallbackData(cbRulesList())).toEqual({ kind: 'rules-list' });
    expect(parseCallbackData(cbRuleEdit(UUID))).toEqual({ kind: 'rule-edit', ruleId: UUID });
    expect(parseCallbackData(cbRuleDeleteAsk(UUID))).toEqual({ kind: 'rule-delete-ask', ruleId: UUID });
    expect(parseCallbackData(cbRuleDelete(UUID))).toEqual({ kind: 'rule-delete', ruleId: UUID });
    for (const data of [cbRulesList(), cbRuleEdit(UUID), cbRuleDeleteAsk(UUID), cbRuleDelete(UUID)]) {
      expect(new TextEncoder().encode(data).length).toBeLessThanOrEqual(CALLBACK_DATA_MAX_BYTES);
    }
  });

  it('тумблер сценария и мастер не путаются: «rule» и «rw» это разные кнопки', () => {
    expect(parseCallbackData(cbRuleToggle(UUID))).toEqual({ kind: 'rule-toggle', ruleId: UUID });
    expect(parseCallbackData('rw~' + UUID)).toBeNull();
  });

  it('битые данные мастера дают null', () => {
    for (const data of [
      'rw',
      'rw~l~лишнее',
      'rw~ed',
      'rw~ed~',
      'rw~ed~' + UUID + '~хвост',
      'rw~ok~плохой id',
      'rw~q~0~0~0~p~',            // нет такого шага
      'rw~d~0~0~0~p',             // не хватает поля id
      'rw~d~0~0~0~p~~',           // лишнее поле
      'rw~d~80~0~0~p~',           // восьмой день недели
      'rw~d~0~0~40~p~',           // седьмой корт
      'rw~d~0~1000000~0~p~',      // 25-й час
      'rw~d~0~0~0~x~',            // неизвестный режим
      'rw~d~0~0~0~p~плохой id',
    ]) {
      expect(parseCallbackData(data), `данные: ${data}`).toBeNull();
    }
  });

  it('id длиннее uuid не пролезает молча — кодировщик падает на месте', () => {
    // Запас лимита рассчитан на uuid (36). Id длиннее ломает мастер, и лучше
    // громким RangeError в хендлере, чем мёртвой кнопкой в проде.
    const tooLong = draft({
      days: DAYS_MASK_MAX,
      times: TIMES_MASK_MAX,
      courts: COURTS_MASK_MAX,
      ruleId: 'x'.repeat(48),
    });
    expect(() => cbRuleWizard('confirm', tooLong)).toThrow(RangeError);
  });
});

describe('parseInviteStart', () => {
  // Разбор `/start inv_<code>` — вход в ЕДИНСТВЕННОЕ исключение из инварианта
  // тишины (src/bot/auth.ts). Всё, что этот разбор пропустил, доедет до
  // authMiddleware и для чата без профиля закончится молчанием, поэтому здесь
  // важнее ложные СРАБАТЫВАНИЯ, чем ложные отказы.
  const CODE = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';

  it('ссылка-приглашение разбирается в код', () => {
    expect(parseInviteStart(`/start inv_${CODE}`)).toBe(CODE);
  });

  it('Telegram-суффикс @имя_бота (пересланная ссылка) не мешает', () => {
    expect(parseInviteStart(`/start@padel_test_bot inv_${CODE}`)).toBe(CODE);
  });

  it('регистр кода не важен, пробелы по краям срезаются', () => {
    expect(parseInviteStart(`  /start inv_${CODE.toUpperCase()}  `)).toBe(CODE.toUpperCase());
  });

  it('обычный /start приглашением не является', () => {
    expect(parseInviteStart('/start')).toBeNull();
    expect(parseInviteStart('/start ')).toBeNull();
  });

  it('чужой payload /start (не inv_) игнорируется', () => {
    // У Telegram deep link один на всех: под ним могут приехать реферальные
    // метки и что угодно ещё. Наше — только inv_.
    expect(parseInviteStart(`/start ref_${CODE}`)).toBeNull();
    expect(parseInviteStart(`/start ${CODE}`)).toBeNull();
  });

  it('код не того формата отбрасывается до всякой сети', () => {
    expect(parseInviteStart('/start inv_короткий')).toBeNull();
    expect(parseInviteStart('/start inv_zzzz')).toBeNull();
    // Не hex: 'g' вне алфавита.
    expect(parseInviteStart(`/start inv_${'g'.repeat(32)}`)).toBeNull();
    // Килобайт мусора в фильтр PostgREST не поедет.
    expect(parseInviteStart(`/start inv_${'a'.repeat(2000)}`)).toBeNull();
  });

  it('лишние аргументы после кода — не приглашение', () => {
    expect(parseInviteStart(`/start inv_${CODE} и ещё что-то`)).toBeNull();
  });

  it('не команда /start вовсе — null (в т.ч. похожие строки)', () => {
    expect(parseInviteStart(undefined)).toBeNull();
    expect(parseInviteStart('')).toBeNull();
    expect(parseInviteStart(`inv_${CODE}`)).toBeNull();
    expect(parseInviteStart(`/started inv_${CODE}`)).toBeNull();
    expect(parseInviteStart(`просто текст inv_${CODE}`)).toBeNull();
  });
});

describe('callback_data мастера профиля', () => {
  // Черновик мастера в кнопке НЕ едет (в отличие от мастера расписаний): в нём
  // email и телефон живого человека, а callback_data видна в разметке
  // сообщения. Поэтому кнопки несут только действие.
  it('кнопки кодируются и разбираются обратно', () => {
    expect(parseCallbackData(cbProfileNew())).toEqual({ kind: 'profile-new' });
    expect(parseCallbackData(cbProfileCreate())).toEqual({ kind: 'profile-create' });
    expect(parseCallbackData(cbProfileCancel())).toEqual({ kind: 'profile-cancel' });
  });

  it('персональных данных в кнопке нет — только префикс и код действия', () => {
    for (const data of [cbProfileNew(), cbProfileCreate(), cbProfileCancel()]) {
      expect(data.startsWith('pw~')).toBe(true);
      expect(data.split('~')).toHaveLength(2);
      expect(Buffer.byteLength(data, 'utf8')).toBeLessThanOrEqual(CALLBACK_DATA_MAX_BYTES);
    }
  });

  it('неизвестное действие ветки pw отбрасывается', () => {
    expect(parseCallbackData('pw~zzz')).toBeNull();
    expect(parseCallbackData('pw')).toBeNull();
    // Лишнее поле у кнопок мастера — отказ: данных в них нет по построению.
    expect(parseCallbackData('pw~y~anna@example.com')).toBeNull();
    expect(parseCallbackData('pw~n~p1a2b3c4')).toBeNull();
  });

  it('кнопка перевыпуска ссылки везёт id профиля и разбирается обратно', () => {
    const data = cbProfileInvite('p1a2b3c4');

    expect(parseCallbackData(data)).toEqual({ kind: 'profile-invite', profileId: 'p1a2b3c4' });
    expect(Buffer.byteLength(data, 'utf8')).toBeLessThanOrEqual(CALLBACK_DATA_MAX_BYTES);
    // Даже самый длинный допустимый id в лимит укладывается.
    expect(Buffer.byteLength(cbProfileInvite('p'.repeat(32)), 'utf8')).toBeLessThanOrEqual(CALLBACK_DATA_MAX_BYTES);
  });

  it('подделанный id в кнопке перевыпуска не проходит разбор', () => {
    // Кнопка приводит к выпуску секрета — id проверяется тем же предикатом,
    // что и в /add_profile, а не «что пришло, то и берём».
    expect(parseCallbackData('pw~i~')).toBeNull();
    expect(parseCallbackData('pw~i~p')).toBeNull();
    expect(parseCallbackData('pw~i~anna@example.com')).toBeNull();
    expect(parseCallbackData(`pw~i~${'p'.repeat(33)}`)).toBeNull();
  });
});

describe('валидаторы полей профиля (общие для команды и мастера)', () => {
  // Мастер и /add_profile обязаны принимать РОВНО одно и то же: разъехавшись,
  // они дали бы «команда завела, мастер отказал» на одном и том же игроке.
  it('имя: непустое и не длиннее лимита', () => {
    expect(isProfileName('Аня')).toBe(true);
    expect(isProfileName('  Аня  ')).toBe(true);
    expect(isProfileName('')).toBe(false);
    expect(isProfileName('   ')).toBe(false);
    expect(isProfileName('я'.repeat(PROFILE_NAME_MAX))).toBe(true);
    expect(isProfileName('я'.repeat(PROFILE_NAME_MAX + 1))).toBe(false);
  });

  it('id: 2–32 символа латиницей, цифрами, «-» и «_»', () => {
    // Тот же предикат режет и id в callback_data кнопки «🔗 Ссылка».
    expect(isProfileId('anna')).toBe(true);
    expect(isProfileId('p1a2b3c4')).toBe(true);
    expect(isProfileId('p'.repeat(32))).toBe(true);
    expect(isProfileId('p'.repeat(33))).toBe(false);
    expect(isProfileId('a')).toBe(false);
    expect(isProfileId('')).toBe(false);
    expect(isProfileId('Аня')).toBe(false);
    expect(isProfileId('anna@example.com')).toBe(false);
    expect(isProfileId('_anna')).toBe(false);
  });

  it('email: тот же предикат, что у /add_profile', () => {
    expect(isProfileEmail('anna@example.com')).toBe(true);
    expect(isProfileEmail('  anna@example.com  ')).toBe(true);
    expect(isProfileEmail('anna')).toBe(false);
    expect(isProfileEmail('anna@')).toBe(false);
    expect(isProfileEmail('')).toBe(false);
  });

  it('телефон: пробелы и скобки убираются, формат +995XXXXXXXXX', () => {
    expect(normalizePhone(' +995 (555) 111-222 ')).toBe('+995555111222');
    expect(isProfilePhone(normalizePhone('+995 555 111 222'))).toBe(true);
    expect(isProfilePhone(normalizePhone('995555111222'))).toBe(false);
    expect(isProfilePhone(normalizePhone('+995abc111222'))).toBe(false);
  });

  it('мастер и команда принимают один и тот же набор значений', () => {
    const ok = parseAddProfile('anna;Аня;Anna;anna@example.com;+995 555 111 222');
    expect(ok.ok).toBe(true);
    // Ровно те же поля через предикаты мастера.
    expect(isProfileName('Аня')).toBe(true);
    expect(isProfileEmail('anna@example.com')).toBe(true);
    expect(isProfilePhone(normalizePhone('+995 555 111 222'))).toBe(true);
  });
});

describe('обратная совместимость callback_data', () => {
  // Кнопки живут в уже отправленных сообщениях: тап по вчерашнему меню обязан
  // работать после деплоя. Строки ниже — литералы старого формата, а не вызовы
  // кодировщиков: иначе тест сломается вместе со схемой, ничего не заметив.
  it('старые форматы разбираются как раньше', () => {
    expect(parseCallbackData('sl~d~2026-08-06')).toEqual({ kind: 'slots-date', date: '2026-08-06' });
    expect(parseCallbackData('sl~c~2026-08-06~4')).toEqual({
      kind: 'slots-court',
      date: '2026-08-06',
      courtIndex: 4,
    });
    expect(parseCallbackData('bk~d~2026-08-06')).toEqual({ kind: 'book-date', date: '2026-08-06' });
    expect(parseCallbackData('bk~c~2026-08-06~2')).toEqual({
      kind: 'book-court',
      date: '2026-08-06',
      courtIndex: 2,
    });
    expect(parseCallbackData('bk~t~2026-08-06~2~20:00')).toEqual({
      kind: 'book-time',
      date: '2026-08-06',
      courtIndex: 2,
      time: '20:00',
    });
    expect(parseCallbackData('bk~y~2026-08-06~2~21:00')).toEqual({
      kind: 'book-confirm',
      date: '2026-08-06',
      courtIndex: 2,
      time: '21:00',
    });
    expect(parseCallbackData(`cx~p~${UUID}`)).toEqual({ kind: 'cancel-pick', bookingId: UUID });
    expect(parseCallbackData(`cx~y~${UUID}`)).toEqual({ kind: 'cancel-confirm', bookingId: UUID });
    expect(parseCallbackData(`rule~${UUID}`)).toEqual({ kind: 'rule-toggle', ruleId: UUID });
    expect(parseCallbackData('skip:2026-08-06')).toEqual({ kind: 'skip-toggle', date: '2026-08-06' });
    expect(parseCallbackData('keep:2026-08-06')).toEqual({ kind: 'noop' });
    expect(parseCallbackData('noop')).toEqual({ kind: 'noop' });
    expect(parseCallbackData('close')).toEqual({ kind: 'close' });
  });
});
