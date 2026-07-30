/**
 * SPIKE: Reservio API v2 — Padel Port Batumi
 * Проверка пути A: availability → (опционально) бронь Court 3 на 31.07.2026 16:00
 *
 * Запуск (Node 20+, без зависимостей):
 *   npx tsx spike-reservio.ts                      # только показать слоты
 *   npx tsx spike-reservio.ts --book               # реально забронировать 16:00 (осторожно!)
 *   npx tsx spike-reservio.ts --date 2026-08-01 --time 20:00
 *
 * .env / переменные окружения (для --book обязательны CLIENT_*):
 *   CLIENT_NAME="Ilya ..."
 *   CLIENT_EMAIL="you@example.com"     # email твоего Reservio-аккаунта — бронь привяжется к нему
 *   CLIENT_PHONE="+995..."
 *   RESERVIO_API_TOKEN=...             # опционально: если API вернёт 401 без токена
 *
 * Протокол извлечён из github.com/patrik-meixner/reservio-mcp (Reservio API v2, JSON:API).
 */

// мини-загрузчик .env (tsx не читает его сам; без зависимостей)
import { readFileSync } from "node:fs";
try {
  for (const line of readFileSync(new URL(".env", import.meta.url), "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch {}

const API = "https://api.reservio.com/v2";
const BUSINESS_ID = "1e32bd0a-0d5c-4e30-9788-ea488e713c4d"; // Padel Port Batumi (подтверждён API 30.07.2026; b442467d... оказался id картинки)

// serviceId каждого корта (каждый корт = отдельный service)
const COURTS: Record<string, string> = {
  "Padel Court 1": "6dcc4d1f-c73b-4a35-ad3a-3ede2cb321a6",
  "Padel Court 2": "c36479d3-8201-4d80-9822-e9c08014468b",
  "Padel Court 3": "303f3adf-8a99-4c1f-89fe-f9a9b56a620b",
  "Padel Court 4": "1dfea382-0fe9-42de-a3d0-36d82629b071",
  "Park Court 1": "24481fd5-3320-4133-b762-03f13f1b200e",
  "Park Court 2": "09922dde-639d-4bdc-8b53-73077a57cca2",
};

const TZ_OFFSET = "+04:00"; // Asia/Tbilisi, без DST
const DURATION_SEC = 59 * 60; // слот 59 минут (из виджета)

// ---------- args ----------
const args = process.argv.slice(2);
const flag = (n: string) => args.includes(n);
const opt = (n: string, d: string) => {
  const i = args.indexOf(n);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const DATE = opt("--date", "2026-07-31");
const TIME = opt("--time", "16:00");
const COURT = opt("--court", "Padel Court 3");
const DO_BOOK = flag("--book");
const CANCEL_ID = opt("--cancel", "");     // --cancel <bookingId> [--token <token>]
const CANCEL_TOKEN = opt("--token", "");

// ---------- http ----------
async function req(path: string, init: RequestInit = {}, withAuth = false) {
  const headers: Record<string, string> = {
    Accept: "application/vnd.api+json",
    ...(init.body ? { "Content-Type": "application/vnd.api+json" } : {}),
  };
  const token = process.env.RESERVIO_API_TOKEN;
  if (withAuth && token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`${API}${path}`, { ...init, headers });
  const text = await res.text();
  return { status: res.status, ok: res.ok, body: text ? JSON.parse(text) : null };
}

// пробуем без auth; при 401/403 повторяем с токеном
async function smartReq(path: string, init: RequestInit = {}) {
  let r = await req(path, init, false);
  if ((r.status === 401 || r.status === 403) && process.env.RESERVIO_API_TOKEN) {
    console.log(`  [auth] ${r.status} без токена → повтор с Bearer`);
    r = await req(path, init, true);
  }
  return r;
}

// ---------- cancel ----------
// Подтверждено 30.07.2026 (перехват из веб-флоу отмены):
//   PATCH {host}/v2/businesses/{b}/bookings/{id}?token={token}
//   body: { data: { type: "booking", id, attributes: { state: "canceled" } } }
// ВАЖНО: state = "canceled" (одна L). Вариант "cancelled" API молча игнорирует (200-эхо).
// Веб-флоу ходит на accounts.reservio.com/api/v2 — пробуем api.reservio.com/v2, затем accounts.
async function cancelBooking(bookingId: string, token: string) {
  console.log(`\n=== CANCEL: booking ${bookingId} ===\n`);
  const body = JSON.stringify({ data: { type: "booking", id: bookingId, attributes: { state: "canceled" } } });
  for (const host of ["https://api.reservio.com/v2", "https://accounts.reservio.com/api/v2"]) {
    const url = `${host}/businesses/${BUSINESS_ID}/bookings/${bookingId}?token=${token}`;
    const res = await fetch(url, {
      method: "PATCH",
      headers: { Accept: "application/vnd.api+json", "Content-Type": "application/vnd.api+json" },
      body,
    });
    const j = await res.json().catch(() => null);
    const state = j?.data?.attributes?.state;
    console.log(`  PATCH ${host} → ${res.status}, state=${state}`);
    if (res.ok && state === "canceled") {
      console.log(`  ✅ Отменено (host: ${host})`);
      return true;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  console.log("  ✗ Отмена не сработала ни на одном хосте");
  return false;
}

// ---------- steps ----------
async function main() {
  if (CANCEL_ID) {
    if (!CANCEL_TOKEN) throw new Error("--cancel требует --token <token из ответа POST /bookings>");
    await cancelBooking(CANCEL_ID, CANCEL_TOKEN);
    return;
  }
  console.log(`\n=== SPIKE: ${COURT} · ${DATE} ${TIME} (${TZ_OFFSET}) ===\n`);
  const serviceId = COURTS[COURT];
  if (!serviceId) throw new Error(`Неизвестный корт: ${COURT}`);

  // 1. Инфо о бизнесе (smoke-test доступности API)
  console.log("1) GET /businesses/{id}");
  const biz = await smartReq(`/businesses/${BUSINESS_ID}`);
  console.log(`   → ${biz.status}`, biz.ok ? `✓ ${biz.body?.data?.attributes?.name}` : JSON.stringify(biz.body).slice(0, 300));

  // 2. Ресурсы (маппинг «Court 3» resource ↔ service)
  console.log("\n2) GET /businesses/{id}/resources");
  const rs = await smartReq(`/businesses/${BUSINESS_ID}/resources`);
  if (rs.ok) {
    for (const r of rs.body.data ?? [])
      console.log(`   • ${r.attributes?.name}  → resourceId=${r.id}`);
  } else console.log(`   → ${rs.status}`, JSON.stringify(rs.body).slice(0, 300));

  // 3. Слоты на дату
  console.log(`\n3) GET availability/booking-slots  (${DATE}, service=${COURT})`);
  const q = new URLSearchParams({
    "filter[from]": DATE,
    "filter[to]": DATE,
    "filter[serviceId]": serviceId,
  });
  const av = await smartReq(`/businesses/${BUSINESS_ID}/availability/booking-slots?${q}`);
  if (!av.ok) {
    console.log(`   → ${av.status}`, JSON.stringify(av.body).slice(0, 500));
    console.log("\n   ✗ Availability недоступен — см. заметку про fallback в конце файла.");
    return;
  }
  // API возвращает ТОЛЬКО свободные слоты (isAvailable не существует) — см. PROTOCOL.md
  const slots = (av.body.data ?? []).map((s: any) => ({
    start: s.attributes?.start,
    end: s.attributes?.end,
  }));
  console.log(`   → 200 ✓ свободных слотов: ${slots.length}`);
  for (const s of slots) console.log(`   • ${s.start} — ${s.end}`);

  const targetStart = `${DATE}T${TIME}:00${TZ_OFFSET}`;
  const target = slots.find((s: any) => s.start === targetStart);
  console.log(`\n   Целевой слот ${TIME}: ${target ? "✓ НАЙДЕН" : "✗ не найден (сверь формат start выше)"}`);

  // 4. Бронь (только с --book)
  if (!DO_BOOK) {
    console.log("\n4) Бронь пропущена (запусти с --book для реального теста)");
    return;
  }
  const name = process.env.CLIENT_NAME, email = process.env.CLIENT_EMAIL, phone = process.env.CLIENT_PHONE;
  if (!name || !email || !phone) throw new Error("Для --book задай CLIENT_NAME, CLIENT_EMAIL, CLIENT_PHONE");

  const end = new Date(new Date(`${DATE}T${TIME}:00${TZ_OFFSET}`).getTime() + DURATION_SEC * 1000);
  const endStr = `${DATE}T${String(end.getUTCHours() + 4).padStart(2, "0")}:${String(end.getUTCMinutes()).padStart(2, "0")}:00${TZ_OFFSET}`;

  console.log(`\n4) POST /bookings  ${targetStart} → ${endStr}`);
  const payload = {
    data: {
      type: "booking",
      attributes: { bookedClientName: name, note: "" },
      relationships: {
        event: {
          data: {
            type: "event",
            attributes: { start: targetStart, end: endStr, name, eventType: "appointment" },
            relationships: { service: { data: { type: "service", id: serviceId } } },
          },
        },
        client: { data: { type: "client", attributes: { name, email, phone } } },
      },
    },
  };
  const bk = await smartReq(`/businesses/${BUSINESS_ID}/bookings`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
  console.log(`   → ${bk.status}`, JSON.stringify(bk.body).slice(0, 600));
  if (bk.ok) console.log(`\n   ✅ booking_id = ${bk.body?.data?.id} — проверь в личном кабинете/на почте!`);
}

main().catch((e) => { console.error("FATAL:", e.message); process.exit(1); });

/*
 * ЕСЛИ API ОТВЕЧАЕТ 401 НА ВСЁ (и Apiary-токен не помогает):
 * fallback-recon — открой DevTools → Network (Fetch/XHR) на padel-port-batumi2.reservio.com,
 * сделай одну ручную бронь и сохрани HAR. Виджет сам ходит в API — скопируй из его запросов:
 *   - точный host/путь (может быть не api.reservio.com/v2, а внутренний endpoint)
 *   - заголовки авторизации (публичный bearer виджета / cookie)
 * и подставь сюда. Схема payload при этом почти наверняка совпадёт с этой (JSON:API).
 */
