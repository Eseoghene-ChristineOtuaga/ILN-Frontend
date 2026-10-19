create table if not exists public.sep10_auth_challenges (
  challenge_hash text primary key,
  account text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_sep10_auth_challenges_expiry
  on public.sep10_auth_challenges (expires_at);

alter table public.sep10_auth_challenges enable row level security;
revoke all on table public.sep10_auth_challenges from anon, authenticated;
grant all on table public.sep10_auth_challenges to service_role;
