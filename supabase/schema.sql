-- Manga Voice Studio: временные snapshots проектов.
-- ВАЖНО: выполнять в Supabase SQL Editor.
-- API использует SUPABASE_SERVICE_ROLE_KEY на сервере, поэтому RLS остаётся включённым.

create table if not exists public.mvs_project_snapshots (
  project_id text primary key,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create index if not exists mvs_project_snapshots_expires_at_idx
  on public.mvs_project_snapshots (expires_at);

alter table public.mvs_project_snapshots enable row level security;

-- Удаляем просроченные записи. Вызывается API очистки и перед чтением/записью.
create or replace function public.mvs_delete_expired_snapshots()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare deleted_count integer;
begin
  delete from public.mvs_project_snapshots where expires_at <= now();
  get diagnostics deleted_count = row_count;
  return deleted_count;
end;
$$;

revoke all on function public.mvs_delete_expired_snapshots() from public;

-- Не выдаём доступ anon/authenticated: API обращается к таблице service role key.
revoke all on table public.mvs_project_snapshots from anon, authenticated;
