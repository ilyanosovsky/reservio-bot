import { describe, expect, it } from 'vitest';
import { loadProfiles, ruleAppliesOn } from '../src/core/profiles.js';

// Тестовые env — только выдуманные значения, никаких реальных CLIENT_*.
const BASE_ENV = {
  CLIENT_NAME: 'Test Player',
  CLIENT_EMAIL: 'test.player@example.com',
  CLIENT_PHONE: '+995500000000',
} satisfies Record<string, string>;

describe('loadProfiles: профиль по умолчанию', () => {
  it('собирает профиль ilya из CLIENT_*', () => {
    const [p, ...rest] = loadProfiles({ ...BASE_ENV });
    expect(rest).toEqual([]);
    expect(p).toEqual({
      id: 'ilya',
      label: 'Ilya',
      contact: {
        name: 'Test Player',
        email: 'test.player@example.com',
        phone: '+995500000000',
      },
      rule: {
        times: ['20:00', '21:00'],
        courts: ['Padel Court 3', 'Padel Court 2'],
      },
    });
  });

  it('без daysOfWeek поле отсутствует (правило действует каждый день)', () => {
    const [p] = loadProfiles({ ...BASE_ENV });
    expect(p!.rule.daysOfWeek).toBeUndefined();
    expect('daysOfWeek' in p!.rule).toBe(false);
  });

  it('игнорирует лишние пробелы вокруг значений', () => {
    const [p] = loadProfiles({ ...BASE_ENV, CLIENT_NAME: '  Test Player  ' });
    expect(p!.contact.name).toBe('Test Player');
  });

  it('берёт telegramChatId из TELEGRAM_CHAT_ID', () => {
    const [p] = loadProfiles({ ...BASE_ENV, TELEGRAM_CHAT_ID: '12345' });
    expect(p!.telegramChatId).toBe('12345');
  });

  it('PROFILE_ILYA_* переопределяет дефолты', () => {
    const [p] = loadProfiles({
      ...BASE_ENV,
      PROFILE_ILYA_LABEL: 'Илья',
      PROFILE_ILYA_TIMES: '19:00, 20:00',
      PROFILE_ILYA_COURTS: 'Padel Court 1,Padel Court 4',
      PROFILE_ILYA_DAYS: '1,3,5',
      PROFILE_ILYA_TELEGRAM_CHAT_ID: '777',
    });
    expect(p!.label).toBe('Илья');
    expect(p!.rule).toEqual({
      times: ['19:00', '20:00'],
      courts: ['Padel Court 1', 'Padel Court 4'],
      daysOfWeek: [1, 3, 5],
    });
    expect(p!.telegramChatId).toBe('777');
  });

  it('PROFILE_ILYA_EMAIL не создаёт второй профиль', () => {
    const profiles = loadProfiles({ ...BASE_ENV, PROFILE_ILYA_EMAIL: 'dup@example.com' });
    expect(profiles).toHaveLength(1);
    expect(profiles[0]!.contact.email).toBe('test.player@example.com');
  });
});

describe('loadProfiles: отсутствие CLIENT_* → понятная ошибка', () => {
  it('пустой env', () => {
    expect(() => loadProfiles({})).toThrow(/CLIENT_NAME/);
  });

  it('каждая недостающая переменная названа в сообщении', () => {
    for (const name of ['CLIENT_NAME', 'CLIENT_EMAIL', 'CLIENT_PHONE'] as const) {
      const env: Record<string, string | undefined> = { ...BASE_ENV };
      delete env[name];
      expect(() => loadProfiles(env)).toThrow(new RegExp(`${name}`));
      expect(() => loadProfiles(env)).toThrow(/\.env\.example/);
    }
  });

  it('пустая строка равносильна отсутствию', () => {
    expect(() => loadProfiles({ ...BASE_ENV, CLIENT_EMAIL: '   ' })).toThrow(/CLIENT_EMAIL/);
  });

  it('email без @ отвергается', () => {
    expect(() => loadProfiles({ ...BASE_ENV, CLIENT_EMAIL: 'not-an-email' })).toThrow(/CLIENT_EMAIL/);
  });

  it('текст ошибки не цитирует само значение — оно персональное', () => {
    // Эта ошибка уезжает в лог рана, в output и в Telegram (trigger/book-drop.ts).
    const bad = 'player.test at example.com';
    expect(() => loadProfiles({ ...BASE_ENV, CLIENT_EMAIL: bad })).toThrow(/CLIENT_EMAIL/);
    expect(() => loadProfiles({ ...BASE_ENV, CLIENT_EMAIL: bad })).not.toThrow(new RegExp(bad));
  });
});

describe('loadProfiles: дополнительные профили из конфига', () => {
  const EXTRA = {
    PROFILE_ANNA_NAME: 'Anna Test',
    PROFILE_ANNA_EMAIL: 'anna@example.com',
    PROFILE_ANNA_PHONE: '+995511111111',
    PROFILE_ANNA_TIMES: '19:00',
    PROFILE_ANNA_COURTS: 'Padel Court 1,Padel Court 4',
  } satisfies Record<string, string>;

  it('второй профиль добавляется без изменения кода', () => {
    const profiles = loadProfiles({ ...BASE_ENV, ...EXTRA });
    expect(profiles.map((p) => p.id)).toEqual(['ilya', 'anna']);
    expect(profiles[1]).toEqual({
      id: 'anna',
      label: 'anna',
      contact: {
        name: 'Anna Test',
        email: 'anna@example.com',
        phone: '+995511111111',
      },
      rule: {
        times: ['19:00'],
        courts: ['Padel Court 1', 'Padel Court 4'],
      },
    });
  });

  it('label и chat_id опциональны', () => {
    const profiles = loadProfiles({
      ...BASE_ENV,
      ...EXTRA,
      PROFILE_ANNA_LABEL: 'Аня',
      PROFILE_ANNA_TELEGRAM_CHAT_ID: '999',
      PROFILE_ANNA_DAYS: '0,6',
    });
    expect(profiles[1]!.label).toBe('Аня');
    expect(profiles[1]!.telegramChatId).toBe('999');
    expect(profiles[1]!.rule.daysOfWeek).toEqual([0, 6]);
  });

  it('несколько дополнительных профилей идут в стабильном порядке', () => {
    const profiles = loadProfiles({
      ...BASE_ENV,
      ...EXTRA,
      PROFILE_BOB_NAME: 'Bob Test',
      PROFILE_BOB_EMAIL: 'bob@example.com',
      PROFILE_BOB_PHONE: '+995522222222',
      PROFILE_BOB_TIMES: '18:00',
      PROFILE_BOB_COURTS: 'Park Court 1',
    });
    expect(profiles.map((p) => p.id)).toEqual(['ilya', 'anna', 'bob']);
  });

  it('times и courts обязательны для доп. профиля', () => {
    const noTimes: Record<string, string | undefined> = { ...BASE_ENV, ...EXTRA };
    delete noTimes['PROFILE_ANNA_TIMES'];
    expect(() => loadProfiles(noTimes)).toThrow(/PROFILE_ANNA_TIMES/);

    const noCourts: Record<string, string | undefined> = { ...BASE_ENV, ...EXTRA };
    delete noCourts['PROFILE_ANNA_COURTS'];
    expect(() => loadProfiles(noCourts)).toThrow(/PROFILE_ANNA_COURTS/);
  });

  it('недостающие контактные поля названы в ошибке', () => {
    const env: Record<string, string | undefined> = { ...BASE_ENV, ...EXTRA };
    delete env['PROFILE_ANNA_PHONE'];
    expect(() => loadProfiles(env)).toThrow(/PROFILE_ANNA_PHONE/);
  });
});

describe('loadProfiles: валидация правил', () => {
  it('кривое время отвергается', () => {
    expect(() => loadProfiles({ ...BASE_ENV, PROFILE_ILYA_TIMES: '20:00,25:00' })).toThrow(/HH:MM/);
    expect(() => loadProfiles({ ...BASE_ENV, PROFILE_ILYA_TIMES: '8:00' })).toThrow(/HH:MM/);
  });

  it('пустой список после разбора отвергается', () => {
    expect(() => loadProfiles({ ...BASE_ENV, PROFILE_ILYA_COURTS: ',,,' })).toThrow(/PROFILE_ILYA_COURTS/);
  });

  it('день недели вне 0–6 отвергается', () => {
    expect(() => loadProfiles({ ...BASE_ENV, PROFILE_ILYA_DAYS: '7' })).toThrow(/0–6/);
    expect(() => loadProfiles({ ...BASE_ENV, PROFILE_ILYA_DAYS: 'mon' })).toThrow(/0–6/);
    expect(() => loadProfiles({ ...BASE_ENV, PROFILE_ILYA_DAYS: '1.5' })).toThrow(/0–6/);
  });

  it('порядок кортов = приоритет и сохраняется как задан', () => {
    const [p] = loadProfiles({ ...BASE_ENV, PROFILE_ILYA_COURTS: 'Padel Court 2,Padel Court 3' });
    expect(p!.rule.courts).toEqual(['Padel Court 2', 'Padel Court 3']);
  });
});

describe('ruleAppliesOn', () => {
  it('без daysOfWeek правило действует каждый день', () => {
    const [p] = loadProfiles({ ...BASE_ENV });
    for (const date of ['2026-08-03', '2026-08-06', '2026-08-09']) {
      expect(ruleAppliesOn(p!.rule, date)).toBe(true);
    }
  });

  it('daysOfWeek фильтрует дни игры (вт/чт)', () => {
    const [p] = loadProfiles({ ...BASE_ENV, PROFILE_ILYA_DAYS: '2,4' });
    expect(ruleAppliesOn(p!.rule, '2026-08-04')).toBe(true); // вт
    expect(ruleAppliesOn(p!.rule, '2026-08-06')).toBe(true); // чт
    expect(ruleAppliesOn(p!.rule, '2026-08-09')).toBe(false); // вс
    expect(ruleAppliesOn(p!.rule, '2026-08-05')).toBe(false); // ср
  });

  it('день недели считается в зоне клуба, а не в TZ хоста', () => {
    // Тесты идут в America/New_York: new Date('2026-08-06').getDay() дал бы
    // среду вместо четверга и правило «вт/чт» молча промахнулось бы на день.
    expect(process.env.TZ).toBe('America/New_York');
    expect(new Date('2026-08-06').getDay()).toBe(3);
    const [p] = loadProfiles({ ...BASE_ENV, PROFILE_ILYA_DAYS: '4' });
    expect(ruleAppliesOn(p!.rule, '2026-08-06')).toBe(true);
  });
});
