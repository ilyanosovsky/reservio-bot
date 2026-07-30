-- Дельта к 20260730123000 (та была применена до этих правок):
-- индекс для markCanceled + второй барьер против anon-доступа к token'ам.
create index if not exists bookings_booking_id_idx on public.bookings (booking_id);
revoke all on table public.bookings from anon, authenticated;
