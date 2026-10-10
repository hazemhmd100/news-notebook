-- Run once in the Supabase SQL editor (or supabase db push).
create table public.notebook_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  data jsonb not null
);
create table public.notebook_archive (
  user_id uuid not null references auth.users(id) on delete cascade,
  id text not null,
  data jsonb not null,
  created_at timestamptz not null default now(),
  primary key(user_id,id)
);
create table public.notebook_daily (
  user_id uuid not null references auth.users(id) on delete cascade,
  day date not null,
  used integer not null default 0 check(used between 0 and 20),
  primary key(user_id,day)
);
-- Only hashes are kept for quota deduplication. Unselected article text is never stored.
create table public.notebook_success (
  user_id uuid not null references auth.users(id) on delete cascade,
  day date not null,
  article_hash text not null,
  primary key(user_id,day,article_hash)
);
alter table public.notebook_settings enable row level security;
alter table public.notebook_archive enable row level security;
alter table public.notebook_daily enable row level security;
alter table public.notebook_success enable row level security;
-- No direct client access: all operations pass through the owner-checked Edge Function.
revoke all on public.notebook_settings, public.notebook_archive, public.notebook_daily, public.notebook_success from anon, authenticated;
grant all on public.notebook_settings, public.notebook_archive, public.notebook_daily, public.notebook_success to service_role;

create function public.notebook_usage(p_user uuid) returns jsonb
language sql security definer set search_path = '' as $$
  select jsonb_build_object('day',(now() at time zone 'UTC')::date,'used',coalesce((select used from public.notebook_daily where user_id=p_user and day=(now() at time zone 'UTC')::date),0));
$$;
create function public.notebook_commit_success(p_user uuid,p_article text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare today date := (now() at time zone 'UTC')::date; count_used integer;
begin
  if p_article !~ '^[a-f0-9]{64}$' then raise exception 'INVALID_HASH'; end if;
  insert into public.notebook_daily(user_id,day) values(p_user,today) on conflict do nothing;
  select used into count_used from public.notebook_daily where user_id=p_user and day=today for update;
  if exists(select 1 from public.notebook_success where user_id=p_user and day=today and article_hash=p_article) then
    return jsonb_build_object('day',today,'used',count_used);
  end if;
  if count_used>=20 then raise exception 'DAILY_LIMIT'; end if;
  insert into public.notebook_success values(p_user,today,p_article);
  update public.notebook_daily set used=used+1 where user_id=p_user and day=today returning used into count_used;
  -- Keep only recent quota metadata, never full unsaved results.
  delete from public.notebook_success where user_id=p_user and day<today-2;
  delete from public.notebook_daily where user_id=p_user and day<today-2;
  return jsonb_build_object('day',today,'used',count_used);
end;
$$;
revoke all on function public.notebook_usage(uuid), public.notebook_commit_success(uuid,text) from public, anon, authenticated;
grant execute on function public.notebook_usage(uuid), public.notebook_commit_success(uuid,text) to service_role;
