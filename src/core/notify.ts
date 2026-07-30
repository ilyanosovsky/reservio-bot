// Уведомления в Telegram: отправка сообщений + форматирование отчёта о дропе.
// Модуль изолирован от движка и state — принимает только готовые данные,
// ничего не знает про Reservio API.
//
// Инвариант приватности: botToken встроен в URL Telegram API
// (`/bot{token}/sendMessage`), поэтому ЛЮБАЯ ошибка fetch (сетевая, таймаут)
// потенциально содержит токен в своём message. sendTelegram() эту ошибку
// нигде не читает и не логирует — только глотает и возвращает false.

import type { DropErrorKind, DropReport } from './booking-engine.js';

const TELEGRAM_API_BASE = 'https://api.telegram.org';
const SEND_TIMEOUT_MS = 5_000;
/** Жёсткий лимит Telegram на text: длиннее — HTTP 400, сообщение не доставлено. */
const MAX_TEXT_LEN = 4096;
const TRUNCATED_SUFFIX = '\n…(сообщение обрезано)';

/**
 * Страховка от молчаливого провала: слишком длинный текст Telegram отвергает
 * целиком, и вечерний отчёт не доходит вообще. Режем по границе строки —
 * каждая строка отчёта закрывает свои теги, поэтому HTML остаётся валидным
 * (битая разметка — тоже HTTP 400). Если первая же строка длиннее лимита,
 * спасать разметку нечем: снимаем теги, текст важнее оформления.
 */
function clampForTelegram(text: string): string {
  if (text.length <= MAX_TEXT_LEN) return text;
  const head = text
    .slice(0, MAX_TEXT_LEN - TRUNCATED_SUFFIX.length)
    // хвостовой «половинчатый» символ (эмодзи — суррогатная пара)
    .replace(/[\uD800-\uDBFF]$/, '');
  const lastNewline = head.lastIndexOf('\n');
  const body =
    lastNewline > 0
      ? head.slice(0, lastNewline)
      : head.replace(/<[^>]*>?/g, '').replace(/&[^;\s]*$/, '');
  return body + TRUNCATED_SUFFIX;
}

export interface TelegramTarget {
  botToken: string;
  chatId: string;
}

/** Читает TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID из env. null — Telegram не настроен (это не ошибка). */
export function telegramFromEnv(env: Record<string, string | undefined>): TelegramTarget | null {
  const botToken = env.TELEGRAM_BOT_TOKEN?.trim();
  const chatId = env.TELEGRAM_CHAT_ID?.trim();
  if (!botToken || !chatId) return null;
  return { botToken, chatId };
}

/**
 * Шлёт HTML-сообщение в Telegram. Никогда не бросает исключение наружу и
 * никогда не раскрывает botToken (он часть URL): при любом сбое — сеть,
 * таймаут, отказ Telegram API — просто возвращает false, саму ошибку не
 * инспектируем и никуда не пишем.
 */
export async function sendTelegram(
  t: TelegramTarget,
  text: string,
  opts: { fetchFn?: typeof fetch } = {},
): Promise<boolean> {
  const fetchFn = opts.fetchFn ?? globalThis.fetch;
  const url = `${TELEGRAM_API_BASE}/bot${t.botToken}/sendMessage`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
  try {
    const res = await fetchFn(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: t.chatId, text: clampForTelegram(text), parse_mode: 'HTML' }),
      signal: controller.signal,
    });
    return res.ok;
  } catch {
    // Намеренно не трогаем сам err: в message сетевой/AbortError-ошибки может
    // оказаться url целиком (а значит и botToken) — безопаснее его не читать.
    return false;
  } finally {
    clearTimeout(timer);
  }
}

const ERROR_KIND_RU: Record<DropErrorKind, string> = {
  SlotTaken: 'слот появился, но забронировать не успели — заняли раньше нас',
  ApiChanged: 'похоже, поменялся формат API Reservio — нужна ручная проверка',
  Timeout: 'не дождались слота до дедлайна дропа',
  AlreadyBooked: 'бронь на этот слот уже была создана раньше — ничего не делали',
};

/**
 * AlreadyBooked — это сработавшая идемпотентность, а не провал вечера: слот
 * забронирован, POST осознанно не делался. Отдавать под этот исход самый
 * тревожный маркер (❌) опасно — оператор в 21:59 читает эмодзи, а не текст, и
 * может пойти бронировать «на всякий случай» вручную, получив дубль.
 */
function marker(ok: boolean, kind?: DropErrorKind): string {
  if (ok) return '✅';
  return kind === 'AlreadyBooked' ? 'ℹ️' : '❌';
}

/** Экранирование для Telegram parse_mode=HTML: только три спецсимвола. */
function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Сколько технических деталей ошибки пускаем в сообщение. Детали приходят из
 * чужого текста (Reservio, Supabase) и могут быть длинными; без обрезки они
 * вытеснили бы последние строки — в том числе предупреждение о state.
 */
const DETAIL_LIMIT = 500;

function clampDetail(detail: string): string {
  return detail.length <= DETAIL_LIMIT ? detail : `${detail.slice(0, DETAIL_LIMIT)}…`;
}

/**
 * Компактное HTML-сообщение по одному дропу. Намеренно НЕ включает token и
 * контактные данные профиля (name/email/phone) — их в DropReport и так нет,
 * но при расширении отчёта в будущем это поле нужно продолжать игнорировать.
 */
export function formatDropReport(report: DropReport, extra: { stateWarning?: string }): string {
  const { ok, profileId, date, time, court, bookingId, msFromSeenToBooked, error } = report;

  const lines: string[] = [`${marker(ok, error?.kind)} <b>${esc(date)} ${esc(time)}</b> — профиль ${esc(profileId)}`];
  if (court) lines.push(`Корт: ${esc(court)}`);
  if (bookingId) lines.push(`Бронь: <code>${esc(bookingId)}</code>`);
  if (typeof msFromSeenToBooked === 'number') {
    lines.push(`Скорость: ${msFromSeenToBooked} мс от появления слота до брони`);
  }
  if (!ok && error) {
    // «Причина» уместна для провала; у AlreadyBooked ничего не ломалось.
    lines.push(`${error.kind === 'AlreadyBooked' ? 'Статус' : 'Причина'}: ${esc(ERROR_KIND_RU[error.kind] ?? error.kind)}`);
    if (error.detail) lines.push(`Детали: ${esc(clampDetail(error.detail))}`);
  }
  if (extra.stateWarning) lines.push(`⚠️ ${esc(extra.stateWarning)}`);

  return lines.join('\n');
}
