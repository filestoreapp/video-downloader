-- SnapDown download counter. Run once in the Supabase SQL editor.
-- The anon key can only read the row and call snapdown_bump(); the
-- SECURITY DEFINER function performs the increment, bypassing RLS.

create table if not exists public.snapdown_stats (
  id int primary key,
  total int not null default 0,
  video int not null default 0,
  mp3 int not null default 0,
  clip int not null default 0,
  updated_at timestamptz not null default now(),
  constraint snapdown_stats_single_row check (id = 1)
);

insert into public.snapdown_stats (id)
values (1)
on conflict (id) do nothing;

create or replace function public.snapdown_bump(kind text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.snapdown_stats
  set total = total + 1,
      updated_at = now(),
      video = video + case when kind = 'video' then 1 else 0 end,
      mp3   = mp3   + case when kind = 'mp3'   then 1 else 0 end,
      clip  = clip  + case when kind = 'clip'  then 1 else 0 end
  where id = 1;
end
$$;

alter table public.snapdown_stats enable row level security;

drop policy if exists "snapdown_stats_read" on public.snapdown_stats;
create policy "snapdown_stats_read"
  on public.snapdown_stats for select
  to anon
  using (true);
