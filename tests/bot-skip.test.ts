// Тесты «⏭ Скип» (src/bot/handlers/skip.ts).
//
// Главное здесь — асимметрия кнопки. В МЕНЮ бота она подписана ⏭/▶️ и работает
// как переключатель. В pre-drop сообщении планировщика та же callback_data
// (`skip:{date}`, контракт фазы 3) подписана «⏭ Пропустить» — и второй тап по
// ней обязан быть идемпотентным: ответ приходит только после двух запросов в
// Supabase, на мобильной сети человек легко жмёт дважды, а «сегодня не играем»
// не должно молча превращаться в «бронируем как обычно».

import { describe, expect, it, vi } from 'vitest';
import type { BotContext, BotDeps } from '../src/bot/context.js';
import { SKIP_MENU_TITLE } from '../src/bot/format.js';
import { skipAction, toggleSkip } from '../src/bot/handlers/skip.js';
import type { ProfileRow } from '../src/core/repos.js';

const DATE = '2026-08-07';

const PROFILE: ProfileRow = {
  id: 'ilya',
  label: 'Илья',
  name: 'Ilya Test',
  email: 'ilya@example.com',
  phone: '+995555000111',
  telegramChatId: '424242',
  isAdmin: false,
};

interface Harness {
  ctx: BotContext;
  deps: BotDeps;
  add: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
  reply: ReturnType<typeof vi.fn>;
  editMessageText: ReturnType<typeof vi.fn>;
  answerCallbackQuery: ReturnType<typeof vi.fn>;
}

/** `fromMenu` — тап по нашему меню; иначе кнопка pre-drop сообщения планировщика. */
function harness(opts: { fromMenu: boolean; skipped: string[] }): Harness {
  const add = vi.fn(async () => {});
  const remove = vi.fn(async () => {});
  const reply = vi.fn(async () => {});
  const editMessageText = vi.fn(async () => {});
  const answerCallbackQuery = vi.fn(async () => {});

  const text = opts.fromMenu ? `⏭ <b>${SKIP_MENU_TITLE}</b>` : '📅 План на 2026-08-07 — Илья';
  const ctx = {
    state: { profile: PROFILE },
    callbackQuery: { message: { text } },
    reply,
    editMessageText,
    answerCallbackQuery,
  } as unknown as BotContext;

  const deps = {
    skips: { listUpcoming: vi.fn(async () => opts.skipped), add, remove },
    now: () => new Date('2026-07-31T16:00:00.000Z'),
    log: (): void => {},
  } as unknown as BotDeps;

  return { ctx, deps, add, remove, reply, editMessageText, answerCallbackQuery };
}

describe('skipAction', () => {
  it('скипа нет — ставим, откуда бы ни нажали', () => {
    expect(skipAction(false, true)).toBe('add');
    expect(skipAction(false, false)).toBe('add');
  });

  it('в меню скип снимается (это переключатель)', () => {
    expect(skipAction(true, true)).toBe('remove');
  });

  it('в pre-drop сообщении второй тап НИЧЕГО не меняет', () => {
    expect(skipAction(true, false)).toBe('keep');
  });
});

describe('toggleSkip', () => {
  it('первый тап из pre-drop сообщения ставит скип и отвечает отдельным сообщением', async () => {
    const h = harness({ fromMenu: false, skipped: [] });

    await toggleSkip(h.ctx, h.deps, DATE);

    expect(h.add).toHaveBeenCalledWith('ilya', DATE);
    expect(h.remove).not.toHaveBeenCalled();
    // сообщение планировщика не перерисовываем — план вечера остаётся в истории
    expect(h.editMessageText).not.toHaveBeenCalled();
    expect(String(h.reply.mock.calls[0]![0])).toContain('пропускаем');
  });

  it('повторный тап из pre-drop сообщения скип НЕ снимает', async () => {
    const h = harness({ fromMenu: false, skipped: [DATE] });

    await toggleSkip(h.ctx, h.deps, DATE);

    expect(h.remove).not.toHaveBeenCalled();
    expect(h.add).not.toHaveBeenCalled();
    expect(String(h.reply.mock.calls[0]![0])).toContain('и так пропускаем');
  });

  it('в меню повторный тап снимает скип и перерисовывает список', async () => {
    const h = harness({ fromMenu: true, skipped: [DATE] });

    await toggleSkip(h.ctx, h.deps, DATE);

    expect(h.remove).toHaveBeenCalledWith('ilya', DATE);
    expect(h.editMessageText).toHaveBeenCalledTimes(1);
    expect(String(h.answerCallbackQuery.mock.calls[0]![0]?.text)).toContain('Играем');
  });

  it('спиннер на кнопке гасится в любом случае', async () => {
    const h = harness({ fromMenu: false, skipped: [DATE] });

    await toggleSkip(h.ctx, h.deps, DATE);

    expect(h.answerCallbackQuery).toHaveBeenCalledTimes(1);
  });
});
