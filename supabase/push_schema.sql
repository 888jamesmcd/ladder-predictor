-- Kick-off alerts. Run this once in the Supabase SQL Editor for project
-- pkylungddcizffdtnmhd, after supabase_schema.sql.

-- Phones (and browsers) that have turned kick-off alerts on.
create table if not exists public.push_subscriptions (
  endpoint text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  p256dh text not null,
  auth text not null,
  created_at timestamptz not null default now()
);
alter table public.push_subscriptions enable row level security;
create policy "Users manage their own push subscriptions"
  on public.push_subscriptions for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- How far the sender has got for each person, so a kick-off is never sent
-- twice or skipped when a run is late. Only the function touches it.
create table if not exists public.push_cursor (
  user_id uuid primary key references auth.users(id) on delete cascade,
  sent_until timestamptz not null
);
alter table public.push_cursor enable row level security;

-- The once-a-minute schedule that calls the function. It needs the pg_cron
-- and pg_net extensions, and reads the function's password from the Vault
-- secret 'kickoff_cron_secret' (the CRON_SECRET value in
-- supabase/.secrets.local), so nothing secret is written here. Until that
-- secret exists the calls are simply refused by the function.
create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule('kickoff-push', '* * * * *', $$
  select net.http_post(
    url := 'https://pkylungddcizffdtnmhd.supabase.co/functions/v1/kickoff-push',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'kickoff_cron_secret')
    ),
    body := '{}'::jsonb
  );
$$);
-- To stop it later: select cron.unschedule('kickoff-push');
