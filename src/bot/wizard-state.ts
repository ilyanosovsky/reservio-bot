/**
 * Черновик мастера «➕ Добавить профиль»: машина шагов + хранилище в памяти.
 *
 * Почему в памяти, а не в кнопке и не в базе. Мастер расписаний состояния не
 * хранит вовсе — весь черновик едет в callback_data (см. src/bot/parse.ts), и
 * это правильно для галочек. Здесь же поля — ИМЯ, EMAIL и ТЕЛЕФОН живого
 * человека: класть их в callback_data значит выставить персональные данные в
 * разметку сообщения, которая переживает и пересылку, и скриншот. Отдельная
 * таблица под черновик — это те же персональные данные в базе ради диалога
 * на минуту. Поэтому Map в процессе бота.
 *
 * Плата за это честная и задокументирована в docs/wiki/Bot.md: РЕСТАРТ БОТА
 * ЧЕРНОВИК ТЕРЯЕТ. Админ на середине мастера после редеплоя начинает заново —
 * ничего необратимого он к этому моменту не сделал (профиль появляется только
 * по кнопке «✅ Создать»).
 *
 * TTL 15 минут отсчитывается от ПОСЛЕДНЕГО действия: брошенный черновик не
 * должен висеть в памяти вечно и не должен внезапно оживать через час, когда
 * админ давно забыл, что вводил.
 *
 * Здесь только механика и валидация (чистые функции + Map). Все тексты экранов
 * живут в src/bot/format.ts, как и у остальных хендлеров.
 */

import { isProfileEmail, isProfileName, isProfilePhone, normalizePhone, PROFILE_NAME_MAX } from './parse.js';

/** Брошенный черновик живёт 15 минут с последнего действия. */
export const PROFILE_DRAFT_TTL_MS = 15 * 60 * 1000;

/**
 * Шаги мастера. Первые три — текстовый ввод сообщениями, 'confirm' — экран
 * сводки с inline-кнопками «✅ Создать» / «❌ Отмена».
 */
export type ProfileStep = 'name' | 'email' | 'phone' | 'confirm';

/** Порядок шагов — он же нумерация «шаг N/4» в крошках. */
export const PROFILE_STEPS: readonly ProfileStep[] = ['name', 'email', 'phone', 'confirm'];

export interface ProfileDraft {
  step: ProfileStep;
  /** Имя игрока: уходит и в label (списки бота), и в name (контакт Reservio). */
  name: string;
  email: string;
  /** Уже нормализованный (+995XXXXXXXXX) — см. normalizePhone. */
  phone: string;
  /** Момент последнего действия в мс: от него считается TTL. */
  touchedAt: number;
}

export type StepOutcome = { ok: true; draft: ProfileDraft } | { ok: false; error: string };

export function startDraft(now: number): ProfileDraft {
  return { step: 'name', name: '', email: '', phone: '', touchedAt: now };
}

export function draftExpired(draft: ProfileDraft, now: number): boolean {
  return now - draft.touchedAt >= PROFILE_DRAFT_TTL_MS;
}

/** Номер шага для крошек: 'email' → 2. */
export function stepNumber(step: ProfileStep): number {
  return PROFILE_STEPS.indexOf(step) + 1;
}

/**
 * Ответ человека на текущий шаг. Успех — черновик, сдвинутый на следующий шаг;
 * отказ — текст причины, шаг при этом НЕ меняется (мастер переспрашивает).
 *
 * Валидация — ровно та же, что у /add_profile (общие предикаты из parse.ts):
 * иначе мастер принимал бы то, что команда отвергает, и наоборот.
 */
export function applyInput(draft: ProfileDraft, raw: string, now: number): StepOutcome {
  const text = raw.trim();
  const next = (patch: Partial<ProfileDraft>, step: ProfileStep): StepOutcome => ({
    ok: true,
    draft: { ...draft, ...patch, step, touchedAt: now },
  });

  switch (draft.step) {
    case 'name':
      if (!isProfileName(text)) {
        return { ok: false, error: `Имя пустое или длиннее ${PROFILE_NAME_MAX} символов. Напиши, как звать игрока.` };
      }
      return next({ name: text }, 'email');

    case 'email':
      // Значение в текст ошибки не подставляем: это персональные данные, а
      // сообщение остаётся в истории чата (тот же принцип, что в parse.ts).
      if (!isProfileEmail(text)) {
        return { ok: false, error: 'Не похоже на адрес почты. Нужен email аккаунта Reservio игрока.' };
      }
      return next({ email: text }, 'phone');

    case 'phone': {
      const phone = normalizePhone(text);
      if (!isProfilePhone(phone)) {
        return { ok: false, error: 'Телефон должен быть в формате +995XXXXXXXXX (только «+» и цифры).' };
      }
      return next({ phone }, 'confirm');
    }

    case 'confirm':
      // На сводке ввод не ждём: тут решают кнопки. Молча съесть сообщение
      // нельзя — человек будет думать, что бот его не услышал.
      return { ok: false, error: 'Данные собраны. Нажми «✅ Создать» или «❌ Отмена» под сводкой.' };

    default: {
      // Недостижимо: never отобьёт шаг без ветки. Мастер, молча съевший ответ,
      // выглядит как зависший бот — худший баг проекта (CLAUDE.md).
      const unhandled: never = draft.step;
      throw new Error(`шаг мастера профиля без обработки: ${JSON.stringify(unhandled)}`);
    }
  }
}

/**
 * Что нашлось в хранилище. 'expired' отличается от 'none' намеренно: про
 * протухший черновик админу надо сказать один раз («начни заново»), а на
 * сообщение без черновика бот реагировать не должен вовсе.
 */
export type DraftLookup =
  | { kind: 'active'; draft: ProfileDraft }
  | { kind: 'expired' }
  | { kind: 'none' };

/**
 * Черновики по chat_id администратора. Экземпляр создаётся в registerHandlers —
 * один на бота, а в тестах свой на каждый сценарий (глобальный синглтон
 * протекал бы между тестами).
 */
export class ProfileDraftStore {
  private readonly drafts = new Map<string, ProfileDraft>();
  /** chat_id, которым ещё не сказали, что их черновик протух. */
  private readonly expiredSeen = new Set<string>();

  /**
   * Черновик чата. Просроченный удаляется прямо здесь и возвращается ровно
   * один раз как 'expired' — второе сообщение уже увидит 'none'.
   */
  get(chatId: string, now: number): DraftLookup {
    this.prune(now);
    const draft = this.drafts.get(chatId);
    if (draft === undefined) return this.expiredSeen.delete(chatId) ? { kind: 'expired' } : { kind: 'none' };
    return { kind: 'active', draft };
  }

  start(chatId: string, now: number): ProfileDraft {
    const draft = startDraft(now);
    this.drafts.set(chatId, draft);
    this.expiredSeen.delete(chatId);
    return draft;
  }

  save(chatId: string, draft: ProfileDraft): void {
    this.drafts.set(chatId, draft);
  }

  /** Явный сброс: «❌ Отмена», /cancel, кнопка меню, успешное создание. */
  clear(chatId: string): void {
    this.drafts.delete(chatId);
    this.expiredSeen.delete(chatId);
  }

  /** Только для тестов и отладки: сколько черновиков висит в памяти. */
  get size(): number {
    return this.drafts.size;
  }

  /**
   * Выкидывает всё просроченное. Чистим не только свой chat_id: черновик,
   * брошенный другим админом, иначе остался бы в памяти процесса навсегда
   * вместе с его email и телефоном.
   *
   * Пометку «этому чату ещё не сказали, что черновик истёк» ставим ВЛАДЕЛЬЦУ
   * каждого выметенного черновика, а не только тому, кто сейчас пишет. Это не
   * инициативная рассылка: expiredSeen лишь решает, что ответить на СЛЕДУЮЩЕЕ
   * входящее от этого чата. Без этого второй админ, чей черновик вымело чужой
   * активностью, на свой же ответ по мастеру получал бы полную тишину —
   * молчаливо съеденное сообщение, худший баг проекта (CLAUDE.md).
   */
  private prune(now: number): void {
    for (const [chatId, draft] of this.drafts) {
      if (!draftExpired(draft, now)) continue;
      this.drafts.delete(chatId);
      this.expiredSeen.add(chatId);
    }
  }
}
