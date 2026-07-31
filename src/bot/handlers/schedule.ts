// «⏰ Расписание» — правила профиля (времена, приоритет кортов, дни недели).
// Тап по кнопке переключает enabled: выключенное правило планировщик не берёт.
// Сами правила добавляет админ (/add_rule) — здесь только просмотр и вкл/выкл.

import type { BotContext, BotDeps } from '../context.js';
import type { ScheduleRuleRow } from '../../core/repos.js';
import { formatRulesList, ruleButtonLabel } from '../format.js';
import { cbRuleToggle } from '../parse.js';
import { InlineKeyboard } from 'grammy';
import { answer, edit, reply } from '../ui.js';
import { logOf } from './shared.js';

function rulesKeyboard(rules: ScheduleRuleRow[]): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const r of rules) kb.text(ruleButtonLabel(r), cbRuleToggle(r.id)).row();
  return kb;
}

export async function showSchedule(ctx: BotContext, deps: BotDeps): Promise<void> {
  const rules = await deps.schedules.listByProfile(ctx.state.profile.id);
  await reply(ctx, formatRulesList(rules), rulesKeyboard(rules));
}

export async function toggleRule(ctx: BotContext, deps: BotDeps, ruleId: string): Promise<void> {
  const profileId = ctx.state.profile.id;
  // Правило ищем среди СВОИХ: id из callback_data сам по себе ничего не доказывает.
  const rules = await deps.schedules.listByProfile(profileId);
  const rule = rules.find((r) => r.id === ruleId);
  if (rule === undefined) {
    await answer(ctx, 'Правило не найдено');
    await edit(ctx, '⚠️ Такого правила у тебя нет — открой «⏰ Расписание» заново.');
    return;
  }

  const next = !rule.enabled;
  await deps.schedules.setEnabled(ruleId, next);
  logOf(deps)(`правило ${ruleId} профиля ${profileId}: enabled=${next}`);
  await answer(ctx, next ? 'Правило включено' : 'Правило выключено');

  const updated = rules.map((r) => (r.id === ruleId ? { ...r, enabled: next } : r));
  await edit(ctx, formatRulesList(updated), rulesKeyboard(updated));
}
