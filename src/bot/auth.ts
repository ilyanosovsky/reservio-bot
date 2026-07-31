/**
 * Авторизация бота: allowlist `telegram_chat_id → профиль` в Supabase.
 * Никаких паролей и OAuth (CLAUDE.md → «Мультипрофили»).
 *
 * Главный инвариант: чужому чату бот НЕ отвечает вообще ничего — ни ошибки, ни
 * «нет доступа». Ответ любого вида подтверждает, что бот жив и что чат до него
 * дотягивается; молчание не подтверждает ничего.
 *
 * Второй инвариант: входящее принимается только из ЛИЧНОГО чата (см.
 * isPrivateChat) — id группы под собой имеет не человека, а всех её участников.
 *
 * chat_id чужих в лог не пишем: это идентификатор человека. В отладке
 * (BOT_DEBUG=true, передаётся из index.ts) — можно, иначе только факт отказа.
 */

import type { MiddlewareFn, NextFunction } from 'grammy';
import type { BotContext } from './context.js';
import type { ProfileRow } from '../core/repos.js';

export interface AuthOptions {
  /** Технический лог (stdout процесса бота), не Telegram. */
  debug?: (msg: string) => void;
  /** true — печатать chat_id отказника. Только для локальной отладки. */
  exposeChatId?: boolean;
}

type ProfileLookup = Pick<ProfilesRepoLike, 'getByChatId'>;

interface ProfilesRepoLike {
  getByChatId(chatId: string): Promise<ProfileRow | null>;
}

/** Приватный чат: chat.id === from.id; для callback_query chat может отсутствовать. */
function chatIdOf(ctx: BotContext): number | undefined {
  return ctx.chat?.id ?? ctx.from?.id;
}

/**
 * Команды принимаем ТОЛЬКО из личного чата.
 *
 * chat_id группы не может быть удостоверением личности: под ним пишет любой из
 * её участников. При этом с фазы 2 TELEGRAM_CHAT_ID — это адрес ИСХОДЯЩИХ
 * отчётов, и там вполне может стоять id группы; scripts/seed-profiles.ts кладёт
 * его же в profiles.telegram_chat_id. Без этой проверки такая группа целиком
 * получила бы права владельца (в т.ч. админские). Исходящие сообщения в группу
 * это не ломает — они идут мимо бота-полл-цикла.
 */
function isPrivateChat(ctx: BotContext): boolean {
  const type = ctx.chat?.type;
  // chat нет только у апдейтов без чата (inline-режим мы не используем) —
  // тогда единственный идентификатор это from.id, а это личный чат.
  return type === undefined || type === 'private';
}

export function authMiddleware(profiles: ProfileLookup, opts: AuthOptions = {}): MiddlewareFn<BotContext> {
  const debug = opts.debug ?? ((): void => {});
  const expose = opts.exposeChatId === true;
  const who = (id: number | undefined): string => (expose ? ` (chat_id=${id ?? '?'})` : '');

  return async (ctx: BotContext, next: NextFunction): Promise<void> => {
    const chatId = chatIdOf(ctx);
    if (chatId === undefined) return;

    if (!isPrivateChat(ctx)) {
      debug(`auth: апдейт не из личного чата (${ctx.chat?.type ?? '?'}) — молчим${who(chatId)}`);
      return;
    }

    let profile: ProfileRow | null;
    try {
      profile = await profiles.getByChatId(String(chatId));
    } catch (err) {
      // Хранилище лежит — авторизовать некого. Отвечать «у нас проблемы» нельзя:
      // это ответ чужому чату. Громко пишем в лог процесса.
      debug(`auth: allowlist недоступен, апдейт отброшен${who(chatId)}: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    if (profile === null) {
      debug(`auth: чат вне allowlist — молчим${who(chatId)}`);
      return;
    }

    ctx.state = { profile };
    await next();
  };
}

/**
 * Админская ветка. Не-админ получает ТУ ЖЕ тишину, что и чужой чат: наличие
 * скрытых команд ему знать незачем (кнопки «👤 Профили» у него тоже нет).
 */
export function adminOnly(opts: { debug?: (msg: string) => void } = {}): MiddlewareFn<BotContext> {
  const debug = opts.debug ?? ((): void => {});
  return async (ctx: BotContext, next: NextFunction): Promise<void> => {
    if (ctx.state?.profile?.isAdmin !== true) {
      debug(`auth: админская команда от не-админа (профиль ${ctx.state?.profile?.id ?? '?'}) — молчим`);
      return;
    }
    await next();
  };
}
