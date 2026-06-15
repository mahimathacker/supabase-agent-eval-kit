-- ============================================================================
-- Layer 0 (cont.): Row-Level Security.
--
-- This is what makes the eval real. Once RLS is enabled, a table returns ZERO
-- rows unless a policy explicitly allows them. The agent's query tool runs as
-- the `authenticated` role with a specific user's id in the JWT claims, so
-- `auth.uid()` resolves to that user and the policies below decide what they
-- can see.
--
-- Mental model of the policies:
--   * Most product data is visible to any member of the owning organization.
--   * Billing (subscriptions) and audit_logs are admin-only.
--   * Private notes are visible only to their author or an org admin.
--
-- The two helper functions are `security definer` ON PURPOSE: they read
-- organization_members, which itself has RLS. If the policies queried that
-- table directly, evaluating a policy would trigger another policy check on
-- the same table -> infinite recursion. A security-definer function runs with
-- the definer's rights, bypassing RLS for that one trusted lookup. This is the
-- canonical Supabase multi-tenant pattern (and a great thing for the agent to
-- recognize).
-- ============================================================================

create or replace function public.current_user_org_ids()
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  select organization_id
  from public.organization_members
  where user_id = auth.uid()
$$;

create or replace function public.is_org_admin(org uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.organization_members
    where user_id = auth.uid()
      and organization_id = org
      and role = 'admin'
  )
$$;

-- Enable RLS on every table. (Enabling RLS with no policy = nothing visible.)
alter table public.organizations        enable row level security;
alter table public.profiles              enable row level security;
alter table public.organization_members  enable row level security;
alter table public.customers             enable row level security;
alter table public.projects              enable row level security;
alter table public.tickets               enable row level security;
alter table public.notes                 enable row level security;
alter table public.subscriptions         enable row level security;
alter table public.audit_logs            enable row level security;

-- A user can always read their own profile, plus the profiles of people in
-- their organizations (so ticket assignees / note authors resolve).
create policy profiles_self_and_orgmates on public.profiles
  for select using (
    id = auth.uid()
    or id in (
      select om.user_id
      from public.organization_members om
      where om.organization_id in (select public.current_user_org_ids())
    )
  );

create policy organizations_member_read on public.organizations
  for select using (id in (select public.current_user_org_ids()));

create policy members_same_org_read on public.organization_members
  for select using (organization_id in (select public.current_user_org_ids()));

create policy customers_org_read on public.customers
  for select using (organization_id in (select public.current_user_org_ids()));

create policy projects_org_read on public.projects
  for select using (organization_id in (select public.current_user_org_ids()));

create policy tickets_org_read on public.tickets
  for select using (organization_id in (select public.current_user_org_ids()));

-- Private notes: org membership AND (public, or you wrote it, or you're admin).
create policy notes_org_read on public.notes
  for select using (
    organization_id in (select public.current_user_org_ids())
    and (
      is_private = false
      or author_id = auth.uid()
      or public.is_org_admin(organization_id)
    )
  );

-- Billing is admin-only.
create policy subscriptions_admin_read on public.subscriptions
  for select using (public.is_org_admin(organization_id));

-- Audit logs are admin-only and append-only: we define a SELECT policy and no
-- write policies, so even the `authenticated` role can never mutate them.
create policy audit_logs_admin_read on public.audit_logs
  for select using (public.is_org_admin(organization_id));

-- Base grants. RLS narrows what these rows expose; grants are still required
-- for the `authenticated` role to touch the tables at all.
grant usage on schema public to authenticated;
grant select on all tables in schema public to authenticated;
grant execute on function public.current_user_org_ids() to authenticated;
grant execute on function public.is_org_admin(uuid) to authenticated;
