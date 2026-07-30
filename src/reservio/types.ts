/**
 * Типы и константы Reservio API v2 (Padel Port Batumi).
 * Источник идентификаторов и формата — docs/PROTOCOL.md (подтверждено живым API 30.07.2026).
 */

/** Свободный слот из availability. `start`/`end` — ISO с явным оффсетом +04:00. */
export interface Slot {
  start: string;
  end: string;
}

/** Результат успешного POST /bookings. `token` — guest-ключ, без него бронь не прочитать и не отменить. */
export interface BookingCreated {
  bookingId: string;
  token: string;
  state: string;
}

/** Контакт гостя: email привязывает бронь к личному кабинету владельца. */
export interface ClientContact {
  name: string;
  email: string;
  phone: string;
}

/** Корт = отдельный service (+ свой resource). */
export interface CourtInfo {
  name: string;
  serviceId: string;
  resourceId: string;
}

export const API_BASE = 'https://api.reservio.com/v2';

/** Padel Port Batumi. НЕ путать с b442467d… — то id картинки бизнеса (404 entityNotFound). */
export const BUSINESS_ID = '1e32bd0a-0d5c-4e30-9788-ea488e713c4d';

export const COURTS: CourtInfo[] = [
  {
    name: 'Padel Court 1',
    serviceId: '6dcc4d1f-c73b-4a35-ad3a-3ede2cb321a6',
    resourceId: '929c2389-5a21-444f-bb78-bdcaef2dbf3c',
  },
  {
    name: 'Padel Court 2',
    serviceId: 'c36479d3-8201-4d80-9822-e9c08014468b',
    resourceId: '0631fb34-f14e-44e3-80e4-9a19a78e78e7',
  },
  {
    name: 'Padel Court 3',
    serviceId: '303f3adf-8a99-4c1f-89fe-f9a9b56a620b',
    resourceId: '272d64e1-c73e-43c1-af69-8ce588e72454',
  },
  {
    name: 'Padel Court 4',
    serviceId: '1dfea382-0fe9-42de-a3d0-36d82629b071',
    resourceId: '44c319e1-7d24-4c9a-ae7d-6ae6dace1cbe',
  },
  {
    name: 'Park Court 1',
    serviceId: '24481fd5-3320-4133-b762-03f13f1b200e',
    resourceId: 'a0b0e4d6-4af0-4236-80b3-73312e6e93a9',
  },
  {
    name: 'Park Court 2',
    serviceId: '09922dde-639d-4bdc-8b53-73077a57cca2',
    resourceId: 'f947f9f0-b817-4864-9843-5348d3173a44',
  },
];

/**
 * Корт по имени. Имена приходят из конфига профилей (пишет человек),
 * поэтому регистр и лишние пробелы прощаем. Неизвестное имя — ошибка конфига, не runtime-фолбэк.
 */
export function courtByName(name: string): CourtInfo {
  const needle = name.trim().toLowerCase();
  const found = COURTS.find((c) => c.name.toLowerCase() === needle);
  if (!found) {
    throw new Error(
      `Неизвестный корт: "${name}". Доступные: ${COURTS.map((c) => c.name).join(', ')}`,
    );
  }
  return found;
}
