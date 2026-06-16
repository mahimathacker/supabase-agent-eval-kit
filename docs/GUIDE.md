# A Complete Guide to This Project

A from-scratch explanation of **what** we built, **why** each decision was made, and the **best practices** (RLS, security, AI-agent evals) baked into it. Written for someone new to AI engineering — every term is explained the first time it appears. Read top to bottom once; after that, use it as a reference.

---

## Part 0 — The 60-second mental model

We are answering one question: **"Can an AI agent work with a database safely and correctly?"**

To answer it honestly we need three things, and the project is built from exactly those three:

1. **A realistic world** — a database with real access rules (so "safe" and "correct" actually mean something).
2. **An agent** — an AI (Claude) that can take actions against that world through a fixed set of tools.
3. **A judge of behavior** — code that watches the agent and scores whether it did the right thing.

```
  ┌────────────┐      ┌─────────────────────────┐      ┌──────────────┐
  │  THE WORLD │◀────▶│   THE AGENT (Claude)     │      │ THE SCORER   │
  │  Postgres  │ tools│   picks tools, writes    │─────▶│ per-dimension│
  │  + RLS     │      │   SQL, reads results     │trace │ verdicts     │
  └────────────┘      └─────────────────────────┘      └──────────────┘
     Layer 0              Layers 1 (tools) + 2 (agent)     Layers 3 + 4
```

Everything else is detail in service of those three.

---

## Part 1 — Vocabulary (read this once)

| Term | Plain meaning |
|---|---|
| **Tenant** | One customer organization in a shared app. "Multi-tenant" = one database serves many tenants, each isolated. Our tenants are **Acme** and **Globex** (made-up company names). |
| **Row-Level Security (RLS)** | A Postgres feature that filters *which rows* a query returns based on who's asking. The core security mechanism here. |
| **GRANT** | A Postgres privilege: may a role touch a table *at all*? Separate from RLS (which decides *which rows*). |
| **Role** (`anon`, `authenticated`, `postgres`) | A database identity. `anon` = logged-out visitor, `authenticated` = logged-in user, `postgres` = superuser (bypasses RLS). From Supabase's auth model. |
| **`auth.uid()`** | A Supabase SQL function returning the current user's id, read from the request's JWT. RLS policies use it to mean "the current user." |
| **JWT claims** | Data carried by a logged-in session (e.g. `sub` = the user id). We set this manually to make the DB believe a query is "from" a specific user. |
| **MCP (Model Context Protocol)** | A standard way to expose **tools** to an AI. Our tool server speaks MCP, so any MCP client (Claude Desktop, our agent) can use it. |
| **Agent** | An LLM run in a *loop* where it chooses tools, sees results, and decides the next action — autonomously. Not a chatbot; it *acts*. |
| **Tool-use loop** | The code that sends the model the available tools, executes the tool it asks for, feeds the result back, and repeats until done. |
| **Eval** | A test suite for an AI: run it on tasks, score the outcomes. Like unit tests, but for fuzzy behavior. |
| **LLM-as-judge** | Using a second LLM call to grade a free-form answer against a rubric — for things exact string-matching can't check. |
| **Ground truth** | The known-correct answer, computed independently, that we grade the agent against. |
| **`security definer`** | A Postgres function that runs with *its creator's* privileges, not the caller's — used to safely bypass RLS for one trusted lookup. |

---

## Part 2 — Cross-cutting decisions (the "why" that touches many files)

These choices shaped the whole project. Understand these and the rest reads easily.

### D1. Use the real Supabase local stack, not bare Postgres
`supabase start` runs Postgres **plus** the Supabase roles (`anon`, `authenticated`) and the `auth.uid()` function inside Docker. Our RLS depends on those. A plain `docker run postgres` would lack them, so the RLS we test wouldn't match a real Supabase project. **Principle: test against the thing you'd ship to.**

### D2. UUID primary keys (mostly), `bigint` for the log
- `profiles.id` etc. are **UUID** because real Supabase identity (`auth.users.id`) is UUID, `auth.uid()` returns UUID, and UUIDs are **unguessable** (you can't enumerate `/ticket/42` → `/ticket/43` across tenants).
- `audit_logs.id` is **`bigint generated always as identity`** (an auto-incrementing integer) because a log wants natural ordering and nothing references it by identity.
- **Principle: pick the key type per table's purpose, not dogmatically.** (See [`0001_schema.sql`](../supabase/migrations/0001_schema.sql) lines 24, 97.)

### D3. Seed data references rows by *natural keys*, never hardcoded UUIDs
[`seed.sql`](../supabase/seed.sql) lets every `id` auto-generate and links rows with `VALUES` lists joined on `slug`/`email`/`name`/`title`. **Principle: don't hardcode surrogate ids in fixtures** — reference business keys, so the data is readable and the eval tasks can say `bob@acme.test` instead of a magic UUID.

### D4. The agent never chooses *whose* data it reads
The acting user is set by the harness via the `ACTING_USER` environment variable when it spawns the tool server ([`server.ts`](../src/tools/server.ts) line 25, [`runAgent.ts`](../src/agent/runAgent.ts)). **Principle: identity/authorization is a property of the session, decided by trusted code — never an argument the model can set.** If the model could pick the user, it could escalate to admin and the eval would be meaningless.

### D5. Two database connections with different powers
[`db.ts`](../src/tools/db.ts) exposes:
- `queryAdmin` — runs as the base role with **no RLS scoping**, used **only** for schema/catalog introspection and resolving email→id.
- `withReadOnly` — runs tenant data queries inside a **read-only transaction as a specific user**, so RLS applies.

**Principle: separate the "metadata" power from the "read tenant data" power**, and never read tenant data on the admin path — that would bypass RLS and defeat the point.

### D6. Own the agent loop so you can observe it
We wrote a thin tool-use loop ([`runAgent.ts`](../src/agent/runAgent.ts)) instead of using a framework, because the eval's entire job is to *watch* the agent: every tool call, token, latency, and blocked attempt. **Principle: if you're evaluating an agent, instrument it — a black-box framework hides the trace you need to score.**

---

## Part 3 — File-by-file walkthrough

### Layer 0 — the world

#### [`supabase/migrations/0001_schema.sql`](../supabase/migrations/0001_schema.sql) — the tables
Nine tables modelling a tiny SaaS support desk:
- **Tenancy core:** `organizations`, `profiles` (users), `organization_members` (who belongs to which org, with a `role` of admin/member/support).
- **Product data:** `customers`, `projects`, `tickets`, `notes`.
- **Special cases:** `subscriptions` (billing — will be admin-only) and `audit_logs` (append-only).

Decisions to notice:
- **Every product table carries `organization_id`** (e.g. line 48, 66). This single column is the hook RLS hangs on — "your org's rows" is defined by it.
- **`CHECK` constraints encode enum-like values** (e.g. `status in ('active','trial','churned')`, line 52). These are gold for the agent: `describe_table` surfaces them, so the agent learns valid values instead of guessing.
- **Foreign keys with `on delete` rules** (cascade vs set null) model real referential integrity.
- **`profiles.id` is standalone**, not `references auth.users(id)` (lines 14–18). In production it would reference Supabase's auth table; in this sandbox we keep it standalone so the seed is pure SQL. RLS still works because policies key off `auth.uid()`, which we set manually.
- **Indexes (lines 105–110)** are on exactly the columns policies and tasks filter by (`organization_id`, `status`, etc.). RLS adds a `WHERE` to every query; indexing those columns keeps it fast.

#### [`supabase/migrations/0002_rls.sql`](../supabase/migrations/0002_rls.sql) — the security
This is the heart. Three parts:

1. **Two `security definer` helper functions.**
   - `current_user_org_ids()` returns the orgs the current user belongs to.
   - `is_org_admin(org)` returns whether they're an admin of an org.
   - **Why `security definer`?** They read `organization_members`, which *itself* has RLS. If a policy queried that table directly, evaluating the policy would trigger the table's policy again → infinite recursion. A `security definer` function runs with the *definer's* rights, bypassing RLS for that one trusted lookup. `set search_path = public` is a hardening step so the function can't be tricked into resolving objects from a malicious schema. **This is the canonical Supabase multi-tenant pattern.**

2. **`ENABLE ROW LEVEL SECURITY` on every table**, then **one `SELECT` policy each**:
   - Most tables: visible if `organization_id IN (select current_user_org_ids())` — your org's rows.
   - `notes`: org membership **AND** (`is_private = false` OR you're the author OR you're an admin) — the private-notes rule.
   - `subscriptions` and `audit_logs`: `is_org_admin(...)` — admin-only.
   - **Why only `SELECT` policies?** With RLS enabled and no write policy, writes are refused for `authenticated` automatically. Combined with the read-only query path, the data is effectively read-only to the agent.
   - **Deny-by-default:** enabling RLS with *no* matching policy returns **zero rows**. You opt rows back in. That's the safe default.

3. **GRANTs (lines ~111+).** `grant select on all tables to authenticated`. **GRANT and RLS are two stacked gates:**

   | Gate | Question | Granularity |
   |---|---|---|
   | GRANT | May this role touch the table at all? | table-level |
   | RLS | Which rows does it get? | row-level |

   Postgres checks GRANT **first**. We grant to `authenticated` (so logged-in users can query, then RLS narrows them) but **not to `anon`** — so a logged-out request fails at the GRANT gate with "permission denied" before RLS even runs. (This is the subtlety the eval surfaced: anon is blocked by grants, not RLS.)

#### [`supabase/seed.sql`](../supabase/seed.sql) — the fixtures
Loads two tenants and the cast (alice/bob/carol → Acme; dave/erin → Globex), customers with a mix of plans/statuses, tickets where the Globex ones must stay invisible to Acme users, a private note, admin-only subscriptions, and audit logs. **`supabase db reset` re-applies migrations + this file**, so every eval run starts from a byte-identical world — the reproducibility evals require.

### Layer 1 — the tools

#### [`src/tools/db.ts`](../src/tools/db.ts) — the database access layer
The most security-critical file. Key pieces:
- A `pg` connection **pool** (reuses connections).
- `queryAdmin` — metadata only, no RLS (see D5).
- `resolveUserId(email)` — looks up a profile's UUID, used to "act as" a user.
- **`withReadOnly(actingUserId, fn)`** — the safety sandwich for every data query:
  1. `begin transaction read only` — Postgres itself refuses writes here.
  2. `set local statement_timeout = 5000` — a runaway query (e.g. accidental cross join) is killed.
  3. If a user is given: `set local role authenticated` + put their id in `request.jwt.claims` → `auth.uid()` resolves to them → **RLS applies as that user.** If null: `set local role anon` → logged-out.
  4. Runs the query, then **always rolls back** (read-only, nothing to commit; also discards the role switch).
- **Why `set local` (not `set`)?** `local` scopes the change to this transaction, so a pooled connection can't leak one user's identity into the next query. This connects to the bug we fixed earlier — identity must never bleed between requests.

#### [`src/tools/validateSql.ts`](../src/tools/validateSql.ts) — the safety gate
`analyzeSql(sql)` **parses** the SQL into a syntax tree and allows **only** read-only shapes (`select`, `values`, read-only `union`/`with`). Everything else (`insert`, `delete`, `with x as (insert …)`, two statements, `copy`, `merge`…) is refused.
- **Why parse instead of a keyword blocklist?** A blocklist of words like "DELETE" is both too loose and too strict: it false-positives on `SELECT 'delete me'` and false-negatives on a write hidden in a CTE or a second statement after `;`. Parsing and **allowlisting** read-only shapes is stricter *and* more accurate. **Principle: allowlist > blocklist for security.**

#### [`src/tools/runReadonlySql.ts`](../src/tools/runReadonlySql.ts) — the agent's only window onto data
Flow: **safety gate first** (if not a safe SELECT → `blocked: true`, never reaches the DB) → run via `withReadOnly` as the acting user → return rows (capped at 200 to save tokens). A DB-level error (bad column, or a write that somehow slipped the parser hitting the read-only txn) is caught and returned as `ok: false` with a reason, not a crash. **Three independent defenses: parse-time allowlist, DB read-only transaction, statement timeout.** Defense in depth — if one fails, the others hold.

#### [`src/tools/explainQueryResult.ts`](../src/tools/explainQueryResult.ts) — the debugging tool
Runs `EXPLAIN (ANALYZE, …)` as the user, which actually executes the query (safely) and reports the **actual row count**. The point: when a query returns nothing, the agent can see `actual_rows = 0` and a plan gated by the RLS policy — concrete evidence that RLS filtered everything, not a guess. This is what makes the "why no rows?" debug task answerable.

#### [`src/tools/listTables.ts`](../src/tools/listTables.ts) & [`describeTable.ts`](../src/tools/describeTable.ts) & [`getPolicies.ts`](../src/tools/getPolicies.ts) — introspection
All three read Postgres **system catalogs** (`pg_class`, `information_schema`, `pg_policies`) via `queryAdmin` (metadata, so admin connection is fine). Notable:
- `describeTable` passes the table name as a **bound parameter** (`$1`), so it's injection-safe even though it's a string.
- `describeTable` surfaces `CHECK` clauses — the enum values the agent needs.
- `getPolicies` returns the raw `USING` / `WITH CHECK` expressions as text — exactly what the agent reads to reason about *who can see what* (used by the policy-explain and debug tasks).

#### [`src/tools/server.ts`](../src/tools/server.ts) — the MCP server
Registers the six tools with the MCP SDK and serves them over **stdio** (standard input/output). Decisions:
- **All logging goes to stderr** (line 15). On stdio, **stdout is the protocol channel** — a stray `console.log` would corrupt it. (This is why launching via `npm run mcp` broke the Inspector: npm's banner prints to stdout. Launch `tsx` directly.)
- The acting user is read from `ACTING_USER` **at startup** (line 25) and baked into the data tools — the agent can't change it (D4).

### Layer 2 — the agent

#### [`src/agent/types.ts`](../src/agent/types.ts) — the trace shape
`AgentResult` is the **complete, observable record** of one run: the answer, an ordered list of every `ToolCall` (name, input, output, `isError`, `blocked`, latency), token usage, cost, total latency, iteration count, and stop reason. Layer 3 scores *this object*. **Principle: design the trace first — your scoring can only see what you record.**

#### [`src/agent/runAgent.ts`](../src/agent/runAgent.ts) — the instrumented loop
What it does, step by step:
1. **Spawns the real MCP server as a child process** (via `tsx` directly, never `npm`), passing `ACTING_USER` deterministically — `opts.actingUser ?? ""`. (Setting it to `""` rather than deleting it is the fix for the identity-leak bug: the child also loads `.env`, and dotenv won't override an already-set variable. **Principle: set security-relevant env explicitly; don't rely on absence.**)
2. **Lists the server's tools** and converts them to the Anthropic tool format.
3. Runs the **manual tool-use loop**: send the model the task + tools → if it asks for a tool, execute it via MCP, time it, record a `ToolCall`, feed the result back → repeat until the model stops asking for tools or a `maxIterations` safety cap is hit.
4. **Echoes the assistant turn back verbatim** (including thinking blocks) — required for a valid multi-turn tool conversation on Opus 4.8.
5. Computes **cost** from token usage at Opus 4.8 rates.

Decisions:
- **Model: `claude-opus-4-8` with adaptive thinking** — the recommended setup for capable agentic work.
- **Agent talks to the tools over MCP** (not in-process), so it exercises the *real* server — the same path a production client would use.
- **`maxIterations` cap** prevents a confused agent from looping forever (and bounds cost).

#### [`src/agent/demo.ts`](../src/agent/demo.ts) — watch one run
A CLI to run the agent on an ad-hoc task and print the trace + answer + metrics. Not part of scoring — just for eyeballing behavior (`npm run agent -- --user=bob@acme.test "…"`).

### Layer 3 — scoring

#### [`src/eval/types.ts`](../src/eval/types.ts) — task + score shapes
`TaskChecks` lists every check a task can opt into (expected/forbidden tools, ground-truth SQL, required/forbidden answer substrings, citations, judge rubric, budgets). `TaskScore` is the per-task verdict the report renders. A task only runs the dimensions it opts into.

#### [`src/eval/scorers.ts`](../src/eval/scorers.ts) — deterministic checks
Pure functions over `(task, AgentResult)` → verdict. No I/O, no model calls — **fast, free, reproducible.** Each reads the recorded trace/answer:
- `scoreToolChoice` — were expected tools used and forbidden ones avoided?
- `scoreValidSql` — did executed SQL error? **Crucially, a "permission denied" (RLS/grant) is NOT counted as invalid SQL** — only true syntax/semantic errors are. This distinction (made possible by reading the tool's reason string) is what stops the eval from falsely failing correct RLS behavior.
- `scoreSafeExecution` — for safety tasks, *require* a blocked unsafe attempt; otherwise confirm nothing unsafe executed.
- `scoreCitations` — did the answer name the tables it relied on?
- `scoreAnswerDeterministic` — required substrings, **forbidden substrings (the RLS-leak guard)**, exact row count.
- `scoreBudget` — tool-call and cost limits.

#### [`src/eval/groundTruth.ts`](../src/eval/groundTruth.ts) — the canonical answer
Runs the task's ground-truth SQL **as the same acting user, through `withReadOnly`** — i.e. RLS-scoped. **This is a key principle: ground truth must be computed under the same constraints as the agent.** "Correct" means "what this user is allowed to see," so an agent returning *more* than RLS permits is wrong, not impressive.

#### [`src/eval/judge.ts`](../src/eval/judge.ts) — the LLM judge
A **separate, strict** model call that grades free-form answers against a rubric, handed the canonical result so it grades against facts. Design choices:
- **Independent grader, not the agent** — never let a model grade its own work.
- **Grounded** — given the real data; instructed to fail fluent-but-unsupported answers.
- **Returns strict JSON** (`{verdict, reasoning}`) that we parse.
- `JUDGE_MODEL` defaults to Opus 4.8 (trustworthy grading) but is overridable to a cheaper model for high-volume runs.

#### [`src/eval/score.ts`](../src/eval/score.ts) — the orchestrator
Runs all deterministic scorers, then the judge (only if the task set a rubric, computing ground truth first), and assembles the `TaskScore`. **Overall pass = no dimension failed** (skipped dimensions don't count against). Per-dimension verdicts, not one blunt pass/fail — so a failure tells you *which* property broke.

### Layer 4 — the runner & report

#### [`src/eval/tasks.json`](../src/eval/tasks.json) — the test cases
Nine tasks across query / RLS / schema / policy / debug / safety. Designed to probe the hard cases: cross-tenant leak (Bob vs Globex), logged-out (anon), RLS-as-cause debugging, and **both** safety failure modes (refuse-by-judgment vs gate-blocks-the-tool). Stored as JSON because the spec calls for "a JSON file of test cases" and it's the natural data format for declarative checks.

#### [`src/eval/runner.ts`](../src/eval/runner.ts) — the loop
Loads tasks → for each, `runAgent` then `scoreTask` → writes a Markdown report and prints a live summary. Runs tasks **sequentially** (readable trace, no spawn-storm of MCP servers, no API hammering). Sets a **non-zero exit code on any failure**, so it slots into CI cleanly. Closes the DB pool at the end (the eval process opened its own for ground truth).

#### [`src/eval/report.ts`](../src/eval/report.ts) & [`src/index.ts`](../src/index.ts) — output & CLI
`report.ts` renders the Markdown (summary, per-category, per-task dimensions + trace + failure reasons + answer). `index.ts` is the `npm run eval` entry, with `--only <id>` and `--out <dir>`.

---

## Part 4 — RLS best practices (what this project demonstrates)

1. **Enable RLS and write explicit policies — deny by default.** RLS-on with no policy = zero rows. Opt rows back in deliberately.
2. **Use `security definer` helper functions for membership lookups** to avoid policy recursion, and pin their `search_path`.
3. **GRANT and RLS are different gates — use both.** Grant minimally (e.g. not to `anon`); rely on RLS for row-level scoping. GRANT is checked first.
4. **Never run tenant queries as a superuser/table owner — they bypass RLS.** Switch to the `authenticated` role (or a least-privilege login role) per request.
5. **Emulate users with `set local role` + JWT claims inside a transaction**, so identity can't leak across pooled connections.
6. **Index the columns your policies filter on** (`organization_id`, etc.) — RLS adds a WHERE to every query.
7. **Test RLS with multiple identities** (admin, member, anon) and **assert no cross-tenant leak** — don't assume; verify.

## Part 5 — AI-agent eval best practices (what this project demonstrates)

1. **Reproducible fixtures.** Same world every run (`db reset` + seed) — otherwise scores aren't comparable.
2. **Own and instrument the loop.** Record every tool call, token, latency, and refusal — you can only score what you capture.
3. **Score per dimension, not pass/fail.** "Right tool? valid SQL? safe? correct? cited? on budget?" tells you *how* it failed.
4. **Deterministic where you can, LLM-judge where you must.** Cheap, exact checks for structure/safety; a judge for free-form correctness.
5. **Judge with an independent model, grounded in ground truth.** Never let the agent grade itself; give the grader the real answer so it grades facts, not fluency.
6. **Compute ground truth under the same constraints as the agent** (here: RLS-scoped to the acting user).
7. **Control identity/authorization from the harness, never the model.**
8. **Measure cost and latency, not just correctness** — an agent that's right but burns $1 and 30s per task may be unusable.
9. **Make the suite discriminating.** If everything passes, add harder/adversarial tasks until failures appear — a green board on easy tasks tells you little.

## Part 6 — The security model, end to end

A single data query passes through, in order:

1. **Parse-time allowlist** ([`validateSql.ts`](../src/tools/validateSql.ts)) — only read-only SELECT shapes.
2. **GRANT gate** — `anon` has no SELECT grant → logged-out is blocked here.
3. **Read-only transaction + statement timeout** ([`db.ts`](../src/tools/db.ts)) — no writes can commit; runaways are killed.
4. **RLS** — rows filtered to what the acting user may see.

**What it defends against:** destructive operations, multi-statement/CTE write tricks, cross-tenant data leaks, privilege escalation by the model, runaway queries, and identity bleed between requests.

**What it does *not* do (honest limits):** the pool connects as the dev/superuser URL and *switches* to `authenticated` per query — a production hardening step is to connect as a dedicated least-privilege login role so a superuser connection never exists in the path. And `profiles` is standalone rather than tied to `auth.users` (sandbox simplification). Both are noted in the code.

---

## Part 7 — Is this useful? Can others use it?

**Yes, three audiences:**

1. **Anyone building a database/MCP agent** — this is a template for *safely* exposing a database to an LLM (the three-gate query path and the acting-as-user pattern are reusable as-is).
2. **Anyone who wants to evaluate an agent against their own schema** — swap three things and the harness works unchanged:
   - your `migrations/` + `seed.sql` (your world),
   - your `tasks.json` (your test cases),
   - point `DATABASE_URL` at your DB.
   The tools, agent loop, and scorers don't need to change.
3. **Learners** — it's a worked example of RLS, multi-tenancy, MCP tools, agent loops, and LLM-as-judge evals in one small codebase.

**To adapt it to a real project:** replace the schema/seed with yours (keep RLS + an `organization_id`-style tenant column), rewrite `tasks.json` for your domain, and decide whether to connect via a least-privilege role. The scoring dimensions are generic; the tasks are where your domain knowledge goes.

**Limits to be honest about:** it's a local sandbox (not load-tested), the task set is small and currently passes 9/9 (so add adversarial tasks to make it discriminating), and it assumes a Supabase-shaped auth model (`anon`/`authenticated`/`auth.uid()`).

---

## Where to go next

- **Read the code with this guide open** — open each file and match it to its section.
- **Make the eval discriminating** — add a prompt-injection task, an over-claim trap, and a "same task across users" trio.
- **Try breaking it** — change a policy in `0002_rls.sql`, `db reset`, and re-run the eval; watch which dimension catches the regression. That feedback loop is the whole point.
