// «👤 Профили» + /add_profile + /add_rule — админская ветка.
//
// Доступ режет adminOnly (src/bot/auth.ts): не-админ не видит кнопки и не
// получает ответа на команду. Здесь только разбор аргументов (чистые функции
// из parse.ts) и запись в репозитории.
//
// Приватность: список профилей показывает email маской, а chat_id — хвостом.
// Админ и так знает своих людей, а история чата переживает и скриншоты, и
// смену владельца телефона.

import type { BotContext, BotDeps } from '../context.js';
import type { ProfileRow, ScheduleRuleRow } from '../../core/repos.js';
import { escapeHtml, formatProfileSaved, formatProfilesList, formatRuleSaved } from '../format.js';
import { ADD_PROFILE_USAGE, ADD_RULE_USAGE, parseAddProfile, parseAddRule } from '../parse.js';
import { reply } from '../ui.js';
import { logOf } from './shared.js';

export async function showProfiles(ctx: BotContext, deps: BotDeps): Promise<void> {
  const rows = await deps.profiles.list();
  await reply(ctx, `${formatProfilesList(rows)}\n\n${escapeHtml(ADD_PROFILE_USAGE)}`);
}

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
  };
  await deps.schedules.upsert(rule);
  logOf(deps)(`правило ${rule.id} профиля ${rule.profileId} ${sameTimes === undefined ? 'создано' : 'обновлено'}`);
  await reply(ctx, formatRuleSaved(rule.profileId, rule.times, rule.courts, rule.daysOfWeek));
}

export const ADMIN_USAGE = `${ADD_PROFILE_USAGE}\n\n${ADD_RULE_USAGE}`;
