import type { ClientContact } from '../reservio/types.js';
import { weekdayOf } from './scheduler.js';

/**
 * Профили бронирования.
 *
 * Бот обслуживает несколько человек на одном клубе: у каждого свой email
 * (бронь привязывается к его кабинету), свой chat_id в Telegram и свои правила
 * (времена, приоритет кортов, дни недели). Никаких «20:00 Court 3» в коде
 * engine — только здесь, из конфига.
 *
 * Схема env:
 *   Профиль по умолчанию (id = 'ilya'):
 *     CLIENT_NAME / CLIENT_EMAIL / CLIENT_PHONE   — обязательны
 *     TELEGRAM_CHAT_ID                            — опционально
 *     PROFILE_ILYA_LABEL / _TIMES / _COURTS / _DAYS / _TELEGRAM_CHAT_ID
 *                                                 — опциональные переопределения
 *   Дополнительный профиль (ключ K, id = k в нижнем регистре):
 *     PROFILE_<K>_NAME / _EMAIL / _PHONE / _TIMES / _COURTS  — обязательны
 *     PROFILE_<K>_LABEL / _DAYS / _TELEGRAM_CHAT_ID          — опционально
 *
 * Пример второго профиля (добавляется БЕЗ изменения кода):
 *   PROFILE_ANNA_NAME="Anna ..."      PROFILE_ANNA_EMAIL="anna@example.com"
 *   PROFILE_ANNA_PHONE="+995..."      PROFILE_ANNA_TIMES="19:00"
 *   PROFILE_ANNA_COURTS="Padel Court 1,Padel Court 4"
 *   PROFILE_ANNA_DAYS="2,4"
 */

export interface BookingRule {
  /** Времена слотов 'HH:MM' — каждое время это отдельный дроп и отдельная бронь. */
  times: string[];
  /** Имена кортов в порядке приоритета (первый — основной, дальше fallback). */
  courts: string[];
  /** Дни недели 0–6 (вс = 0); undefined = каждый день. */
  daysOfWeek?: number[];
}

export interface Profile {
  id: string;
  label: string;
  contact: ClientContact;
  telegramChatId?: string;
  rule: BookingRule;
}

const DEFAULT_PROFILE_ID = 'ilya';
const DEFAULT_PROFILE_ENV_KEY = 'ILYA';
const DEFAULT_TIMES = ['20:00', '21:00'];
const DEFAULT_COURTS = ['Padel Court 3', 'Padel Court 2'];

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const PROFILE_ENV_KEY_RE = /^[A-Z0-9_]+$/;
/** Дополнительные профили опознаём по наличию PROFILE_<K>_EMAIL. */
const PROFILE_EMAIL_ENV_RE = /^PROFILE_([A-Z0-9_]+)_EMAIL$/;

type Env = Record<string, string | undefined>;

export function loadProfiles(env: Env): Profile[] {
  const profiles: Profile[] = [defaultProfile(env)];
  for (const key of extraProfileEnvKeys(env)) {
    profiles.push(extraProfile(env, key));
  }

  const seen = new Set<string>();
  for (const p of profiles) {
    if (seen.has(p.id)) {
      throw new Error(`Дублирующийся id профиля: ${p.id}`);
    }
    seen.add(p.id);
  }
  return profiles;
}

/**
 * Действует ли правило профиля в этот день игры.
 * `daysOfWeek === undefined` — каждый день. День недели считается из строки
 * даты через UTC-поля (weekdayOf), а не через `new Date(date).getDay()`:
 * последний на хосте западнее UTC даёт предыдущий день.
 */
export function ruleAppliesOn(rule: BookingRule, date: string): boolean {
  if (rule.daysOfWeek === undefined) return true;
  return rule.daysOfWeek.includes(weekdayOf(date));
}

function defaultProfile(env: Env): Profile {
  const k = DEFAULT_PROFILE_ENV_KEY;
  return {
    id: DEFAULT_PROFILE_ID,
    label: optional(env, `PROFILE_${k}_LABEL`) ?? 'Ilya',
    contact: {
      name: required(env, 'CLIENT_NAME'),
      email: requiredEmail(env, 'CLIENT_EMAIL'),
      phone: required(env, 'CLIENT_PHONE'),
    },
    ...withTelegram(optional(env, `PROFILE_${k}_TELEGRAM_CHAT_ID`) ?? optional(env, 'TELEGRAM_CHAT_ID')),
    rule: {
      times: parseTimes(env, `PROFILE_${k}_TIMES`) ?? DEFAULT_TIMES,
      courts: parseCourts(env, `PROFILE_${k}_COURTS`) ?? DEFAULT_COURTS,
      ...withDays(parseDays(env, `PROFILE_${k}_DAYS`)),
    },
  };
}

function extraProfile(env: Env, k: string): Profile {
  const id = k.toLowerCase();
  // times/courts обязательны: молчаливое наследование дефолта привело бы к двум
  // профилям, дерущимся за один и тот же слот.
  return {
    id,
    label: optional(env, `PROFILE_${k}_LABEL`) ?? id,
    contact: {
      name: required(env, `PROFILE_${k}_NAME`),
      email: requiredEmail(env, `PROFILE_${k}_EMAIL`),
      phone: required(env, `PROFILE_${k}_PHONE`),
    },
    ...withTelegram(optional(env, `PROFILE_${k}_TELEGRAM_CHAT_ID`)),
    rule: {
      times: parseTimes(env, `PROFILE_${k}_TIMES`) ?? missing(`PROFILE_${k}_TIMES`),
      courts: parseCourts(env, `PROFILE_${k}_COURTS`) ?? missing(`PROFILE_${k}_COURTS`),
      ...withDays(parseDays(env, `PROFILE_${k}_DAYS`)),
    },
  };
}

function extraProfileEnvKeys(env: Env): string[] {
  const keys: string[] = [];
  for (const name of Object.keys(env)) {
    const m = PROFILE_EMAIL_ENV_RE.exec(name);
    if (!m) continue;
    const k = m[1]!;
    // Ключ профиля по умолчанию зарезервирован: PROFILE_ILYA_* — только
    // переопределения, второго профиля из него не возникает.
    if (k === DEFAULT_PROFILE_ENV_KEY) continue;
    if (optional(env, name) === undefined) continue;
    if (!PROFILE_ENV_KEY_RE.test(k)) {
      throw new Error(`Некорректный ключ профиля в env: ${name}`);
    }
    keys.push(k);
  }
  return keys.sort();
}

/** Поля-опционалы не выставляем в undefined: exactOptionalPropertyTypes-friendly. */
function withTelegram(chatId: string | undefined): { telegramChatId?: string } {
  return chatId === undefined ? {} : { telegramChatId: chatId };
}

function withDays(days: number[] | undefined): { daysOfWeek?: number[] } {
  return days === undefined ? {} : { daysOfWeek: days };
}

function optional(env: Env, name: string): string | undefined {
  const raw = env[name];
  if (raw === undefined) return undefined;
  const value = raw.trim();
  return value === '' ? undefined : value;
}

function required(env: Env, name: string): string {
  return optional(env, name) ?? missing(name);
}

function requiredEmail(env: Env, name: string): string {
  const value = required(env, name);
  if (!value.includes('@') || /\s/.test(value)) {
    throw new Error(`Переменная окружения ${name} не похожа на email: ${value}`);
  }
  return value;
}

function missing(name: string): never {
  throw new Error(`Не задана обязательная переменная окружения ${name} (см. .env.example)`);
}

function parseList(env: Env, name: string): string[] | undefined {
  const raw = optional(env, name);
  if (raw === undefined) return undefined;
  const items = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
  if (items.length === 0) {
    throw new Error(`Переменная окружения ${name} пуста после разбора: ${raw}`);
  }
  return items;
}

function parseTimes(env: Env, name: string): string[] | undefined {
  const items = parseList(env, name);
  if (items === undefined) return undefined;
  for (const t of items) {
    if (!TIME_RE.test(t)) {
      throw new Error(`Переменная окружения ${name}: время должно быть HH:MM, получено "${t}"`);
    }
  }
  return items;
}

function parseCourts(env: Env, name: string): string[] | undefined {
  // Имена кортов не валидируем против COURTS — это зона engine/клиента.
  return parseList(env, name);
}

function parseDays(env: Env, name: string): number[] | undefined {
  const items = parseList(env, name);
  if (items === undefined) return undefined;
  return items.map((s) => {
    const n = Number(s);
    if (!Number.isInteger(n) || n < 0 || n > 6) {
      throw new Error(`Переменная окружения ${name}: день недели должен быть 0–6 (вс=0), получено "${s}"`);
    }
    return n;
  });
}
