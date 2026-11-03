-- Run this once in the Supabase SQL editor.
-- The anon key in the app can read and write these tables.
-- Keep the project URL private. This is a household log, not a public API.
-- entries.data.person and days.person keep the three logs separate.
-- foods.data.listId is "home" for Surya and Sahi, or "nonu" for Nonu.

create table if not exists foods (
  id text primary key,
  data jsonb not null
);

create table if not exists entries (
  id text primary key,
  data jsonb not null
);

create table if not exists days (
  person text not null,
  date text not null,
  exercise text default '',
  burned numeric default 0,
  primary key (person, date)
);

create table if not exists goals (
  person text primary key,
  data jsonb not null
);

alter table foods enable row level security;
alter table entries enable row level security;
alter table days enable row level security;
alter table goals enable row level security;

drop policy if exists "household foods" on foods;
drop policy if exists "household entries" on entries;
drop policy if exists "household days" on days;
drop policy if exists "household goals" on goals;
create policy "household foods" on foods for all using (true) with check (true);
create policy "household entries" on entries for all using (true) with check (true);
create policy "household days" on days for all using (true) with check (true);
create policy "household goals" on goals for all using (true) with check (true);

-- New Supabase projects do not let the app see tables until these grants exist.
grant usage on schema public to anon, authenticated, service_role;
grant select, insert, update, delete on public.foods to anon, authenticated, service_role;
grant select, insert, update, delete on public.entries to anon, authenticated, service_role;
grant select, insert, update, delete on public.days to anon, authenticated, service_role;
grant select, insert, update, delete on public.goals to anon, authenticated, service_role;
notify pgrst, 'reload schema';
