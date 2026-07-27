-- Run this once in the Supabase SQL Editor for project pkylungddcizffdtnmhd.
-- Stores the app's saved state (previously in localStorage), one row per key per user.

create table if not exists public.predictor_state (
  user_id uuid not null references auth.users(id) on delete cascade,
  key text not null,
  value jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, key)
);

alter table public.predictor_state enable row level security;

create policy "Users can read their own state"
  on public.predictor_state for select
  using (auth.uid() = user_id);

create policy "Users can insert their own state"
  on public.predictor_state for insert
  with check (auth.uid() = user_id);

create policy "Users can update their own state"
  on public.predictor_state for update
  using (auth.uid() = user_id);

create policy "Users can delete their own state"
  on public.predictor_state for delete
  using (auth.uid() = user_id);
