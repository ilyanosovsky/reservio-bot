/**
 * SPIKE: наблюдение дропа + бронь по появлению слота.
 * Цель: 2026-08-06 10:00 Court 3 (fallback Court 2).
 * Логирует точное время каждого polla и момент появления слота.
 *
 * Запуск: npx tsx spike-drop-watch.ts
 * Правила CLAUDE.md: интервал ≥ 2 c, окно ограничено, backoff на 429/5xx.
 */
import { readFileSync } from "node:fs";
try {
  for (const line of readFileSync(new URL(".env", import.meta.url), "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch {}

const API = "https://api.reservio.com/v2";
const BUSINESS_ID = "1e32bd0a-0d5c-4e30-9788-ea488e713c4d";
const COURTS: Array<{ name: string; serviceId: string }> = [
  { name: "Padel Court 3", serviceId: "303f3adf-8a99-4c1f-89fe-f9a9b56a620b" },
  { name: "Padel Court 2", serviceId: "c36479d3-8201-4d80-9822-e9c08014468b" },
];
const DATE = "2026-08-06";
const TIME = "10:00";
const TARGET_START = `${DATE}T${TIME}:00+04:00`;
const TARGET_END = `${DATE}T10:59:00+04:00`;
const DEADLINE_TBILISI = "11:06:00"; // стоп-окно

// текущее время в Тбилиси (+04:00, без DST) как HH:MM:SS.mmm
function nowTbilisi(): string {
  const d = new Date(Date.now() + 4 * 3600_000);
  return d.toISOString().slice(11, 23);
}

const headers = { Accept: "application/vnd.api+json" };

async function pollCourt(serviceId: string): Promise<{ starts: string[]; ms: number; status: number }> {
  const q = new URLSearchParams({
    "filter[from]": DATE,
    "filter[to]": DATE,
    "filter[serviceId]": serviceId,
  });
  const t0 = performance.now();
  const res = await fetch(`${API}/businesses/${BUSINESS_ID}/availability/booking-slots?${q}`, { headers });
  const ms = Math.round(performance.now() - t0);
  if (!res.ok) return { starts: [], ms, status: res.status };
  const j = await res.json();
  return { starts: (j.data ?? []).map((s: any) => s.attributes?.start), ms, status: res.status };
}

async function book(court: { name: string; serviceId: string }) {
  const name = process.env.CLIENT_NAME!, email = process.env.CLIENT_EMAIL!, phone = process.env.CLIENT_PHONE!;
  const payload = {
    data: {
      type: "booking",
      attributes: { bookedClientName: name, note: "" },
      relationships: {
        event: {
          data: {
            type: "event",
            attributes: { start: TARGET_START, end: TARGET_END, name, eventType: "appointment" },
            relationships: { service: { data: { type: "service", id: court.serviceId } } },
          },
        },
        client: { data: { type: "client", attributes: { name, email, phone } } },
      },
    },
  };
  const t0 = performance.now();
  const res = await fetch(`${API}/businesses/${BUSINESS_ID}/bookings`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/vnd.api+json" },
    body: JSON.stringify(payload),
  });
  const ms = Math.round(performance.now() - t0);
  const j = await res.json().catch(() => null);
  const id = j?.data?.id, token = j?.data?.attributes?.token, state = j?.data?.attributes?.state;
  console.log(`[${nowTbilisi()}] POST ${court.name} → ${res.status} за ${ms}ms; id=${id} state=${state} token=${token}`);
  if (!res.ok) console.log(`  body: ${JSON.stringify(j).slice(0, 400)}`);
  return res.ok && id ? { id, token, state, court: court.name } : null;
}

async function main() {
  const { CLIENT_NAME, CLIENT_EMAIL, CLIENT_PHONE } = process.env;
  if (!CLIENT_NAME || !CLIENT_EMAIL || !CLIENT_PHONE) throw new Error("CLIENT_* не заданы в .env");
  console.log(`[${nowTbilisi()}] START watch: ${TARGET_START}, Court 3 → Court 2, стоп в ${DEADLINE_TBILISI}`);

  let booked = false; // идемпотентность: один POST на запуск
  let backoff = 0;
  let firstSeenAt: string | null = null;

  while (!booked) {
    const now = nowTbilisi();
    if (now >= DEADLINE_TBILISI) {
      console.log(`[${now}] DEADLINE — слот так и не появился. Стоп.`);
      process.exit(2);
    }
    // до 10:59:30 — ленивый polling (10 c), после — боевой (2 c)
    const hot = now >= "10:59:30";
    const c3 = await pollCourt(COURTS[0].serviceId);
    if (c3.status === 429 || c3.status >= 500) {
      backoff = Math.min((backoff || 2) * 2, 30);
      console.log(`[${nowTbilisi()}] ${c3.status} → backoff ${backoff}s`);
      await new Promise((r) => setTimeout(r, backoff * 1000));
      continue;
    }
    backoff = 0;
    const has10 = c3.starts.includes(TARGET_START);
    console.log(`[${nowTbilisi()}] C3 poll ${c3.ms}ms, слотов=${c3.starts.length}${c3.starts.length ? ` [${c3.starts.map(s => s.slice(11, 16)).join(",")}]` : ""}${has10 ? "  ← 10:00 ПОЯВИЛСЯ!" : ""}`);

    if (has10) {
      firstSeenAt = nowTbilisi();
      console.log(`[${firstSeenAt}] ДРОП ЗАФИКСИРОВАН: ${TARGET_START} виден в availability. Бронирую...`);
      let r = await book(COURTS[0]);
      if (!r) {
        console.log(`[${nowTbilisi()}] C3 не взялся → fallback Court 2`);
        const c2 = await pollCourt(COURTS[1].serviceId);
        if (c2.starts.includes(TARGET_START)) r = await book(COURTS[1]);
        else console.log(`[${nowTbilisi()}] На Court 2 слота 10:00 тоже нет.`);
      }
      if (r) {
        console.log(`\n✅ УСПЕХ: ${r.court} ${TARGET_START}, booking_id=${r.id}, token=${r.token}`);
        console.log(`   (сохрани token — нужен для отмены)`);
      } else {
        console.log(`\n✗ Слот появился (${firstSeenAt}), но бронь не удалась ни на одном корте.`);
        process.exit(3);
      }
      booked = true;
      break;
    }
    await new Promise((r) => setTimeout(r, hot ? 2000 : 10_000));
  }
}

main().catch((e) => { console.error(`[${nowTbilisi()}] FATAL:`, e.message); process.exit(1); });
