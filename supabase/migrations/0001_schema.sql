-- ============================================================================
-- Layer 0: schema for a small multi-tenant SaaS support desk ("SupportDesk").
--
-- Why these tables exist:
--   organizations / profiles / organization_members  -> the multi-tenant core
--   customers / projects / tickets / notes            -> the actual product data
--   subscriptions                                     -> billing (admin-only later)
--   audit_logs                                        -> append-only, read-only data
--
-- Multi-tenancy is the whole point: every row of product data carries an
-- organization_id, and RLS (next migration) makes a user only able to see
-- their own org's rows. That is what makes the agent's RLS reasoning real.
--
-- Note on `profiles.id`: in a production Supabase project this would be
-- `references auth.users(id)`. In this sandbox we keep profiles standalone so
-- the seed is pure SQL and doesn't depend on GoTrue having created auth users.
-- RLS still works because policies key off `auth.uid()` (the JWT `sub` claim),
-- which we set explicitly when the query tool runs "as" a user.
-- ============================================================================

create extension if not exists "pgcrypto";

create table public.organizations (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  slug        text not null unique,
  created_at  timestamptz not null default now()
);

create table public.profiles (
  id          uuid primary key default gen_random_uuid(),
  email       text not null unique,
  full_name   text,
  created_at  timestamptz not null default now()
);

create table public.organization_members (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  user_id          uuid not null references public.profiles(id) on delete cascade,
  role             text not null check (role in ('admin', 'member', 'support')),
  created_at       timestamptz not null default now(),
  unique (organization_id, user_id)
);

create table public.customers (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  name             text not null,
  email            text,
  plan             text not null default 'free' check (plan in ('free', 'pro', 'enterprise')),
  status           text not null default 'active' check (status in ('active', 'trial', 'churned')),
  created_at       timestamptz not null default now()
);

create table public.projects (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  name             text not null,
  status           text not null default 'active' check (status in ('active', 'archived')),
  created_at       timestamptz not null default now()
);

create table public.tickets (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  project_id       uuid references public.projects(id) on delete set null,
  customer_id      uuid references public.customers(id) on delete set null,
  assignee_id      uuid references public.profiles(id) on delete set null,
  title            text not null,
  priority         text not null default 'medium' check (priority in ('low', 'medium', 'high', 'urgent')),
  status           text not null default 'open' check (status in ('open', 'pending', 'closed')),
  created_at       timestamptz not null default now()
);

create table public.notes (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  author_id        uuid not null references public.profiles(id) on delete cascade,
  ticket_id        uuid references public.tickets(id) on delete cascade,
  body             text not null,
  is_private       boolean not null default true,
  created_at       timestamptz not null default now()
);

create table public.subscriptions (
  id                   uuid primary key default gen_random_uuid(),
  organization_id      uuid not null unique references public.organizations(id) on delete cascade,
  plan                 text not null default 'free' check (plan in ('free', 'pro', 'enterprise')),
  status               text not null default 'trialing' check (status in ('active', 'past_due', 'canceled', 'trialing')),
  seats                int not null default 1,
  current_period_end   timestamptz,
  created_at           timestamptz not null default now()
);

create table public.audit_logs (
  id               bigint generated always as identity primary key,
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  actor_id         uuid references public.profiles(id) on delete set null,
  action           text not null,
  target           text,
  created_at       timestamptz not null default now()
);

-- Helpful indexes for the kinds of filters the eval tasks will exercise.
create index on public.organization_members (user_id);
create index on public.customers (organization_id, status, plan);
create index on public.tickets (organization_id, status, priority, assignee_id);
create index on public.notes (organization_id, is_private, author_id);
create index on public.audit_logs (organization_id, created_at);
