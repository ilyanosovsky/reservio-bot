// «⏰ Расписание» — конструктор сценариев профиля (CRUD + мастер).
//
// Экран-список: сценарии профиля (имя, дни, времена, корты, режим) и кнопки
// [вкл/выкл] [✏️ правка] [🗑 удалить] + [➕ Новый сценарий]. Мастер — пять шагов
// с хлебными крошками и «⬅️ Назад» (стиль PR #8): дни → времена → корты →
// режим → подтверждение.
//
// Серверного состояния мастера НЕТ: весь черновик (три битмаски, режим, id
// правки) едет в callback_data каждой кнопки, поэтому кнопка из вчерашнего
// сообщения работает так же, как свежая, а перезапуск бота ничего не теряет.
// Лимит Telegram — 64 байта, худший случай мастера 56 (см. src/bot/parse.ts).
//
// Владение проверяется на КАЖДОМ действии с id: id из callback_data сам по себе
// ничего не доказывает, поэтому сценарий ищется среди своих (listByProfile).

import { InlineKeyboard } from 'grammy';
import type { BotContext, BotDeps } from '../context.js';
import type { ScheduleRuleRow, ScheduleRuleInput } from '../../core/repos.js';
import {
  BOOKABLE_COURTS,
  RULE_GONE_TEXT,
  RULE_MODE_LABEL,
  SCHEDULE_HOURS,
  WEEKDAYS_SHORT,
  WEEKDAY_BUTTON_ORDER,
  draftFromRule,
  draftProblem,
  formatRuleConfirm,
  formatRuleCourtsStep,
  formatRuleDaysStep,
  formatRuleDeleteAsk,
  formatRuleDeleted,
  formatRuleModeStep,
  formatRuleSavedWizard,
  formatRuleTimesStep,
  formatRuleToggled,
  formatRulesList,
  hourLabel,
  ruleButtonLabel,
  ruleFromDraft,
  ruleTitle,
  sameRuleFields,
} from '../format.js';
import type { RuleFromDraft } from '../format.js';
import {
  DAYS_MASK_MAX,
  EMPTY_RULE_DRAFT,
  type RuleDraft,
  type RuleStep,
  bitsOf,
  cbRuleDelete,
  cbRuleDeleteAsk,
  cbRuleEdit,
  cbRuleToggle,
  cbRuleWizard,
  cbRulesList,
  toggleBit,
} from '../parse.js';
import {
  BACK_LABEL,
  CHECK_OFF,
  CHECK_ON,
  answer,
  confirmKeyboard,
  edit,
  multiSelectKeyboard,
  reply,
} from '../ui.js';
import { logOf } from './shared.js';

const DONE_LABEL = '➡️ Готово';
const NEW_RULE_LABEL = '➕ Новый сценарий';

/** Ряды кнопок мультивыбора: дни и времена короткие, корты — длинные подписи. */
const DAYS_PER_ROW = 4;
const HOURS_PER_ROW = 4;
const COURTS_PER_ROW = 2;

function rulesKeyboard(rules: ScheduleRuleRow[]): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const r of rules) {
    kb.text(ruleButtonLabel(r), cbRuleToggle(r.id)).text('✏️', cbRuleEdit(r.id)).text('🗑', cbRuleDeleteAsk(r.id)).row();
  }
  kb.text(NEW_RULE_LABEL, cbRuleWizard('days', EMPTY_RULE_DRAFT));
  return kb;
}

/**
 * Сценарий среди СВОИХ. null — чужой или уже удалённый id: показываем это явно,
 * а не молча перерисовываем экран.
 */
async function findOwnRule(deps: BotDeps, profileId: string, ruleId: string): Promise<ScheduleRuleRow | null> {
  const rules = await deps.schedules.listByProfile(profileId);
  return rules.find((r) => r.id === ruleId) ?? null;
}

export async function showSchedule(ctx: BotContext, deps: BotDeps): Promise<void> {
  const rules = await deps.schedules.listByProfile(ctx.state.profile.id);
  await reply(ctx, formatRulesList(rules), rulesKeyboard(rules));
}

/** Тот же список, но правкой сообщения: возврат из мастера и после сохранения. */
export async function showRulesList(ctx: BotContext, deps: BotDeps, header = ''): Promise<void> {
  const rules = await deps.schedules.listByProfile(ctx.state.profile.id);
  const text = header === '' ? formatRulesList(rules) : `${header}\n\n${formatRulesList(rules)}`;
  await edit(ctx, text, rulesKeyboard(rules));
}

export async function toggleRule(ctx: BotContext, deps: BotDeps, ruleId: string): Promise<void> {
  const profileId = ctx.state.profile.id;
  const rules = await deps.schedules.listByProfile(profileId);
  const rule = rules.find((r) => r.id === ruleId);
  if (rule === undefined) {
    await answer(ctx, 'Сценарий не найден');
    await edit(ctx, RULE_GONE_TEXT);
    return;
  }

  const next = !rule.enabled;
  await deps.schedules.setEnabled(ruleId, next);
  logOf(deps)(`сценарий ${ruleId} профиля ${profileId}: enabled=${next}`);
  // Выключение не отменяет дроп, уже поставленный на сегодня (см. RULE_TODAY_HINT):
  // в тосте об этом сказать негде, поэтому подсказка едет заголовком экрана.
  await answer(ctx, next ? 'Сценарий включён' : 'Сценарий выключен · на сегодня остановит только «⏭ Скип»');

  const updated = rules.map((r) => (r.id === ruleId ? { ...r, enabled: next } : r));
  await edit(ctx, `${formatRuleToggled(ruleTitle(rule), next)}\n\n${formatRulesList(updated)}`, rulesKeyboard(updated));
}

// ---------------------------------------------------------------------------
// Мастер
// ---------------------------------------------------------------------------

function daysKeyboard(draft: RuleDraft): InlineKeyboard {
  const items = WEEKDAY_BUTTON_ORDER.map((day) => ({
    text: WEEKDAYS_SHORT[day] ?? String(day),
    data: cbRuleWizard('days', { ...draft, days: toggleBit(draft.days, day) }),
    checked: (draft.days & (1 << day)) !== 0,
  }));
  const everyDay = draft.days === DAYS_MASK_MAX;
  return multiSelectKeyboard(items, DAYS_PER_ROW, [
    [
      {
        text: `${everyDay ? CHECK_ON : CHECK_OFF} каждый день`,
        data: cbRuleWizard('days', { ...draft, days: everyDay ? 0 : DAYS_MASK_MAX }),
      },
    ],
    [{ text: DONE_LABEL, data: cbRuleWizard('times', draft) }],
    [{ text: BACK_LABEL, data: cbRulesList() }],
  ]);
}

function timesKeyboard(draft: RuleDraft): InlineKeyboard {
  // Мастер предлагает 07:00–23:00, но в правиле из /add_rule бывает и другой час
  // (команда принимает любое HH:MM). Без кнопки такую галочку нельзя было бы
  // снять: правка молча возвращала бы лишнее время обратно в базу, и профиль
  // каждый день получал бы ❌-отчёт по дропу, который никому не нужен.
  const hours = [...new Set([...SCHEDULE_HOURS, ...bitsOf(draft.times)])].sort((a, b) => a - b);
  const items = hours.map((hour) => ({
    text: hourLabel(hour),
    data: cbRuleWizard('times', { ...draft, times: toggleBit(draft.times, hour) }),
    checked: (draft.times & (1 << hour)) !== 0,
  }));
  return multiSelectKeyboard(items, HOURS_PER_ROW, [
    [{ text: DONE_LABEL, data: cbRuleWizard('courts', draft) }],
    [{ text: BACK_LABEL, data: cbRuleWizard('days', draft) }],
  ]);
}

function courtsKeyboard(draft: RuleDraft): InlineKeyboard {
  const items = BOOKABLE_COURTS.map((court, i) => ({
    text: court.name,
    data: cbRuleWizard('courts', { ...draft, courts: toggleBit(draft.courts, i) }),
    checked: (draft.courts & (1 << i)) !== 0,
  }));
  return multiSelectKeyboard(items, COURTS_PER_ROW, [
    [{ text: DONE_LABEL, data: cbRuleWizard('mode', draft) }],
    [{ text: BACK_LABEL, data: cbRuleWizard('times', draft) }],
  ]);
}

/** Режим — выбор из двух: тап сразу ведёт на сводку, менять его можно оттуда. */
function modeKeyboard(draft: RuleDraft): InlineKeyboard {
  const items = (['priority', 'all'] as const).map((mode) => ({
    text: RULE_MODE_LABEL[mode],
    data: cbRuleWizard('confirm', { ...draft, mode }),
    checked: draft.mode === mode,
  }));
  return multiSelectKeyboard(items, 1, [[{ text: BACK_LABEL, data: cbRuleWizard('courts', draft) }]]);
}

function confirmKeyboardOf(draft: RuleDraft): InlineKeyboard {
  const back = cbRuleWizard('mode', draft);
  if (draftProblem(draft) !== null) return new InlineKeyboard().text(BACK_LABEL, back);
  return confirmKeyboard(cbRuleWizard('save', draft), cbRulesList(), '💾 Сохранить', back);
}

/**
 * Шаг, до которого черновик ещё не дорос. null — на запрошенный шаг пускаем.
 * Проверка нужна, потому что «Готово» нельзя погасить: без неё пустой набор
 * доехал бы до сохранения и получился бы сценарий, который никогда не сработает.
 */
function blockingStep(step: RuleStep, draft: RuleDraft): { step: RuleStep; toast: string } | null {
  const needDays = { step: 'days' as const, toast: 'Отметь хотя бы один день' };
  const needTimes = { step: 'times' as const, toast: 'Отметь хотя бы одно время' };
  const needCourts = { step: 'courts' as const, toast: 'Отметь хотя бы один корт' };
  if (step === 'days') return null;
  if (draft.days === 0) return needDays;
  if (step === 'times') return null;
  if (draft.times === 0) return needTimes;
  if (step === 'courts') return null;
  if (draft.courts === 0) return needCourts;
  return null;
}

async function renderStep(
  ctx: BotContext,
  step: RuleStep,
  draft: RuleDraft,
  previousCourts: string[] = [],
): Promise<void> {
  switch (step) {
    case 'days':
      return edit(ctx, formatRuleDaysStep(draft), daysKeyboard(draft));
    case 'times':
      return edit(ctx, formatRuleTimesStep(draft), timesKeyboard(draft));
    case 'courts':
      return edit(ctx, formatRuleCourtsStep(draft), courtsKeyboard(draft));
    case 'mode':
      return edit(ctx, formatRuleModeStep(draft), modeKeyboard(draft));
    case 'confirm':
    case 'save':
      return edit(ctx, formatRuleConfirm(draft, previousCourts), confirmKeyboardOf(draft));
    default: {
      // Недостижимо: never отобьёт шаг без ветки. Молча мёртвая кнопка мастера
      // выглядела бы как «бот завис» — худший баг проекта (CLAUDE.md).
      const unhandled: never = step;
      throw new Error(`шаг мастера без экрана: ${JSON.stringify(unhandled)}`);
    }
  }
}

/** Кнопка ✏️: черновик собирается из сохранённого сценария, мастер идёт с шага 1. */
export async function editRule(ctx: BotContext, deps: BotDeps, ruleId: string): Promise<void> {
  const rule = await findOwnRule(deps, ctx.state.profile.id, ruleId);
  if (rule === null) {
    await edit(ctx, RULE_GONE_TEXT);
    return;
  }
  await renderStep(ctx, 'days', draftFromRule(rule));
}

export async function ruleWizardStep(
  ctx: BotContext,
  deps: BotDeps,
  step: RuleStep,
  draft: RuleDraft,
): Promise<void> {
  const blocked = blockingStep(step, draft);
  if (blocked !== null) {
    await answer(ctx, blocked.toast);
    await renderStep(ctx, blocked.step, draft);
    return;
  }

  // Сводка и запись обязаны показывать один и тот же порядок приоритета,
  // поэтому правимый сценарий читается уже на шаге подтверждения.
  let existing: ScheduleRuleRow | null = null;
  if (draft.ruleId !== null && (step === 'confirm' || step === 'save')) {
    existing = await findOwnRule(deps, ctx.state.profile.id, draft.ruleId);
    if (existing === null) {
      await answer(ctx, 'Сценарий не найден');
      await edit(ctx, RULE_GONE_TEXT);
      return;
    }
  }

  if (step !== 'save') {
    await answer(ctx);
    await renderStep(ctx, step, draft, existing?.courts ?? []);
    return;
  }

  await saveRule(ctx, deps, draft, existing);
}

async function saveRule(
  ctx: BotContext,
  deps: BotDeps,
  draft: RuleDraft,
  existing: ScheduleRuleRow | null,
): Promise<void> {
  const profileId = ctx.state.profile.id;
  // Владение проверяет вызывающий (ruleWizardStep), но инвариант «правим только
  // найденный среди своих сценарий» держим и здесь: подделанная callback_data
  // не должна переписать чужое правило ни при каком порядке вызовов.
  if (draft.ruleId !== null && existing === null) {
    await answer(ctx, 'Сценарий не найден');
    await edit(ctx, RULE_GONE_TEXT);
    return;
  }

  const fields = ruleFromDraft(draft, existing?.courts ?? []);

  // Кнопка «💾 Сохранить» stateless: у нового сценария id в её callback_data
  // пустой, поэтому повторный тап (сеть подтормозила — человек жмёт ещё раз)
  // уходил бы во второй INSERT и плодил близнеца. Ищем среди своих сценарий,
  // не отличающийся от черновика ничем, и обновляем его — та же защита, что у
  // /add_rule («иначе планировщик стал бы бронировать дважды»).
  const twin = existing ?? (await findTwinRule(deps, profileId, fields));

  // В колонку label пишем ТОЛЬКО имя, заданное человеком. Автоимя — производная
  // от времён и кортов: сохранив его, мы заморозили бы старую подпись, и после
  // правки список показывал бы «20:00+21:00 · C3» у сценария, который давно про
  // 19:00 и Court 4 (кнопки врали бы, и выключали бы не тот сценарий).
  const label = twin === null ? '' : twin.label.trim();
  // На экранах имя всё равно нужно: пустое — значит автоимя (ruleTitle делает
  // ровно это в списке).
  const saved: RuleFromDraft = { ...fields, label: label === '' ? fields.label : label };

  const input: ScheduleRuleInput = {
    ...(twin === null ? {} : { id: twin.id }),
    profileId,
    times: fields.times,
    courts: fields.courts,
    daysOfWeek: fields.daysOfWeek,
    mode: fields.mode,
    label,
    // Правка сохраняет вкл/выкл, создание — всегда включает. Именно existing, а
    // не twin: если человек заново собрал сценарий, совпавший с выключенным,
    // он ждёт работающий сценарий, а не молча выключенный.
    enabled: existing?.enabled ?? true,
  };
  await deps.schedules.upsert(input);
  const created = twin === null;
  logOf(deps)(`сценарий профиля ${profileId} ${created ? 'создан' : 'обновлён'} (${fields.mode})`);

  await answer(
    ctx,
    created ? 'Сценарий создан' : existing === null ? 'Такой сценарий уже был — обновили его' : 'Сценарий обновлён',
  );
  await showRulesList(ctx, deps, formatRuleSavedWizard(saved, created));
}

/**
 * Свой сценарий, совпадающий с черновиком по смыслу (времена, корты, дни,
 * режим). null — такого нет, значит это действительно новый сценарий.
 */
async function findTwinRule(deps: BotDeps, profileId: string, fields: RuleFromDraft): Promise<ScheduleRuleRow | null> {
  const rules = await deps.schedules.listByProfile(profileId);
  return rules.find((r) => sameRuleFields(r, fields)) ?? null;
}

// ---------------------------------------------------------------------------
// Удаление
// ---------------------------------------------------------------------------

export async function askDeleteRule(ctx: BotContext, deps: BotDeps, ruleId: string): Promise<void> {
  const rule = await findOwnRule(deps, ctx.state.profile.id, ruleId);
  if (rule === null) {
    await edit(ctx, RULE_GONE_TEXT);
    return;
  }
  await edit(ctx, formatRuleDeleteAsk(rule), confirmKeyboard(cbRuleDelete(rule.id), cbRulesList(), '🗑 Удалить'));
}

export async function deleteRule(ctx: BotContext, deps: BotDeps, ruleId: string): Promise<void> {
  const profileId = ctx.state.profile.id;
  const rule = await findOwnRule(deps, profileId, ruleId);
  if (rule === null) {
    await answer(ctx, 'Сценарий не найден');
    await edit(ctx, RULE_GONE_TEXT);
    return;
  }

  const title = ruleTitle(rule);
  await deps.schedules.remove(rule.id, profileId);
  logOf(deps)(`сценарий ${rule.id} профиля ${profileId} удалён`);
  await answer(ctx, 'Сценарий удалён');
  await showRulesList(ctx, deps, formatRuleDeleted(title));
}
