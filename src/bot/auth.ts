/**
 * Авторизация бота: allowlist `telegram_chat_id → профиль` в Supabase.
 * Никаких паролей и OAuth (CLAUDE.md → «Мультипрофили»).
 *
 * Главный инвариант: чужому чату бот НЕ отвечает вообще ничего — ни ошибки, ни
 * «нет доступа». Ответ любого вида подтверждает, что бот жив и что чат до него
 * дотягивается; молчание не подтверждает ничего.
 *
 * Единственное исключение — переход по одноразовой ссылке-приглашению
 * (inviteMiddleware ниже): без него нового игрока нельзя завести вообще, ведь
 * его chat_id взять неоткуда, пока он боту не написал, а на его сообщение бот
 * обязан молчать. Исключение узкое до предела и разбирается там же.
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
import { parseInviteStart } from './parse.js';
import { sendWelcome } from './welcome.js';

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

/** Что нужно приглашению: погасить код и привязать чат к профилю. */
export interface InviteDeps {
  invites: {
    claim(code: string, chatId: string): Promise<{ profileId: string } | null>;
  };
  profiles: {
    getByChatId(chatId: string): Promise<ProfileRow | null>;
    getById(id: string): Promise<ProfileRow | null>;
    upsert(profile: ProfileRow): Promise<void>;
  };
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
 * Приём ссылки-приглашения — ЕДИНСТВЕННОЕ исключение из инварианта тишины.
 *
 * Стоит В СБОРКЕ ДО authMiddleware (src/bot/setup.ts): чат, который переходит
 * по ссылке, профиля ещё не имеет, и общий allowlist отбросил бы его молча,
 * не дав приглашению ни единого шанса.
 *
 * Исключение сделано настолько узким, насколько возможно. Ответ уходит только
 * если совпало ВСЁ сразу:
 *  - личный чат (id группы — не удостоверение личности, см. isPrivateChat);
 *  - текст ровно `/start inv_<code>`, код нужного формата (parseInviteStart);
 *  - у этого chat_id ещё нет профиля (иначе это обычный /start, а код цел);
 *  - код погашен АТОМАРНО и впервые (InvitesRepo.claim);
 *  - профиль под кодом существует и его telegram_chat_id ещё свободен.
 *
 * Любое «не совпало» — та же тишина, что у чужого чата: перебирающий не должен
 * по разнице в поведении понять, что он угадал живой код (или что бот вообще
 * жив). Молчат и все ошибки: fail-closed, факт — в лог процесса.
 */
export function inviteMiddleware(deps: InviteDeps, opts: AuthOptions = {}): MiddlewareFn<BotContext> {
  const debug = opts.debug ?? ((): void => {});

  return async (ctx: BotContext, next: NextFunction): Promise<void> => {
    const code = parseInviteStart(ctx.message?.text);
    // Не приглашение — обычный апдейт: решать про него будет authMiddleware.
    if (code === null) return next();

    const chatId = chatIdOf(ctx);
    if (chatId === undefined || !isPrivateChat(ctx)) {
      debug('invite: ссылка пришла не из личного чата — молчим');
      return;
    }

    try {
      // Свой чат приглашение не тратит: это обычный /start. Иначе пересланная
      // самому себе ссылка сожгла бы код и ничего не изменила.
      const own = await deps.profiles.getByChatId(String(chatId));
      if (own !== null) {
        debug(`invite: чат уже привязан к профилю ${own.id} — обрабатываю как обычный /start`);
        return next();
      }

      const claimed = await deps.invites.claim(code, String(chatId));
      if (claimed === null) {
        // Кода нет ИЛИ он уже погашен — снаружи неразличимо, и это намеренно.
        debug('invite: код не подошёл (нет такого или уже использован) — молчим');
        return;
      }

      const profile = await deps.profiles.getById(claimed.profileId);
      if (profile === null) {
        debug(`invite: код погашен, но профиля ${claimed.profileId} больше нет — молчим`);
        return;
      }
      if (profile.telegramChatId !== null) {
        // Профиль уже кому-то принадлежит: перепривязка отобрала бы у живого
        // человека доступ к его броням. Код при этом уже сгорел — и правильно.
        debug(`invite: профиль ${profile.id} уже привязан к чату — приглашение мёртвое, молчим`);
        return;
      }

      const bound: ProfileRow = { ...profile, telegramChatId: String(chatId) };
      await deps.profiles.upsert(bound);
      // В лог — только id профиля: chat_id и контакты это персональные данные.
      debug(`invite: чат привязан к профилю ${profile.id}`);
      await sendWelcome(ctx, bound, true);
    } catch (err) {
      // Молчим и здесь: ответ «у нас проблемы» — это ответ чату, который пока
      // никто. Если упало ПОСЛЕ claim, код уже сгорел, а привязки нет: профиль
      // остаётся без чата, и чинится это кнопкой «🔗 Ссылка» в «👤 Профили»
      // (перевыпуск кода, handlers/profiles.ts → reissueInvite). Игрок при
      // этом не узнает ничего — поэтому пишем в лог громко.
      debug(`invite: приглашение не отработало — ${err instanceof Error ? err.message : String(err)}`);
    }
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
