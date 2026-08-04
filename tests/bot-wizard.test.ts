// Машина шагов мастера «➕ Добавить профиль» (src/bot/wizard-state.ts).
//
// Здесь только чистая механика: переходы, валидация, TTL и хранилище черновиков.
// Ни grammY, ни Supabase — тексты экранов живут в format.ts, а полный путь по
// кнопкам проверяет tests/bot-invite.test.ts.
//
// Почему это вообще отдельный тест. Черновик мастера — единственное состояние
// бота в ПАМЯТИ процесса (всё остальное в Supabase). У него два неочевидных
// свойства, которые легко сломать правкой: он протухает по времени последнего
// действия, и он живёт под chat_id администратора, а не глобально. Первое
// делает мастер безопасным (брошенные email и телефон не висят в памяти
// вечно), второе — многоадминным.

import { describe, expect, it } from 'vitest';
import {
  PROFILE_DRAFT_TTL_MS,
  PROFILE_STEPS,
  ProfileDraftStore,
  applyInput,
  draftExpired,
  startDraft,
  stepNumber,
  type ProfileDraft,
} from '../src/bot/wizard-state.js';
import { PROFILE_NAME_MAX } from '../src/bot/parse.js';

/** Момент «сейчас» в тестах — любой, лишь бы не зависеть от часов машины. */
const T0 = Date.UTC(2026, 7, 4, 12, 0, 0);

const ADMIN = '424242';
const OTHER_ADMIN = '515151';

/** Успешный переход или падение теста с причиной отказа. */
function step(draft: ProfileDraft, text: string, now = T0): ProfileDraft {
  const outcome = applyInput(draft, text, now);
  if (!outcome.ok) throw new Error(`ожидался успех шага ${draft.step}, получено: ${outcome.error}`);
  return outcome.draft;
}

/** Текст отказа или падение теста, если шаг неожиданно принял ввод. */
function refuse(draft: ProfileDraft, text: string, now = T0): string {
  const outcome = applyInput(draft, text, now);
  if (outcome.ok) throw new Error(`ожидался отказ на шаге ${draft.step}, ввод принят`);
  return outcome.error;
}

describe('мастер профиля: переходы шагов', () => {
  it('шаги идут ровно name → email → phone → confirm', () => {
    expect(PROFILE_STEPS).toEqual(['name', 'email', 'phone', 'confirm']);
  });

  it('черновик начинается с первого шага и пустых полей', () => {
    const draft = startDraft(T0);
    expect(draft).toEqual({ step: 'name', name: '', email: '', phone: '', touchedAt: T0 });
  });

  it('три ответа собирают профиль и приводят к сводке', () => {
    const done = step(step(step(startDraft(T0), 'Аня'), 'anna@example.com'), '+995555111222');

    expect(done).toMatchObject({
      step: 'confirm',
      name: 'Аня',
      email: 'anna@example.com',
      phone: '+995555111222',
    });
  });

  it('пробелы по краям ответа срезаются', () => {
    const done = step(step(step(startDraft(T0), '  Аня  '), '  anna@example.com  '), '  +995555111222  ');

    expect(done.name).toBe('Аня');
    expect(done.email).toBe('anna@example.com');
    expect(done.phone).toBe('+995555111222');
  });

  it('телефон нормализуется: пробелы, скобки и дефисы уходят', () => {
    const done = step(step(step(startDraft(T0), 'Аня'), 'anna@example.com'), '+995 (555) 111-222');
    expect(done.phone).toBe('+995555111222');
  });

  it('нумерация шагов для крошек — 1..4', () => {
    expect(stepNumber('name')).toBe(1);
    expect(stepNumber('email')).toBe(2);
    expect(stepNumber('phone')).toBe(3);
    expect(stepNumber('confirm')).toBe(4);
  });

  it('каждый принятый ответ обновляет отметку времени (TTL идёт от последнего действия)', () => {
    const first = startDraft(T0);
    const second = step(first, 'Аня', T0 + 60_000);

    expect(second.touchedAt).toBe(T0 + 60_000);
  });
});

describe('мастер профиля: валидация шагов', () => {
  it('пустое имя не принимается, шаг не сдвигается', () => {
    const draft = startDraft(T0);
    expect(refuse(draft, '   ')).toContain('пустое');
    // Черновик остался прежним: мастер переспросит тот же вопрос.
    expect(draft.step).toBe('name');
  });

  it('слишком длинное имя не принимается, граница включительно', () => {
    const draft = startDraft(T0);
    expect(step(draft, 'я'.repeat(PROFILE_NAME_MAX)).step).toBe('email');
    expect(refuse(draft, 'я'.repeat(PROFILE_NAME_MAX + 1))).toContain(String(PROFILE_NAME_MAX));
  });

  it('не-email отвергается, и САМО значение в текст ошибки не попадает', () => {
    // Ошибка остаётся в истории чата: подставлять туда персональные данные
    // нельзя, тот же принцип, что в parse.ts у /add_profile.
    const draft = step(startDraft(T0), 'Аня');
    const error = refuse(draft, 'anna(at)example.com');

    expect(error).toContain('почты');
    expect(error).not.toContain('anna');
  });

  it('телефон не в формате +995XXXXXXXXX отвергается, значение не цитируется', () => {
    const draft = step(step(startDraft(T0), 'Аня'), 'anna@example.com');
    const error = refuse(draft, '8 900 111 22 33');

    expect(error).toContain('+995');
    expect(error).not.toContain('900');
  });

  it('отказ не меняет уже собранные поля', () => {
    const draft = step(step(startDraft(T0), 'Аня'), 'anna@example.com');
    applyInput(draft, 'мусор', T0 + 1000);

    expect(draft).toMatchObject({ step: 'phone', name: 'Аня', email: 'anna@example.com', touchedAt: T0 });
  });

  it('на сводке текст не съедается молча — мастер объясняет, что дальше кнопки', () => {
    // Молчаливо проглоченное сообщение выглядит как зависший бот: худший баг
    // проекта (CLAUDE.md → инвариант наблюдаемости).
    const done = step(step(step(startDraft(T0), 'Аня'), 'anna@example.com'), '+995555111222');
    const error = refuse(done, 'ну давай уже');

    expect(error).toContain('Создать');
    expect(error).toContain('Отмена');
  });
});

describe('мастер профиля: TTL черновика', () => {
  it('свежий черновик не протух', () => {
    expect(draftExpired(startDraft(T0), T0)).toBe(false);
    expect(draftExpired(startDraft(T0), T0 + PROFILE_DRAFT_TTL_MS - 1)).toBe(false);
  });

  it('ровно на TTL черновик уже протух', () => {
    expect(draftExpired(startDraft(T0), T0 + PROFILE_DRAFT_TTL_MS)).toBe(true);
  });

  it('TTL — 15 минут', () => {
    expect(PROFILE_DRAFT_TTL_MS).toBe(15 * 60 * 1000);
  });

  it('TTL считается от ПОСЛЕДНЕГО действия, а не от начала мастера', () => {
    // Иначе долгий, но живой диалог обрывался бы на середине.
    const late = step(startDraft(T0), 'Аня', T0 + 14 * 60_000);
    expect(draftExpired(late, T0 + 20 * 60_000)).toBe(false);
    expect(draftExpired(late, T0 + 30 * 60_000)).toBe(true);
  });
});

describe('ProfileDraftStore', () => {
  it('без черновика — kind: none (боту реагировать не на что)', () => {
    const store = new ProfileDraftStore();
    expect(store.get(ADMIN, T0)).toEqual({ kind: 'none' });
  });

  it('начатый черновик находится по chat_id', () => {
    const store = new ProfileDraftStore();
    const draft = store.start(ADMIN, T0);

    expect(store.get(ADMIN, T0)).toEqual({ kind: 'active', draft });
  });

  it('черновики разных админов не смешиваются', () => {
    const store = new ProfileDraftStore();
    store.start(ADMIN, T0);
    const other = store.start(OTHER_ADMIN, T0);
    store.save(OTHER_ADMIN, step(other, 'Аня'));

    const mine = store.get(ADMIN, T0);
    const theirs = store.get(OTHER_ADMIN, T0);
    expect(mine.kind === 'active' && mine.draft.step).toBe('name');
    expect(theirs.kind === 'active' && theirs.draft.name).toBe('Аня');
  });

  it('save заменяет черновик чата', () => {
    const store = new ProfileDraftStore();
    const draft = store.start(ADMIN, T0);
    store.save(ADMIN, step(draft, 'Аня'));

    const found = store.get(ADMIN, T0);
    expect(found.kind === 'active' && found.draft).toMatchObject({ step: 'email', name: 'Аня' });
  });

  it('повторный start начинает мастер с чистого листа', () => {
    // Кнопка «➕ Добавить профиль» посреди недописанного мастера — это «начать
    // заново», а не «продолжить с чужими полями».
    const store = new ProfileDraftStore();
    store.save(ADMIN, step(store.start(ADMIN, T0), 'Аня'));
    store.start(ADMIN, T0 + 1000);

    const found = store.get(ADMIN, T0 + 1000);
    expect(found.kind === 'active' && found.draft).toMatchObject({ step: 'name', name: '' });
  });

  it('clear убирает черновик', () => {
    const store = new ProfileDraftStore();
    store.start(ADMIN, T0);
    store.clear(ADMIN);

    expect(store.get(ADMIN, T0)).toEqual({ kind: 'none' });
    expect(store.size).toBe(0);
  });

  it('протухший черновик отдаётся как expired РОВНО ОДИН раз', () => {
    // Про истёкший мастер надо сказать один раз («начни заново»); на следующее
    // сообщение бот уже молчит, как на любой посторонний текст.
    const store = new ProfileDraftStore();
    store.start(ADMIN, T0);

    const later = T0 + PROFILE_DRAFT_TTL_MS;
    expect(store.get(ADMIN, later)).toEqual({ kind: 'expired' });
    expect(store.get(ADMIN, later)).toEqual({ kind: 'none' });
  });

  it('протухший черновик удаляется из памяти (email и телефон не висят вечно)', () => {
    const store = new ProfileDraftStore();
    store.save(ADMIN, step(step(store.start(ADMIN, T0), 'Аня'), 'anna@example.com'));
    expect(store.size).toBe(1);

    store.get(ADMIN, T0 + PROFILE_DRAFT_TTL_MS);

    expect(store.size).toBe(0);
  });

  it('брошенный черновик ЧУЖОГО админа вычищается — и владельцу это объяснят, когда он напишет', () => {
    // Чистим всю Map, иначе мастер, брошенный другим админом, висел бы в памяти
    // процесса навсегда вместе с персональными данными игрока.
    //
    // Но пометка «истёк» ставится ВЛАДЕЛЬЦУ каждого выметенного черновика, а не
    // только тому, кто сейчас пишет: иначе сосед, вернувшись к своему мастеру,
    // получил бы на ответ полную тишину — сообщение съедено, объяснять уже
    // нечем. Инициативной рассылки тут нет: пометка сработает только на его
    // собственное следующее сообщение.
    const store = new ProfileDraftStore();
    store.start(OTHER_ADMIN, T0);
    store.start(ADMIN, T0 + PROFILE_DRAFT_TTL_MS);

    // Пишет ADMIN — чистка заодно выкидывает протухший черновик соседа.
    expect(store.get(ADMIN, T0 + PROFILE_DRAFT_TTL_MS)).toMatchObject({ kind: 'active' });
    expect(store.size).toBe(1);
    // Сосед напишет сам — и узнает про истёкший черновик. Ровно один раз.
    expect(store.get(OTHER_ADMIN, T0 + PROFILE_DRAFT_TTL_MS)).toEqual({ kind: 'expired' });
    expect(store.get(OTHER_ADMIN, T0 + PROFILE_DRAFT_TTL_MS)).toEqual({ kind: 'none' });
  });

  it('чужая активность не съедает объяснение: истёкший черновик ждёт своего владельца', () => {
    // Регрессия: prune проходит по ВСЕЙ Map, и раньше пометку «истёк» получал
    // только пишущий сейчас чат. Черновик соседа при этом удалялся молча, и на
    // свой же ответ по мастеру сосед не получал НИЧЕГО.
    const store = new ProfileDraftStore();
    store.save(OTHER_ADMIN, step(store.start(OTHER_ADMIN, T0), 'Аня'));

    const later = T0 + PROFILE_DRAFT_TTL_MS;
    // Другой админ просто что-то делает — этого хватает, чтобы вымести черновик.
    store.start(ADMIN, later);
    store.get(ADMIN, later);
    expect(store.size).toBe(1);

    expect(store.get(OTHER_ADMIN, later)).toEqual({ kind: 'expired' });
  });

  it('после подсказки об истечении новый мастер начинается с чистого листа', () => {
    // Пометка «истёк» не должна пережить кнопку «➕ Добавить профиль».
    const store = new ProfileDraftStore();
    store.start(OTHER_ADMIN, T0);
    store.get(ADMIN, T0 + PROFILE_DRAFT_TTL_MS); // чужая активность вымела черновик

    store.start(OTHER_ADMIN, T0 + PROFILE_DRAFT_TTL_MS);

    const found = store.get(OTHER_ADMIN, T0 + PROFILE_DRAFT_TTL_MS);
    expect(found.kind === 'active' && found.draft).toMatchObject({ step: 'name', name: '' });
  });

  it('после истечения мастер начинается заново и живёт своей жизнью', () => {
    // Полный цикл «протух → начал заново»: у нового черновика свой TTL, и
    // старые поля в него не протекают.
    const store = new ProfileDraftStore();
    store.save(ADMIN, step(store.start(ADMIN, T0), 'Аня'));

    const later = T0 + PROFILE_DRAFT_TTL_MS;
    expect(store.get(ADMIN, later)).toEqual({ kind: 'expired' });

    const fresh = store.start(ADMIN, later);
    expect(fresh).toMatchObject({ step: 'name', name: '' });
    store.save(ADMIN, step(fresh, 'Нина', later));

    // TTL нового черновика отсчитывается от later, а не от T0.
    const found = store.get(ADMIN, later + PROFILE_DRAFT_TTL_MS - 1);
    expect(found.kind === 'active' && found.draft).toMatchObject({ step: 'email', name: 'Нина' });
    expect(store.get(ADMIN, later + PROFILE_DRAFT_TTL_MS)).toEqual({ kind: 'expired' });
  });
});
