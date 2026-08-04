/**
 * Единая точка превращения исключения в текст, который не стыдно показать
 * в чате и записать в лог процесса.
 *
 * Что вырезаем: guest-token брони и ключи API. Они ездят в query-string
 * (`/bookings/{id}?token=…`, PostgREST-заголовки), и сетевая ошибка fetch любит
 * процитировать URL целиком в своём message. Одного такого сообщения хватит,
 * чтобы чужой человек отменил бронь.
 */

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/token=[^\s&"'<>]+/gi, 'token=***'],
  [/apikey=[^\s&"'<>]+/gi, 'apikey=***'],
  [/bot\d{5,}:[A-Za-z0-9_-]+/g, 'bot***'],
  [/Bearer\s+[A-Za-z0-9._-]{8,}/gi, 'Bearer ***'],
  // Ключ модели (фаза 5, свободные запросы). Два правила, потому что течь он
  // может двумя путями: заголовком в тексте сетевой ошибки (`x-api-key: …`) и
  // самим значением, если чужой текст процитировал его без имени поля.
  [/x[-_]?api[-_]?key\s*[:=]\s*[^\s&"'<>,]+/gi, 'x-api-key=***'],
  [/sk-ant-[A-Za-z0-9_-]{8,}/g, 'sk-ant-***'],
];

/** Длиннее в чат не пускаем: чужие ошибки бывают на пол-экрана. */
const LIMIT = 300;

export function redactSecrets(text: string): string {
  let out = text;
  for (const [re, replacement] of SECRET_PATTERNS) out = out.replace(re, replacement);
  return out;
}

export function safeErrorText(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const clean = redactSecrets(raw);
  return clean.length <= LIMIT ? clean : `${clean.slice(0, LIMIT)}…`;
}

/** Поля, по которым различаются отказы Reservio/Supabase (обе ошибки их несут). */
export function errorFields(err: unknown): { message?: string; status?: number; code?: string } {
  const e = err as { message?: unknown; status?: unknown; code?: unknown } | null;
  return {
    ...(typeof e?.message === 'string' ? { message: redactSecrets(e.message) } : {}),
    ...(typeof e?.status === 'number' ? { status: e.status } : {}),
    ...(typeof e?.code === 'string' ? { code: e.code } : {}),
  };
}
