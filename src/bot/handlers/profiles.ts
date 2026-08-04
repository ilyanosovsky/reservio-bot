// «👤 Профили» + мастер «➕ Добавить профиль» + /add_profile и /add_rule —
// админская ветка.
//
// Доступ режет adminOnly (src/bot/auth.ts): не-админ не видит кнопки и не
// получает ответа на команду. Здесь только разбор ввода (чистые функции из
// parse.ts и wizard-state.ts) и запись в репозитории.
//
// Мастер добавления игрока. Шаги 1–3 — обычные СООБЩЕНИЯ (имя, email, телефон),
// шаг 4 — сводка с inline-кнопками. Черновик живёт в памяти процесса
// (wizard-state.ts), а не в callback_data: в кнопке эти поля означали бы
// персональные данные живого человека в разметке сообщения. Пока черновик
// активен, текстовые сообщения админа «ест» мастер; кнопки меню продолжают
// работать и попутно сбрасывают черновик — с явной подсказкой, чтобы
// недописанный ввод не пропал молча.
//
// Приватность: список профилей показывает email маской, а chat_id — хвостом.
// Введённые в мастере email и телефон видит только сам админ в сводке (он их
// только что набрал), а в ЛОГИ не попадает ни одно из этих полей — там всегда
// только id профиля. Код приглашения не логируется тем более: это секрет
// уровня guest-token (он даёт право стать профилем в боте).

import { randomBytes } from 'node:crypto';
import { InlineKeyboard } from 'grammy';
import type { BotContext, BotDeps } from '../context.js';
import type { ProfileRow, ScheduleRuleRow } from '../../core/repos.js';
import {
  PROFILE_ALREADY_BOUND_TEXT,
  PROFILE_DRAFT_CANCELED_TEXT,
  PROFILE_DRAFT_DROPPED_TEXT,
  PROFILE_DRAFT_GONE_TEXT,
  PROFILE_DRAFT_NOTHING_TEXT,
  PROFILE_GONE_TEXT,
  escapeHtml,
  formatProfileInvite,
  formatProfileSaved,
  formatProfileStep,
  formatProfileSummary,
  formatProfilesList,
  formatRuleSaved,
  inviteLink,
} from '../format.js';
import { BTN } from '../menu.js';
import {
  ADD_PROFILE_USAGE,
  ADD_RULE_USAGE,
  cbProfileCancel,
  cbProfileCreate,
  cbProfileInvite,
  cbProfileNew,
  isProfileId,
  parseAddProfile,
  parseAddRule,
} from '../parse.js';
import { edit, reply } from '../ui.js';
import { applyInput, type ProfileDraft, type ProfileDraftStore } from '../wizard-state.js';
import { chatIdOf, logOf, nowOf } from './shared.js';

const ADD_PROFILE_LABEL = '➕ Добавить профиль';

/** Сколько раз пробуем случайный id, прежде чем сдаться (см. freeProfileId). */
const ID_ATTEMPTS = 5;

/** Подпись игрока в кнопке: длинное имя растянуло бы клавиатуру в столб. */
const INVITE_LABEL_MAX = 24;

/**
 * Список профилей + кнопка мастера + по кнопке «🔗 Ссылка» на каждый профиль
 * БЕЗ привязанного чата.
 *
 * Перевыпуск нужен не для красоты. Между `claim` (код гасится) и записью
 * `telegram_chat_id` есть окно: упал Supabase — код сгорел, профиль остался
 * непривязанным навсегда (src/bot/auth.ts). То же самое, если приглашение не
 * выпустилось сразу после создания профиля. Без этой кнопки такой профиль
 * чинился бы только руками в SQL Editor.
 */
export async function showProfiles(ctx: BotContext, deps: BotDeps): Promise<void> {
  const rows = await deps.profiles.list();
  const kb = new InlineKeyboard().text(ADD_PROFILE_LABEL, cbProfileNew());
  for (const p of rows) {
    if (p.telegramChatId !== null) continue;
    // id заведомо кривой формы (правили руками в базе) в callback_data не
    // кладём: parseCallbackData его всё равно отбросит, а кнопка выглядела бы
    // рабочей. Такой профиль перевыпускается через SQL — случай экзотический.
    if (!isProfileId(p.id)) continue;
    kb.row().text(`🔗 Ссылка для ${p.label.slice(0, INVITE_LABEL_MAX)}`, cbProfileInvite(p.id));
  }
  await reply(ctx, `${formatProfilesList(rows)}\n\n${escapeHtml(ADD_PROFILE_USAGE)}`, kb);
}

/**
 * Кнопка «🔗 Ссылка»: новый одноразовый код существующему профилю.
 *
 * Профиль с УЖЕ привязанным чатом кода не получает: перепривязать его
 * приглашение всё равно не может (auth.ts проверяет telegram_chat_id), так
 * что выпуск был бы холостым, а живой код к чужому профилю — лишний секрет.
 */
export async function reissueInvite(ctx: BotContext, deps: BotDeps, profileId: string): Promise<void> {
  const profile = await deps.profiles.getById(profileId);
  if (profile === null) {
    await reply(ctx, PROFILE_GONE_TEXT);
    return;
  }
  if (profile.telegramChatId !== null) {
    await reply(ctx, PROFILE_ALREADY_BOUND_TEXT);
    return;
  }

  const code = await deps.invites.create(profile.id);
  // В логе — только id: код это секрет уровня guest-token.
  logOf(deps)(`профилю ${profile.id} выпущено новое приглашение`);
  // reply, а не edit: список профилей остаётся на экране, ссылка приходит
  // отдельным сообщением — его удобно переслать игроку целиком.
  await reply(ctx, formatProfileInvite(profile.label, inviteLink(ctx.me.username, code), true));
}

// ---------------------------------------------------------------------------
// Мастер «➕ Добавить профиль»
// ---------------------------------------------------------------------------

/**
 * Экран шага: вопрос (шаги 1–3) либо сводка с кнопками (шаг 4). `error` —
 * причина отказа над экраном.
 *
 * Экран рисуется ОДНОЙ функцией и для первого показа, и для переспроса именно
 * потому, что у сводки другой финал: «нажми кнопку» вместо «ответь сообщением»
 * — и сами кнопки. Отдельная ветка отказа неизбежно разошлась бы со сводкой и
 * выдала бы экран, который противоречит сам себе.
 */
async function renderDraft(ctx: BotContext, draft: ProfileDraft, error = ''): Promise<void> {
  if (draft.step !== 'confirm') {
    await reply(ctx, formatProfileStep(draft, error));
    return;
  }
  await reply(
    ctx,
    formatProfileSummary(draft, error),
    new InlineKeyboard().text('✅ Создать', cbProfileCreate()).text('❌ Отмена', cbProfileCancel()),
  );
}

/** Кнопка «➕ Добавить профиль»: начинаем черновик заново, что бы в нём ни было. */
export async function startProfileWizard(ctx: BotContext, deps: BotDeps, drafts: ProfileDraftStore): Promise<void> {
  const chatId = chatIdOf(ctx);
  if (chatId === undefined) return;
  const draft = drafts.start(chatId, nowOf(deps).getTime());
  logOf(deps)('мастер профиля: начат новый черновик');
  await renderDraft(ctx, draft);
}

/** Кнопка «❌ Отмена» под сводкой. */
export async function cancelProfileWizard(ctx: BotContext, deps: BotDeps, drafts: ProfileDraftStore): Promise<void> {
  const chatId = chatIdOf(ctx);
  if (chatId !== undefined) drafts.clear(chatId);
  logOf(deps)('мастер профиля: черновик отменён');
  await edit(ctx, PROFILE_DRAFT_CANCELED_TEXT);
}

/** Команда /cancel, когда черновика уже нет (активный съедает гейт ниже). */
export async function cancelNothing(ctx: BotContext): Promise<void> {
  await reply(ctx, PROFILE_DRAFT_NOTHING_TEXT);
}

const CANCEL_RE = /^\/cancel(?:@[A-Za-z0-9_]+)?$/;

function isMenuButton(text: string): boolean {
  return (Object.values(BTN) as string[]).includes(text.trim());
}

function isCommand(text: string): boolean {
  return text.trim().startsWith('/');
}

/**
 * Текстовое сообщение админа при живом мастере. Возвращает true, если сообщение
 * СЪЕДЕНО мастером (дальше его никто не разбирает), и false, если апдейт должен
 * идти по обычному пути.
 *
 * Правила ровно три:
 *  - /cancel при активном черновике — сброс, ответ и стоп;
 *  - кнопка меню или любая команда — черновик сбрасывается, но сообщение едет
 *    дальше: человек нажал «⏰ Расписание», он и должен увидеть расписание;
 *  - всё остальное — ответ на текущий шаг.
 */
export async function profileWizardGate(
  ctx: BotContext,
  deps: BotDeps,
  drafts: ProfileDraftStore,
  text: string,
): Promise<boolean> {
  const chatId = chatIdOf(ctx);
  // Черновик может быть только у админа: мастер заводится админской кнопкой.
  // Проверяем и здесь — разжалованный админ не должен дописывать свой мастер.
  if (chatId === undefined || ctx.state.profile.isAdmin !== true) return false;

  const now = nowOf(deps).getTime();
  const found = drafts.get(chatId, now);

  if (CANCEL_RE.test(text.trim())) {
    if (found.kind !== 'active') return false; // отменять нечего — ответит команда
    drafts.clear(chatId);
    logOf(deps)('мастер профиля: черновик отменён командой');
    await reply(ctx, PROFILE_DRAFT_CANCELED_TEXT);
    return true;
  }

  if (found.kind !== 'active') {
    // Протухший черновик объясняем ровно один раз и только на свободный текст:
    // на кнопке меню человек и так получит свой экран.
    if (found.kind === 'expired' && !isMenuButton(text) && !isCommand(text)) {
      await reply(ctx, PROFILE_DRAFT_GONE_TEXT);
      return true;
    }
    return false;
  }

  if (isMenuButton(text) || isCommand(text)) {
    drafts.clear(chatId);
    logOf(deps)('мастер профиля: черновик сброшен кнопкой меню');
    await reply(ctx, PROFILE_DRAFT_DROPPED_TEXT);
    return false;
  }

  const outcome = applyInput(found.draft, text, now);
  if (!outcome.ok) {
    // Шаг не сменился: перерисовываем ТОТ ЖЕ экран с причиной отказа. На сводке
    // это снова сводка со своими кнопками — иначе человек получил бы «нажми
    // кнопку» в сообщении, под которым кнопок нет.
    await renderDraft(ctx, found.draft, outcome.error);
    return true;
  }
  drafts.save(chatId, outcome.draft);
  await renderDraft(ctx, outcome.draft);
  return true;
}

/**
 * Свободный id профиля: 'p' + 8 hex (4 случайных байта). Занятость проверяем,
 * хотя вероятность столкновения ничтожна: upsert по занятому id молча переписал
 * бы чужой профиль — его контакт, а значит и все будущие брони этого человека.
 */
async function freeProfileId(deps: BotDeps): Promise<string> {
  for (let i = 0; i < ID_ATTEMPTS; i += 1) {
    const id = `p${randomBytes(4).toString('hex')}`;
    if ((await deps.profiles.getById(id)) === null) return id;
  }
  throw new Error(`не удалось подобрать свободный id профиля за ${ID_ATTEMPTS} попыток`);
}

/**
 * Кнопка «✅ Создать»: профиль + одноразовый код + ссылка админу.
 *
 * Черновик забираем ДО записи: кнопка stateless, и повторный тап (сеть
 * подтормозила — человек жмёт ещё раз) иначе завёл бы второго игрока с теми же
 * контактами и вторым кодом. Второй тап видит «черновика нет» — это честнее,
 * чем дубль в базе.
 */
export async function createProfileFromDraft(
  ctx: BotContext,
  deps: BotDeps,
  drafts: ProfileDraftStore,
): Promise<void> {
  const chatId = chatIdOf(ctx);
  if (chatId === undefined) return;

  const found = drafts.get(chatId, nowOf(deps).getTime());
  if (found.kind !== 'active') {
    await edit(ctx, PROFILE_DRAFT_GONE_TEXT);
    return;
  }
  const draft = found.draft;
  if (draft.step !== 'confirm') {
    // Кнопка из старого сообщения, а мастер уже откатили назад: показываем, где
    // человек на самом деле находится, вместо того чтобы записать полупустое.
    await reply(ctx, formatProfileStep(draft));
    return;
  }
  drafts.clear(chatId);

  const id = await freeProfileId(deps);
  const row: ProfileRow = {
    id,
    // Имя из шага 1 идёт и в подпись бота, и в контакт guest-брони: клуб видит
    // ровно то, что админ ввёл.
    label: draft.name,
    name: draft.name,
    email: draft.email,
    phone: draft.phone,
    // Чат привяжет сам игрок, перейдя по ссылке (src/bot/auth.ts).
    telegramChatId: null,
    // Админом мастер не делает никого и никогда: админ заводится только руками
    // в базе. Иначе кнопка «завести игрока» раздавала бы права на всех.
    isAdmin: false,
  };
  await deps.profiles.upsert(row);

  // Профиль уже записан. Если выпуск кода отсюда упадёт, guard покажет админу
  // ошибку, а профиль останется в списке без чата — не сиротой: ссылку ему
  // выдаст кнопка «🔗 Ссылка» (reissueInvite), проходить мастер заново незачем.
  const code = await deps.invites.create(id);
  // В логе — только id: имя, email, телефон и тем более код в stdout не пишем.
  logOf(deps)(`профиль ${id} создан мастером, выпущено приглашение`);

  // Имя бота берём из getMe, а не из конфига: тот же токен в dev и prod живёт
  // под разными именами, а ссылка с чужим именем просто не откроет этого бота.
  await edit(ctx, formatProfileInvite(row.label, inviteLink(ctx.me.username, code)));
}

// ---------------------------------------------------------------------------
// Команды-фолбэки
// ---------------------------------------------------------------------------

export async function addProfile(ctx: BotContext, deps: BotDeps, argText: string): Promise<void> {
  const parsed = parseAddProfile(argText);
  if (!parsed.ok) {
    await reply(ctx, `⚠️ ${escapeHtml(parsed.error)}`);
    return;
  }
  const input = parsed.value;

  // Флаг админа командой не выдаём и не снимаем: у существующего профиля он
  // сохраняется, у нового — false. Иначе опечатка в /add_profile разжаловала бы
  // единственного админа, и админку было бы не вернуть из Telegram.
  const existing = await deps.profiles.getById(input.id);
  const row: ProfileRow = {
    id: input.id,
    label: input.label,
    name: input.name,
    email: input.email,
    phone: input.phone,
    telegramChatId: input.telegramChatId,
    isAdmin: existing?.isAdmin ?? false,
  };
  await deps.profiles.upsert(row);
  // В лог — только id: остальное персональные данные.
  logOf(deps)(`профиль ${row.id} ${existing === null ? 'создан' : 'обновлён'}`);
  await reply(ctx, formatProfileSaved(row.id, row.label));
}

export async function addRule(ctx: BotContext, deps: BotDeps, argText: string): Promise<void> {
  const parsed = parseAddRule(argText);
  if (!parsed.ok) {
    await reply(ctx, `⚠️ ${escapeHtml(parsed.error)}`);
    return;
  }
  const input = parsed.value;

  const profile = await deps.profiles.getById(input.profileId);
  if (profile === null) {
    await reply(ctx, `⚠️ Профиля <code>${escapeHtml(input.profileId)}</code> нет. Сначала /add_profile.`);
    return;
  }

  // Повторная команда с тем же набором времён обновляет существующее правило,
  // а не плодит близнеца: иначе исправленный список кортов просто добавился бы
  // вторым правилом, и планировщик стал бы бронировать дважды.
  const existing = await deps.schedules.listByProfile(input.profileId);
  const sameTimes = existing.find((r) => r.times.join(',') === input.times.join(','));
  const rule: ScheduleRuleRow = {
    id: sameTimes?.id ?? crypto.randomUUID(),
    profileId: input.profileId,
    times: input.times,
    courts: input.courts,
    daysOfWeek: input.daysOfWeek,
    enabled: sameTimes?.enabled ?? true,
    // Режим: указан в команде — берём его; не указан — наследуем от правила,
    // которое команда обновляет (для нового 'priority', поведение до
    // мультикорта). Иначе повтор команды без пятого поля молча разжаловал бы
    // 'all' обратно в 'priority'.
    mode: input.mode ?? sameTimes?.mode ?? 'priority',
    // Имя сценария команда не спрашивает: пустой label интерфейс сам заменит
    // автоименем («20:00+21:00 · C3,C4»), а заданное в мастере — сохранит.
    label: sameTimes?.label ?? '',
  };
  await deps.schedules.upsert(rule);
  logOf(deps)(`правило ${rule.id} профиля ${rule.profileId} ${sameTimes === undefined ? 'создано' : 'обновлено'}`);
  await reply(ctx, formatRuleSaved(rule.profileId, rule.times, rule.courts, rule.daysOfWeek, rule.mode));
}

export const ADMIN_USAGE = `${ADD_PROFILE_USAGE}\n\n${ADD_RULE_USAGE}`;
