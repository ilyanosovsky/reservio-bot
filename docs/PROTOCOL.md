# PROTOCOL.md — Reservio API v2 (извлечённый протокол)

Источники: исходники `github.com/patrik-meixner/reservio-mcp` (клиент API v2,
JSON:API), страница клуба (идентификаторы), скриншот виджета (длительность
слота). Официальные доки: `reservioapiv2.docs.apiary.io`.

Статус: read-флоу (business / services / resources / availability) подтверждён
живым API 30.07.2026 — работает БЕЗ авторизации. Осталось подтвердить в spike:
book / cancel / лимит «2 брони подряд».

---

## База

```
BASE_URL = https://api.reservio.com/v2
Headers:
  Accept: application/vnd.api+json
  Content-Type: application/vnd.api+json        # только для POST/PATCH
  Authorization: Bearer <token>                 # ВОЗМОЖНО не нужен — проверить
```

## Идентификаторы Padel Port Batumi

```
businessId = 1e32bd0a-0d5c-4e30-9788-ea488e713c4d   # подтверждён API 30.07.2026
```

⚠️ Прежний id `b442467d-b583-423b-913e-574a3ffe39c3` был НЕВЕРНЫМ — это id
файла картинки бизнеса на S3, API отвечал на него 404 entityNotFound.
Настоящий id найден в HTML страницы клуба: `<script id="business-schema-{id}">`.

Подтверждено `GET /services` и `GET /resources` 30.07.2026
(duration каждого service = 3540 сек = 59 мин):

| Корт | serviceId | resourceId |
|---|---|---|
| Padel Court 1 | 6dcc4d1f-c73b-4a35-ad3a-3ede2cb321a6 | 929c2389-5a21-444f-bb78-bdcaef2dbf3c |
| **Padel Court 2** | c36479d3-8201-4d80-9822-e9c08014468b | 0631fb34-f14e-44e3-80e4-9a19a78e78e7 |
| **Padel Court 3** | 303f3adf-8a99-4c1f-89fe-f9a9b56a620b | 272d64e1-c73e-43c1-af69-8ce588e72454 |
| Padel Court 4 | 1dfea382-0fe9-42de-a3d0-36d82629b071 | 44c319e1-7d24-4c9a-ae7d-6ae6dace1cbe |
| Park Court 1 | 24481fd5-3320-4133-b762-03f13f1b200e | a0b0e4d6-4af0-4236-80b3-73312e6e93a9 |
| Park Court 2 | 09922dde-639d-4bdc-8b53-73077a57cca2 | f947f9f0-b817-4864-9843-5348d3173a44 |

(в `resources` корты называются «Court N», без префикса «Padel»)

## Время

- Таймзона клуба: `Asia/Tbilisi` = **+04:00 круглый год (без DST)**
- Формат datetime: `YYYY-MM-DDTHH:MM:SS+04:00`
- Длительность слота: **59 минут** (16:00 → 16:59)
- **Дроп — почасовой, rolling T+7 (подтверждено 30.07.2026):** слот на час `H`
  дня T+7 появляется в `H:58:50–59:00` дня T — в ТОТ ЖЕ час, что и сам слот.
  Живое наблюдение: слот 06.08 10:00 отсутствовал в 10:58:49.4 и был виден
  в 10:58:59.9; POST в 10:59:01 → confirmed (1.1 c от появления до брони).
  Механика: горизонт ровно 7×24 ч и слот открывается, когда в него входит
  КОНЕЦ слота, т.е. в `end − 7 суток` = `H:59:00` дня T.
  Для пары 20:00+21:00 это два дропа: ~20:58:50 (слот 20:00) и ~21:58:50
  (слот 21:00) дня T. Разброс секунд уточняется дальнейшими наблюдениями.
  ⚠️ Ранее в доках стояла формула `(H-1):58:50` — она противоречила этому же
  замеру (в ней слот 10:00 был бы виден уже в 09:58:50, а он отсутствовал
  в 10:58:49) и приводила к поллингу за час до реального дропа. Исправлено;
  код и тесты (`src/core/scheduler.ts`, `tests/scheduler.test.ts`) считают
  окно от часа `H`.

## Endpoints

### Бизнес (smoke-test)
```
GET /businesses/{businessId}
→ data.attributes: { name, timezone, currency }
```

### Сервисы и ресурсы
```
GET /businesses/{businessId}/services
GET /businesses/{businessId}/resources
```

### Доступные слоты
```
GET /businesses/{businessId}/availability/booking-slots
    ?filter[from]=2026-07-31          # date-only
    &filter[to]=2026-07-31
    &filter[serviceId]={serviceId}
→ meta.total + data[]: {
    type: "timeSlot",
    id: "<uuid, детерминированный>",
    attributes: { createdAt, start, end },        # НЕТ поля isAvailable!
    relationships: { resource: { data: { id } } }
  }
```

**Подтверждено 30.07.2026:** API возвращает ТОЛЬКО свободные слоты — занятые
просто отсутствуют в списке. «Слот доступен» = его `start` есть в data[].
Пагинация `page[limit]=50` — на один корт/день слотов ≤ ~15, хватает.

**Наблюдения окна дропа (30.07):** на T+6 — полный день минус занятое;
на T+7 — только уже дропнувшиеся часы (утром это ночные 00:00/01:00 и часы
до текущего+1); на T+8 — пусто. Модель почасовая (см. раздел «Время»).
Слоты сортированы не строго по времени (ночные в конце списка) — искать
по строке start, не по индексу.

### Создание брони (guest, без логина)
```
POST /businesses/{businessId}/bookings
```
```json
{
  "data": {
    "type": "booking",
    "attributes": { "bookedClientName": "Ilya ...", "note": "" },
    "relationships": {
      "event": {
        "data": {
          "type": "event",
          "attributes": {
            "start": "2026-08-05T20:00:00+04:00",
            "end":   "2026-08-05T20:59:00+04:00",
            "name":  "Ilya ...",
            "eventType": "appointment"
          },
          "relationships": {
            "service":  { "data": { "type": "service",  "id": "<serviceId>" } },
            "resource": { "data": { "type": "resource", "id": "<resourceId>" } }
          }
        }
      },
      "client": {
        "data": {
          "type": "client",
          "attributes": {
            "name":  "Ilya ...",
            "email": "<email аккаунта — привязывает бронь к кабинету>",
            "phone": "+995..."
          }
        }
      }
    }
  }
}
→ 2xx: data.id = booking_id   ← ЕДИНСТВЕННЫЙ критерий успеха
→ data.attributes.token       ← СОХРАНЯТЬ! guest-ключ для отмены/чтения брони
```
Подтверждено 30.07.2026: POST работает без auth (guest-флоу), `resource`
relationship можно опускать — корт определяется по serviceId. Ответ:
`state: "confirmed"`, `via: "application"`. Письмо-подтверждение приходит
на email (+ .ics), бронь видна по guest-ссылке из письма.

**Лимиты:** 2 POST подряд (интервал ~3 сек) на один email — оба confirmed,
анти-спама нет. Паттерн 20:00+21:00 работает.

### Чтение брони (guest, по token)
```
GET /businesses/{businessId}/bookings/{bookingId}?token={token}
→ 200 data.attributes.state          # без token: 403 insufficientUserAccess
```
Список всех броней (`GET /bookings`) гостю НЕДОСТУПЕН (403
insufficientUserAccess, нужна роль владельца) — свои booking_id и token
хранить локально в state.

### Отмена брони — ПОДТВЕРЖДЕНО 30.07.2026
```
PATCH /businesses/{businessId}/bookings/{bookingId}?token={token}
Content-Type: application/vnd.api+json
{ "data": { "type": "booking", "id": "{bookingId}",
            "attributes": { "state": "canceled" } } }
→ 200, data.attributes.state === "canceled"   ← критерий успеха отмены
```
- ⚠️ Ровно `"canceled"` (одна L). `"cancelled"` API МОЛЧА игнорирует:
  возвращает 200-эхо со старым state. Проверять state в ответе, не HTTP-код!
- `token` — из ответа POST /bookings (attributes.token).
- DELETE /bookings/{id} не существует (404 notSupported).
- Работает на api.reservio.com/v2 (веб-флоу ходит на зеркало
  accounts.reservio.com/api/v2 — тот же API).
- Дедлайн отмены: **за 1 час до начала слота** (из письма: «till 15:00»
  для брони на 16:00). После отмены слот сразу возвращается в availability.

## Auth

**Подтверждено 30.07.2026:** read-endpoints (`GET /businesses/{id}`, `/services`,
`/resources`, `/availability/booking-slots`) работают **без Authorization вовсе**.
Заголовка Bearer не требуется, токен не нужен.

Для `POST /bookings` auth-режим подтвердить при первом `--book`
(ожидаемо тоже открыт — guest-флоу виджета).

## Известные грабли

- Availability возвращает слоты со `start` строкой с оффсетом — сравнивать
  строки точно (`2026-07-31T16:00:00+04:00`), не парсить в локальный Date.
- 429/5xx → экспоненциальный backoff; polling ≥ 2 c интервал.
- JSON:API может вернуть 200 с пустым data[] до момента дропа — это норма,
  продолжать polling.
- Возможен rate-limit на количество броней с одного email за короткое
  время — проверить паттерн «2 POST подряд» в spike.
