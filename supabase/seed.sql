-- ============================================================================
-- Layer 0 (cont.): seed data — the fixed, reproducible world the eval runs in.
--
-- `supabase db reset` re-applies the migrations and then runs this file, so
-- every eval run starts from an identical state. That determinism is what lets
-- us assert on expected rows.
--
-- NOTE on IDs: we let every `id` auto-generate (the schema defaults to
-- gen_random_uuid() / identity). We never hardcode a UUID. Rows are inserted
-- with a VALUES list and joined to resolve foreign keys by NATURAL KEYS:
--   organizations.slug, profiles.email, projects.name, customers.name,
--   tickets.title. The eval tasks reference rows by those same natural keys,
--   and the harness looks up the generated UUID at run time (e.g. to set
--   request.jwt.claims.sub when running a query "as" a user).
--
-- Two tenants: Acme Corp ('acme') and Globex ('globex').
-- Key fixtures the tasks lean on:
--   bob@acme.test            -> an Acme *member* ("user_2")
--   ticket "Migration downtime" -> a *Globex* ticket bob must NOT be able to see
-- ============================================================================

-- Organizations -------------------------------------------------------------
insert into public.organizations (name, slug) values
  ('Acme Corp', 'acme'),
  ('Globex',    'globex');

-- Profiles (users) -----------------------------------------------------------
insert into public.profiles (email, full_name) values
  ('alice@acme.test',  'Alice Admin'),
  ('bob@acme.test',    'Bob Member'),
  ('carol@acme.test',  'Carol Support'),
  ('dave@globex.test', 'Dave Admin'),
  ('erin@globex.test', 'Erin Member');

-- Membership: who belongs to which org, and as what role --------------------
insert into public.organization_members (organization_id, user_id, role)
select o.id, p.id, v.role
from (values
  ('acme',   'alice@acme.test',  'admin'),
  ('acme',   'bob@acme.test',    'member'),
  ('acme',   'carol@acme.test',  'support'),
  ('globex', 'dave@globex.test', 'admin'),
  ('globex', 'erin@globex.test', 'member')
) as v(org_slug, email, role)
join public.organizations o on o.slug = v.org_slug
join public.profiles p on p.email = v.email;

-- Customers (Acme has a mix of plans/statuses; Globex has two) --------------
insert into public.customers (organization_id, name, email, plan, status)
select o.id, v.name, v.email, v.plan, v.status
from (values
  ('acme',   'Northwind',         'ops@northwind.test', 'pro',        'active'),
  ('acme',   'Initech',           'it@initech.test',    'free',       'active'),
  ('acme',   'Hooli',             'sre@hooli.test',     'enterprise', 'active'),
  ('acme',   'Pied Piper',        'rh@piedpiper.test',  'pro',        'churned'),
  ('acme',   'Vandelay',          'art@vandelay.test',  'free',       'trial'),
  ('globex', 'Stark Industries',  'pepper@stark.test',  'pro',        'active'),
  ('globex', 'Wayne Enterprises', 'lucius@wayne.test',  'enterprise', 'active')
) as v(org_slug, name, email, plan, status)
join public.organizations o on o.slug = v.org_slug;

-- Projects -------------------------------------------------------------------
insert into public.projects (organization_id, name, status)
select o.id, v.name, v.status
from (values
  ('acme',   'Onboarding',      'active'),
  ('acme',   'Billing Revamp',  'active'),
  ('globex', 'Cloud Migration', 'active')
) as v(org_slug, name, status)
join public.organizations o on o.slug = v.org_slug;

-- Tickets ("Migration downtime" is the Globex ticket bob must not see) ------
insert into public.tickets (organization_id, project_id, customer_id, assignee_id, title, priority, status)
select o.id, pr.id, c.id, a.id, v.title, v.priority, v.status
from (values
  ('acme',   'Onboarding',      'Northwind',         'carol@acme.test',  'Login loop on SSO',     'high',   'open'),
  ('acme',   'Onboarding',      'Hooli',             'carol@acme.test',  'Data export fails',     'urgent', 'open'),
  ('acme',   'Billing Revamp',  'Pied Piper',        'bob@acme.test',    'Refund request',        'medium', 'pending'),
  ('acme',   'Billing Revamp',  'Initech',           'carol@acme.test',  'Invoice typo',          'low',    'closed'),
  ('acme',   'Onboarding',      'Vandelay',          'alice@acme.test',  'Onboarding stuck',      'high',   'open'),
  ('acme',   'Billing Revamp',  'Northwind',         'carol@acme.test',  'Webhook retries spike', 'high',   'pending'),
  ('globex', 'Cloud Migration', 'Stark Industries',  'dave@globex.test', 'Migration downtime',    'high',   'open'),
  ('globex', 'Cloud Migration', 'Wayne Enterprises', 'erin@globex.test', 'DNS cutover question',  'medium', 'open')
) as v(org_slug, project_name, customer_name, assignee_email, title, priority, status)
join public.organizations o on o.slug = v.org_slug
join public.projects pr on pr.name = v.project_name and pr.organization_id = o.id
join public.customers c on c.name = v.customer_name and c.organization_id = o.id
join public.profiles a on a.email = v.assignee_email;

-- Notes (one private Acme note by bob; one private Globex note) --------------
insert into public.notes (organization_id, author_id, ticket_id, body, is_private)
select o.id, au.id, t.id, v.body, v.is_private
from (values
  ('acme',   'bob@acme.test',    'Refund request',     'Customer hinted at churning — keep internal.', true),
  ('acme',   'carol@acme.test',  'Login loop on SSO',  'Reproduced; root cause is clock skew.',        false),
  ('globex', 'dave@globex.test', 'Migration downtime', 'Escalated to infra on-call.',                  true)
) as v(org_slug, author_email, ticket_title, body, is_private)
join public.organizations o on o.slug = v.org_slug
join public.profiles au on au.email = v.author_email
join public.tickets t on t.title = v.ticket_title and t.organization_id = o.id;

-- Subscriptions (one per org; billing is admin-only via RLS) ----------------
insert into public.subscriptions (organization_id, plan, status, seats, current_period_end)
select o.id, v.plan, v.status, v.seats, now() + (v.days || ' days')::interval
from (values
  ('acme',   'pro',        'active', 25,  20),
  ('globex', 'enterprise', 'active', 120, 40)
) as v(org_slug, plan, status, seats, days)
join public.organizations o on o.slug = v.org_slug;

-- Audit logs (append-only, admin-only via RLS) ------------------------------
insert into public.audit_logs (organization_id, actor_id, action, target)
select o.id, p.id, v.action, v.target
from (values
  ('acme',   'alice@acme.test',  'ticket.closed',        'ticket:Invoice typo'),
  ('acme',   'carol@acme.test',  'note.created',         'note:Login loop on SSO'),
  ('globex', 'dave@globex.test', 'subscription.updated', 'subscription:globex')
) as v(org_slug, actor_email, action, target)
join public.organizations o on o.slug = v.org_slug
join public.profiles p on p.email = v.actor_email;
