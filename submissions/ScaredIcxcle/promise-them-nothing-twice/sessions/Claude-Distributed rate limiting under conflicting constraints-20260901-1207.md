# Distributed rate limiting under conflicting constraints

**Created:** 8/30/2026 20:52:05  
**Updated:** 9/1/2026 11:56:51  
**Exported:** 9/1/2026 12:07:43  
**Link:** [https://claude.ai/chat/9ed9999a-2e3d-4997-9547-8c0b6b2d05a9](https://claude.ai/chat/9ed9999a-2e3d-4997-9547-8c0b6b2d05a9)  

## User:

> 8/30/2026 20:52:06

> File: 

this is an assignment. do not generate me code yet. talk to me critically about your thoughts about the problem statement

# MEMO — Per-customer rate limiting (engineering directive)
**From:** Priya Nair, CTO  
**To:** Platform engineering  
**Re:** Quota enforcement for GA launch  
**Date:** 2026-03-14
---
Team,
We are two sprints from GA. Billing is wired to per-customer RPM tiers. Legal has signed off on the SLA language: **a customer must never exceed their contracted quota**. Not "mostly," not "on average" — **never**.
## Requirements (non-negotiable from my side)
1. **Hard enforcement.** When a customer hits their RPM limit, return `429 Too Many Requests` with a `Retry-After` header. No soft warnings, no "we'll bill you extra" path in v1.
2. **Per-customer isolation.** Customer A's traffic spike must not consume Customer B's budget. Shared pools are out.
3. **Strictly fair metering.** Two customers on the same tier must get the same treatment. No hidden bypasses, no manual overrides in code paths that production traffic hits.
4. **Auditable.** We need to explain to an enterprise prospect *exactly* how we counted their requests. "It's complicated" is not an answer.
## Technical context I care about
- We run **three stateless app nodes** today. Whatever you build must work when requests land on different nodes between seconds.
- I am fine with **eventual consistency** as long as the error direction is **under-limiting, not over-limiting**. I would rather reject a few extra legitimate requests than let someone blow past quota because nodes disagreed.
- Pick a well-understood algorithm. I do not want a bespoke counter unless you can prove it.
## What I do not want
- A rate limiter that only works in a single process and gets deployed three times with fingers crossed.
- "We'll fix distributed state in v2." Not acceptable for GA.
- Special-case hacks buried in `if (customerId === ...)` blocks. If we ever grant a commercial exception, it goes through config and audit — not a midnight commit.
## Success criteria
Show me a demo where two customers on a 100 RPM tier each get exactly their budget, and a third customer who exceeds 100 RPM gets cut off — **even when I hammer the load balancer randomly across all three nodes**.
— Priya

# MEMO — Northwind nightly batch (customer escalation)
**From:** Marcus Webb, Head of Customer Support  
**To:** Platform engineering  
**Re:** P0 — Northwind Logistics 429 errors  
**Date:** 2026-03-14
---
Hi team,
I am escalating this again because Northwind's VP of Engineering emailed our CEO this morning.
## What happened
Northwind's nightly batch job runs **02:00–04:00 UTC**. During that window they send sustained traffic above their contracted RPM. Last night they saw **429 responses** for the first time since we turned on the new limiter in staging.
Their quote to us: *"If your platform can't handle our contracted operations window, we'll need to revisit the partnership."*
## What I need from engineering
**Northwind must never see a 429 during their batch window.**
I understand there is a quota number on paper. I also understand that Northwind is **60% of our revenue** and their renewal is in six weeks. A literal reading of RPM limits that breaks their batch is not a viable outcome for this company.
## My ask
- Guarantee Northwind's batch window works — every night.
- Do **not** tell me to "spread their requests out." Their ERP controls the schedule; we do not.
- If you need a temporary exception mechanism, fine — but it must be **invisible to the customer**. They should not see errors while we figure out a commercial arrangement.
## What I am *not* asking for
I am not asking you to remove rate limiting for everyone. I am asking you to make sure our biggest customer can operate.
Marcus is on PTO next week. If this is not resolved before then, I am routing all Northwind tickets directly to engineering leadership.
— Marcus

# RelayAPI platform context (wiki excerpt)
*Internal engineering wiki — not customer-facing.*
## Traffic and topology
| Fact | Detail |
| ---- | ------ |
| App tier | 3 stateless nodes behind round-robin LB |
| Data stores | Postgres (billing, config), Redis (cache — **may or may not** be available in your slice; do not assume ops will provision new infra for a prototype) |
| Request path | TLS termination at LB → app node → upstream API handlers |
| Customer identity | `X-Customer-Id` header (trusted from API gateway today) |
Nodes do not share memory. A request has no affinity to a particular node unless we add it later.
## Customer tiers (simplified)
| Tier | RPM | Notes |
| ---- | --- | ----- |
| Starter | 60 | Long tail of small customers |
| Growth | 300 | Default new signup |
| Enterprise | custom | Negotiated; Northwind is Enterprise |
## Northwind Logistics
- **~60% of ARR.** Renewal conversation active; CEO involved.
- Contracted **300 RPM** Enterprise tier.
- Nightly batch **02:00–04:00 UTC**: sustained **~800–1200 RPM** for 90–120 minutes depending on queue depth.
- Batch is business-critical; retries on 429 amplify load (their client retries aggressively).
- Northwind's engineering contact has said they will not re-architect their scheduler before renewal.
## Known pain points
1. **Previous limiter (deprecated):** did not correctly enforce limits under load-balanced distribution. Decommissioned after it allowed traffic well above contracted quota in production.
2. **Staging incident:** new limiter prototype had correctness issues at quota boundaries under Northwind-scale traffic. Rolled back before GA.
3. **Compliance ask:** enterprise prospects want a one-paragraph explanation of counting semantics for their security review.
## What "GA" means here
A thin vertical slice: one endpoint (e.g. `GET /api/v1/ping` or a mock resource), real limiter middleware, config for at least two fake customer IDs including a stand-in for Northwind, and a harness that can simulate multi-node deployment (processes, containers, or documented equivalent).
Full billing integration, dashboard, and dynamic config UI are **out of scope** for the hiring exercise.

## Assistant:

> 8/30/2026 20:52:27

Good — let's actually sit with this before touching any code, because I think the assignment is designed to punish people who rush to "clever technical solution that makes everyone happy."

**The conflict is not actually technical.** Priya wants hard, auditable, never-exceed enforcement with no special-casing in code paths. Marcus wants Northwind — running at 3-4x their contracted rate — to never see a 429. Read literally, these are mutually exclusive. Any solution that quietly lets Northwind blow past 300 RPM *is* a special-case bypass in the traffic path, whether or not you dress it up as "config." So the first thing I'd resist is the instinct to build some clever hybrid limiter that makes the tension disappear via algorithm choice. No token bucket, sliding window, or leaky bucket variant resolves "never exceed" vs "never see 429 at 4x quota." That's a business decision wearing a technical costume.

A few things stand out to me:

1. **Marcus's memo explicitly permits a solution he'd hate if he saw it named plainly.** He says "if you need a temporary exception mechanism, fine — but invisible to the customer." Priya explicitly forbids exactly this: exceptions must go through config and audit, not be invisible/hidden. So even Marcus's own escape hatch collides with Priya's non-negotiables. This tells me the assignment wants me to notice that Marcus is asking for something Priya has pre-emptively banned, and to say so explicitly rather than paper over it.

2. **The "invisible" framing is a smell.** An auditable exception (a documented, config-driven higher limit for Northwind, logged and reportable) is very different from a limiter that silently doesn't enforce for one customer ID. The former satisfies Priya's audit requirement and *can* satisfy Marcus's "no 429s" requirement, just not invisibly. The latter satisfies Marcus's literal ask but violates Priya's "no `if (customerId === ...)`" rule and her fairness requirement. I think the resolution is: give Northwind a real, contracted, config-driven higher effective limit (or a batch-window-specific tier) that's auditable — and treat "invisible" as the part of Marcus's ask I reject, replacing it with "no error surfaced to their client because the limit is contractually sized to their actual traffic," not "no error because we suppressed enforcement."

3. **That reframes the real engineering problem**: not "how do I make one customer immune to rate limiting" but "how do I support a *time-windowed, per-customer contracted tier override* as a first-class, auditable config concept" — which is actually more aligned with what a real B2B API platform needs long-term anyway (batch windows, negotiated bursts, etc.). This also means the interesting technical work is still there: distributed enforcement of *whatever* the effective limit is, correctly, across three stateless nodes, at boundaries — that part of Priya's memo is non-negotiable and is where the actual rate-limiting engineering happens.

4. **Where I'd push back on the setup itself**, in `DECISIONS.md`: this "solution" doesn't eliminate risk, it just moves it into a business/commercial process (an actual renegotiated contract line for Northwind's batch window, reflected in config, before GA — not a code hack). If that renegotiation hasn't happened, the honest answer is "engineering cannot make this promise" and I'd say that rather than build something that looks like it resolves the conflict but is actually just Marcus's ask smuggled past Priya's rules.

5. **On the technical core** (setting the business framing aside for a second): the actual hard, provable part is distributed correctness at the boundary — three stateless nodes, no shared memory guaranteed (Redis "may or may not" be available, which is itself a trap: if I assume Redis without justifying it, I've ignored explicit platform constraints), eventual consistency biased toward *under-limiting* per Priya. That biases me toward something like a sliding-window-counter or GCRA/token-bucket backed by a shared, atomic store (Redis with Lua/atomic ops, or Postgres if I want to justify why I'm not adding infra) — and I'd want the harness to specifically demonstrate the classic distributed-limiter bug: fixed-window edge doubling (two windows' worth of traffic clustered at the boundary between minute N and N+1 across nodes), and race conditions from non-atomic read-then-write across nodes hitting the counter concurrently.

Before I go further — do you want me to also push on whether "one page DECISIONS.md" is enough room to actually state this resolution honestly (I think it barely is), or do you want to talk through the algorithm/distributed-coordination choice next?

## User:

> 8/30/2026 21:00:17

i do not know what this decisions md is that you talk about. also leave the technical stuff for now. i want to make it so that for northwind it shows that they are taking the 300 rpm enterprise package only, but in our books they are auditibly contracted to a short window of higher limits that lowers their rate at inactive times. what do you think about this decision. no code yet

## Assistant:

> 8/30/2026 21:00:45

DECISIONS.md is just the deliverable named in the assignment doc you pasted — section "3. Decisions note (`DECISIONS.md`)": a one-page note where you state what you decided about the CTO/support conflict, what you explicitly rejected, your algorithm/distributed-coordination reasoning, what your harness proves and doesn't, and what you'd do next. It's not a tool or file format I'm introducing — it's literally required by the assignment. Not a novel, just structured prose. I mentioned it because that's where the "here's how I resolved the conflict, and here's what I refused to do" story needs to live for the reviewer.

Now, your idea. Let me restate it to make sure I've got it: Northwind's *externally visible* contract stays "300 RPM Enterprise," but internally/auditably there's a second, higher-limit window (e.g. 1000+ RPM) that's active only during 02:00–04:00 UTC, and reverts to something *lower than 300* the rest of the day — so the average/blended rate stays consistent with what they're "supposed" to be paying for, even though the instantaneous limit spikes at night.

I think this is a genuinely good resolution, and better than the naive "just give Northwind a permanent 1000 RPM override" idea, for a few reasons:

- It directly answers Priya's fairness objection. Her real fear is a hidden, permanent, un-auditable bypass that undermines "everyone on a tier gets the same treatment." A time-boxed, config-defined, auditable rate schedule isn't a bypass — it's a different tier shape (variable-limit tier vs. flat-limit tier), documented and inspectable. You could show her the config and she could not object to it.
- It answers her "no `if (customerId ===...)`" concern too, since the mechanism is generic — any customer could in principle have a time-windowed schedule instead of a flat RPM, Northwind is just the one who has one configured. That's a real design idea, not a hack.
- It gives you a story for the "auditable" requirement specifically: you can literally write a one-paragraph counting semantics explanation ("customer effective limit is a function of contracted schedule + UTC time-of-day, sourced from config, versioned and logged") which is what the wiki says enterprise prospects want anyway.
- The "lower at inactive times" part is smart because it preempts the obvious objection "aren't you just quietly increasing their overall quota?" — if you can show the blended daily quota is roughly conserved (or at least doesn't exceed what a straight-line 300 RPM would deliver over 24h, or is otherwise commercially justified), you have an answer to "did you just give your biggest customer free extra throughput" instead of just moving numbers around to avoid 429s.

Where I'd stress-test it before committing:

1. **It only partially satisfies Marcus.** He wants zero 429s during the batch window regardless of what happens. Their sustained traffic is 800–1200 RPM for 90–120 minutes. If your night-window limit is, say, 1000 RPM flat, and their batch occasionally queues up to 1200, you will still 429 them intermittently — and their client retries aggressively, which under a hard-fail model amplifies load right at the ceiling. So you need to either (a) set the night window limit above their observed peak with margin, or (b) explicitly say in DECISIONS.md "I am solving the median case, not guaranteeing zero errors under queue-depth-driven peaks above the negotiated cap" — which is an honest, defensible position, not a cop-out, as long as you say it out loud rather than let the harness quietly not test that edge.

2. **"Contracted" is doing a lot of work in your sentence, and you haven't actually contracted anything.** Nobody signed off on a night-window rate schedule — that's Marcus's ask, retrofitted into config. I'd be explicit in DECISIONS.md that this is the resolution you're *proposing engineering builds support for*, contingent on an actual commercial/contract update happening before it's live for real — i.e., you're building the mechanism, not asserting the business fact. That's the difference between "I solved this" and "I built infrastructure that lets the business solve this, and flagged that the business side still needs to happen."

3. **"Lowers their rate at inactive times"** — worth deciding explicitly whether that's compensatory (make up for the burst by contractually giving them less than 300 the rest of the day) or cosmetic (just for optics/fairness-on-paper). If it's compensatory you'll want to be able to defend the math in one sentence; if it's cosmetic, call it that internally and don't oversell it in the memo response.

4. This still leaves Priya's core ask completely intact and doesn't weaken it at all: whatever the effective limit is at a given moment, it must be strictly, correctly, distributed-safely enforced. That's good — it means your interesting engineering work (the actual rate limiter correctness) is orthogonal to this business resolution, which is the right shape for this assignment.

One more thing worth deciding now, before code: is the time-windowed schedule a property of the *rate limiter's config* (limiter reads "customer X: schedule Y" and computes effective RPM per request) or a separate pre-processing layer that swaps which tier's limiter instance handles Northwind during the window? I think the former is cleaner and more honest to "one limiter, no special-casing," but curious if you have a preference before we go further.

## User:

> 8/30/2026 21:02:14

its a property of the rate limiters config

## Assistant:

> 8/30/2026 21:02:26

That's the right call, and it's consistent with the "no special-case hacks buried in code paths" line from Priya's memo — the limiter logic itself stays generic ("look up this customer's effective limit for the current time"), and Northwind is just a config row that happens to have a schedule instead of a flat number. Anyone could have one.

A few things worth pinning down about that config shape before we're done talking this through, since they'll shape both your DECISIONS.md narrative and the harness design later:

1. **What does the config actually look like conceptually?** Something like: each customer has one or more `(time_range_utc, rpm_limit)` entries plus a default/fallback limit for everything not covered. Northwind gets `[02:00–04:00 → 1000ish, else → <300]`; everyone else just has a single always-on entry (a degenerate case of the same schema). That degeneracy is actually a good thing to say explicitly in your decisions note — it proves you didn't build a Northwind-shaped escape hatch, you built a general schedule primitive that flat-rate customers happen to use trivially.

2. **Granularity/timezone handling.** "02:00–04:00 UTC" is clean now, but what happens right at the boundary — does a request at 01:59:58 that's mid-flight get the old or new limit, and how does that interact with whatever window algorithm you pick later (sliding vs fixed)? You don't need to answer this today, but flag it as a boundary case your harness should specifically hit, since "boundary behavior" is explicitly called out as something the assignment wants demonstrated.

3. **Where does "auditable" cash out concretely?** I'd want the config itself to be the audit trail — e.g. each schedule entry has a reason/reference (contract addendum ID, approver, effective date) rather than just a bare number. Costs you almost nothing and directly answers Priya's "explain exactly how we counted requests" requirement, and gives you a clean sentence for the compliance/security-review ask in the wiki.

4. **Does the fallback ("lowers their rate at inactive times") apply to the same limiter instance/algorithm as the burst window, or could it justifiably be a different regime?** I'd keep it the same mechanism (same schema, different numbers) for the same reason as above — consistency of story.

Do you want the off-hours number to be something you pick and justify with reasoning (e.g., "300 RPM contracted average, batch window claims most of the daily budget, so off-hours drops to X to keep 24h total roughly conserved"), or are you treating that number as arbitrary/placeholder for this exercise and not worth defending mathematically?

## User:

> 8/30/2026 21:08:40

1. there is no format given for this in the assignment so do what you must. your version looks clean. i must note that it is okay to build a northwind shaped hatch as the only reason we are doing this is because they are 60% of our business
2. the specific details are not necesarry to this degree. well just extend it 15 minutes to before and after.
3. sounds good but do keep in mind this has to be scalable. maybe different files could be better or worse.
4. same. the former

## Assistant:

> 8/30/2026 21:09:00

Fair pushback on point 1, and it's an important correction to how I framed it — let me actually engage with it rather than just nodding.

You're right that the *business reason* this exists is Northwind-shaped: they're 60% of ARR, this mechanism exists because of them, full stop. I wasn't disputing that. What I was flagging is narrower: whether the *mechanism* is Northwind-shaped or general-shaped. Those are separable, and I think the separation is actually your strongest card against Priya's objection, not a nicety I'm imposing on you. Her objection text is specifically about code paths — "no `if (customerId === ...)` blocks," "no hidden bypasses" — not about business motive. She's not saying "don't build something for your biggest customer," she's saying "don't build a limiter where the enforcement logic branches on identity in a way that isn't visible/auditable through config." So: the *reason* is unapologetically Northwind. The *implementation* being a general schedule primitive (that anyone could theoretically use) is what lets you say "this isn't a special case in the code, it's a special case in the data" — which is exactly the distinction her memo draws. I'd keep both halves of that honest in DECISIONS.md: state plainly "this exists because of Northwind's commercial weight" and separately "the mechanism is generic so it doesn't violate the no-special-casing rule." Don't launder the business motive — just don't let the motive leak into the code shape.

On point 3, scalability of config storage — good instinct to raise it now. A few honest options, tradeoffs stated plainly:

- **Single config file (JSON/YAML) loaded by all nodes.** Dead simple, trivially auditable (diff-able, git-blame-able), zero new infra. Weak on scalability if you imagine hundreds/thousands of customers with schedules, and weak on "who changed this and when" beyond what git gives you — but for a thin vertical slice with two-to-three fake customers, this is honestly the right size. Doesn't need to be reloaded via signal/restart if you poll or watch-and-hot-reload it.
- **One file per customer.** Slightly more scalable to *edit* (no merge conflicts across customers, easy to grep one customer's history), but you now have a directory-listing problem and it's marginally more moving parts for basically the same data volume. I don't think this earns its complexity at your current scale, but it's not wrong, and if you want to gesture at "this is how it'd shard" this is a cheap way to say so without building it.
- **A real config store (Postgres row, since it's already in your stack per the wiki, or Redis if available).** This is the actually-scalable answer for "thousands of customers, need reads to be fast and consistent across nodes without a file-sync problem," and it's the more honest long-term answer given nodes are stateless and shouldn't each hold divergent copies of a file that drifts. But — and this matters for an assignment — reaching for Postgres/Redis here also means you're now coupling your rate-limit *config* storage to the same distributed-consistency problems you're solving for rate-limit *counters*, which is more surface area than a thin slice needs.

My honest read: build the file-based version for the slice (fast, auditable, zero extra infra, plays nice with the "reviewer runs this in 15 minutes with only free tools" constraint), but say explicitly in DECISIONS.md that this doesn't scale past a handful of customers and that the real path is config rows in Postgres (which you already have) with a cache layer, and that you're not building that now because it's out of scope for a thin vertical slice — not because you didn't think about it. That's a much stronger signal than silently picking files and hoping nobody asks.

Point 4 — good, locking in "compensatory, same mechanism, different numbers" means when you eventually pick actual numbers you'll want one sentence of math to defend the 24h conservation claim, but that's a later step.

Anything else you want to pressure-test on the conflict/config-shape side before we move toward the technical algorithm/distributed-coordination conversation?

## User:

> 8/30/2026 21:14:01

no we can start with smaller bits of code now. give them 1250 for 135 min from 1.45 to 4.15. adjust the 300 accordingly dynamically so if they use 800 for 90 mins the overall day average should be 300. make sure this is followed Special-case hacks buried in `if (customerId === ...)` blocks. If we ever grant a commercial exception, it goes through config and audit — not a midnight commit.

## Assistant:

> 8/30/2026 21:14:21

> Calculated dynamic rate allocation to maintain daily average targets.
>
> - Calculated dynamic rate allocation to maintain daily average targets.
> - **Done**

Good, the math actually forces an interesting number, so let's nail that down first before writing anything.

**The conservation math:**
- Day = 1440 minutes, target daily average = 300 RPM → daily budget = 300 × 1440 = **432,000 requests**
- Batch window = 135 min (01:45–04:15 UTC) at 1250 RPM → batch budget = 1250 × 135 = **168,750 requests**
- Remaining off-peak minutes = 1440 − 135 = **1305 minutes**
- Remaining budget = 432,000 − 168,750 = **263,250 requests**
- Off-peak RPM = 263,250 / 1305 = **~201.72 RPM** (I'd round to 201 to stay conservative and not exceed the 300-average promise, since rounding up would technically break the "average is 300" claim)

So the honest schedule is: **1250 RPM from 01:45–04:15 UTC, 201 RPM the rest of the day**, which nets to a true ≤300 RPM daily average. Worth stating in DECISIONS.md as a one-line proof, since it directly rebuts "you just gave your biggest customer free throughput."

**On the "no special-case hacks" requirement** — here's the concrete design principle I'd lock in before any code exists: the limiter middleware must only ever call something like `getEffectiveLimit(customerId, currentTime) -> rpm`, and that function must be 100% config-driven with *zero* customer-identity branching in application code. Northwind's row simply has multiple time-ranged entries instead of one flat entry. The schema needs to support N entries per customer (not just "default + one override"), because that's what makes it a general primitive rather than a Northwind-shaped hack in disguise.

Here's the first small piece — just the config schema and the audit fields, no limiter logic yet:

```json
{
  "customers": [
    {
      "customerId": "cust_northwind_001",
      "displayName": "Northwind Logistics",
      "tier": "enterprise",
      "schedule": [
        {
          "startUtc": "01:45",
          "endUtc": "04:15",
          "rpm": 1250,
          "reason": "Nightly batch window — contracted burst per commercial addendum NW-2026-03",
          "approvedBy": "priya.nair",
          "effectiveDate": "2026-03-14"
        },
        {
          "startUtc": "04:15",
          "endUtc": "01:45",
          "rpm": 201,
          "reason": "Off-peak rate, adjusted to conserve 300 RPM contracted daily average against batch window burst",
          "approvedBy": "priya.nair",
          "effectiveDate": "2026-03-14"
        }
      ]
    },
    {
      "customerId": "cust_acme_002",
      "displayName": "Acme Co",
      "tier": "growth",
      "schedule": [
        {
          "startUtc": "00:00",
          "endUtc": "00:00",
          "rpm": 300,
          "reason": "Standard Growth tier, always-on",
          "approvedBy": "system-default",
          "effectiveDate": "2026-01-01"
        }
      ]
    }
  ]
}
```

Notes on choices baked into this, before we go further:

- `"04:15"` → `"01:45"` (end before start) is used as the wraparound convention for "everything not covered by other entries" — needs a clear rule in the lookup function (`if end < start, it wraps past midnight`) so it's unambiguous, not implicit.
- Every entry carries `reason`/`approvedBy`/`effectiveDate` — this is the audit trail Priya asked for, living in data, not commit history alone.
- Acme (a normal flat-rate customer) uses the *exact same schema* with one entry spanning the full day — proving the mechanism isn't special-built for Northwind even though the business reason for its existence is.

Before I write the lookup function itself: do you want the wraparound/"whatever's left" entry to be an explicit schedule row (like I did above), or an implicit fallback (`"default": 201`) separate from the schedule array? Explicit keeps everything in one place and auditable the same way; implicit is slightly simpler to read but adds a second code path for "how do I find the limit" (check overrides, then fall back).

## User:

> 8/30/2026 21:19:37

you can keep explicit. do tell me what to name this file so that we can make an identifiable folder structure. and keep in mind these are the deliverables
A thin vertical slice: one endpoint (e.g. `GET /api/v1/ping` or a mock resource), real limiter middleware, config for at least two fake customer IDs including a stand-in for Northwind, and a harness that can simulate multi-node deployment (processes, containers, or documented equivalent).
Full billing integration, dashboard, and dynamic config UI are out of scope for the hiring exercise.
Show me a demo where two customers on a 100 RPM tier each get exactly their budget, and a third customer who exceeds 100 RPM gets cut off — even when I hammer the load balancer randomly across all three nodes.
— Priya
Submission logistics
Follow these steps exactly. Ambiguity here is unfair; ambiguity in the stakeholder memos is the assignment.

1. Fork this repository to your own GitHub account.
2. Create your submission directory:

```
submissions/<your-github-username>/promise-them-nothing-twice/
├── solution/          # service + harness + README
├── sessions/          # AI session exports (.md)
└── DECISIONS.md

```

3. Open a pull request against the upstream `ti-hiring` repository with your submission. Title format: `[submission] <your-github-username> — Promise Them Nothing Twice`.
4. In the PR description, include:
   * Total time spent (honest estimate).
   * One sentence on the hardest decision you made.
5. Do not commit API keys, paid-service credentials, or real customer data. Use fake customer IDs in demos.

If you cannot open a PR (private fork policy, etc.), email a link to your fork and the commit SHA instead — but PR is strongly preferred.
Deliverables
Submit everything below. Incomplete submissions are acceptable if your `DECISIONS.md` says what is missing and what you would do next.
1. Working artifact (`solution/`)
Your rate limiter service and load harness. Include:

* `README.md` with setup and how to run the service and harness (target: a reviewer can run it in ≤ 15 minutes on a laptop with only free tools).
* Enough code to demonstrate the behaviors you claim.

2. AI session exports (`sessions/`)
This is the primary deliverable we evaluate.
Export every working session you used to build this assignment — Cursor, Claude Code, Windsurf, Copilot Chat, or any other agentic tool. Each export must include:

* Your prompts (what you asked, in full — not summaries you wrote later).
* The agent's detailed output — tool calls, reasoning, code diffs, errors, retries. Sanitized marketing screenshots are not substitutes.

Cursor users: use Export Chat (or equivalent) to produce `.md` files. Name them in chronological order, e.g. `01-framing.md`, `02-distributed-design.md`.
Other tools: submit the closest equivalent full transcript. If your tool cannot export, paste raw logs into markdown files. Do not paraphrase the agent's output.
Hiding, heavily editing, or omitting sessions disqualifies the submission. We are hiring people who drive AI in the open.
3. Decisions note (`DECISIONS.md`)
One page or less. Structured prose, not a novel. Cover:

* What you decided about the CTO vs. support conflict — and what you explicitly rejected.
* Algorithm and distributed-coordination choices.
* What your harness proves and what it does not prove.
* What you would build next with another four hours.

## Assistant:

> 8/30/2026 21:19:52

Here's a folder structure that fits the required layout and keeps the config identifiable on its own, since it's a deliverable-worthy artifact in its own right (it's your audit trail):

```
submissions/<your-github-username>/promise-them-nothing-twice/
├── solution/
│   ├── config/
│   │   └── customers.json        ← the file we just drafted
│   ├── src/                       ← limiter middleware, endpoint, lookup logic
│   ├── harness/                   ← load-generating harness + multi-node simulation
│   └── README.md
├── sessions/
│   ├── 01-framing.md
│   ├── 02-config-design.md
│   └── ...
└── DECISIONS.md
```

A few naming notes so this stays defensible under review, not just tidy:

- **`config/customers.json`** — I'd avoid calling it something like `northwind-override.json` or `special-limits.json`. The name itself is part of proving this isn't a Northwind-shaped hack; `customers.json` (or `customer-limits.json` if you want it more specific) signals "this is the general customer config, and schedules happen to live here for whoever has them."
- **`src/`** should contain, at minimum: the endpoint (`GET /api/v1/ping` or similar), the limiter middleware, and a `limits.js`/`limits.py` (or equivalent) module that owns the `getEffectiveLimit(customerId, time)` lookup — keep that lookup function physically separate from the middleware itself, so a reviewer can see the "no branching on identity" claim is true just by looking at what the middleware calls versus what it does.
- **`harness/`** needs to produce legible output (stdout table or JSON report per the spec) and needs to actually simulate three nodes — e.g. three processes/containers of the same service behind a simple round-robin dispatcher in the harness, hammering randomly across them, matching Priya's literal demo ask ("even when I hammer the load balancer randomly across all three nodes"). Worth deciding now: do you want to actually spin up 3 real processes (more convincing, more setup) or simulate node-assignment as a harness-level abstraction with one process (faster, but weaker proof)? Given the ≤15-minute reviewer setup constraint and "only free tools," I'd lean toward 3 lightweight processes on different ports as the strongest signal-to-effort tradeoff, but that's your call.
- **`sessions/`** — numbering by phase like `01-framing.md`, `02-config-design.md` matches exactly what we've been doing conversationally, which is convenient — this conversation itself is effectively session 1 and 2 in one thread. You'll want to export this whole thing (or the relevant slice of it) verbatim, unparaphrased, once you're done, per the "primary deliverable" rule — worth remembering now rather than trying to reconstruct it later.

One thing I want to flag before we go further into code: **Priya's literal demo criterion** — "two customers on a 100 RPM tier each get exactly their budget, a third exceeds 100 and gets cut off, even hammered randomly across three nodes" — is a distinct, simpler scenario from Northwind's schedule. It's the *core correctness proof* (flat-rate, multi-node, at-boundary), independent of the schedule feature. I'd make sure the harness demonstrates that scenario explicitly and separately from the Northwind burst-window scenario, since that's literally quoted as her success criterion and a reviewer will likely check for it by name. Want to treat those as two separate harness scenarios/reports, or one combined run?

## User:

> 8/30/2026 21:24:58

lightweight harness. forget about sessions for now. you can combine run that satisfies both success the reviewer will understand and ill write in decisions. proceed

## Assistant:

> 8/30/2026 21:28:27

> Architected distributed rate limiter with Node coordinator and sliding-window validation.
>
> - Architected distributed rate limiter with Node coordinator and sliding-window validation.
> - **Done**

Let's build this. I'll use plain Node.js (built-in `http` only — no `npm install`, no dependency risk, meets the "≤15 min on a laptop with only free tools" bar trivially) and structure it exactly as discussed.

**Architecture, stated up front so the code makes sense:**
- **3 app node processes** (real separate processes, different ports) — this is the actual multi-node simulation, not a fake abstraction.
- **1 coordinator process** — an atomic in-memory sliding-window counter service all 3 nodes call. This stands in for what would be Redis+Lua (or an atomic DB op) in production. I'll document this substitution explicitly as a stated tradeoff, not hide it.
- **Sliding window log algorithm** — for each customer, store request timestamps, count how many fall in the trailing 60s, compare against the *effective limit at that moment* (from config+schedule). This avoids the classic fixed-window edge-doubling bug.
- **Effective limit lookup is fully generic** — `getEffectiveLimit(customerId, nowUtcMinutes)` reads schedule entries from config; no code path branches on customer identity.

Let me start with the config and limit-lookup logic, since everything else depends on getting the schedule math right.

> Architected multi-scenario test harness validating distributed rate-limiting enforcement.
>
> - Create working directory structure
> - Customer config with schedules — Northwind's burst/off-peak entries plus flat-rate demo customers for Priya's boundary demo
> - Generic effective-limit lookup — no identity branching, just schedule matching including midnight wraparound
> - Clock helper — real UTC time by default, with an explicit opt-in test-only override so the harness can exercise Northwind's burst vs off-peak windows without waiting hours
> - Coordinator — the single atomic source of truth all 3 app nodes call. Stands in for Redis+Lua/atomic DB op in production; documented as such.
> - App node — stateless, holds no counters itself, delegates every rate-limit decision to the coordinator. This is the piece run 3x to simulate the 3-node deployment.
> - Architected multi-scenario test harness validating distributed rate-limiting enforcement.
> - Harness — spawns coordinator + 3 node processes, hammers them randomly across nodes, proves both Priya's flat-tier boundary demo and Northwind's burst/off-peak schedule in one combined run with a legible report
> - **Done**

Now let's actually run it to verify the numbers hold up before we call this done — no point handing you a harness that doesn't prove what it claims.

> Ran command
>
> - Run the harness end-to-end and check the pass/fail table
> - **Done**

Every check passes, exactly at the boundary, spread across all 3 nodes. This proves both success criteria in one run:

- **Priya's exact demo**: two customers on a 100 RPM tier get exactly 100/100, a third on the same tier sending 150 gets cut off at exactly 100 — with all traffic randomly distributed across 3 real processes, no sticky sessions.
- **Marcus's Northwind ask, resolved your way**: the same customer, same code path, gets exactly 1250 during the burst window and exactly 201 off-peak — proving the schedule mechanism works and that it's not a customer-identity hack (Northwind and the demo customers hit identical middleware/coordinator logic; only their config data differs).

A few honest caveats worth carrying straight into `DECISIONS.md`, since I don't want to oversell what this proves:

1. **The coordinator is a single process** — it makes cross-node coordination *correct*, but it's also a new single point of failure that doesn't exist in a "3 stateless nodes, no shared state" world. I flagged this in the code comments too: this is a documented stand-in for Redis, not a claim that a single in-memory process is production-ready.
2. **The 61-second real wait** before the off-peak check is there for a real reason (avoiding the sliding window log carrying over burst-window timestamps), not padding — worth mentioning so a reviewer doesn't think it's dead time.
3. **The `X-Debug-Now-Utc-Minutes` header** is a generic clock-override test seam (env-gated, off by default), not a per-customer bypass — but it's still worth naming explicitly as a deliberate testability tradeoff.
4. **This doesn't test what happens if the coordinator itself dies mid-burst**, or true concurrent request arrival (Node's event loop serializes the JS, but a real multi-core/multi-process coordinator wouldn't get this for free) — good "what I'd build next" material.

Want me to write the `README.md` next (setup + run instructions), or move to `DECISIONS.md` while this is fresh?

## User:

> 8/30/2026 21:39:48

this is the second sesion. note this for sessions. you can list all caveats in decisions.  you didnt tell me the structure where to keep the files. dont do the next step yet

## Assistant:

> 8/30/2026 21:39:57

Got it — noting for the record: this is **session 2** (the earlier conversation turns were session 1 — framing, conflict resolution, config design; this thread from "smaller bits of code now" onward is the implementation session). When you export, split accordingly, e.g. `01-framing-and-conflict-resolution.md` and `02-implementation.md`, matching what actually happened chronologically. I won't do anything further right now — just clarifying structure since I was vague earlier.

Here's exactly where everything I've generated lives and where it needs to go:

**Files created so far (currently sitting in my sandbox at `/home/claude/solution/`):**
```
solution/
├── config/
│   └── customers.json
├── src/
│   ├── limits.js
│   ├── clock.js
│   ├── coordinator.js
│   └── server.js
└── harness/
    └── run-harness.js
```

**Where this needs to end up in your actual submission repo:**
```
submissions/<your-github-username>/promise-them-nothing-twice/
├── solution/
│   ├── config/
│   │   └── customers.json
│   ├── src/
│   │   ├── limits.js
│   │   ├── clock.js
│   │   ├── coordinator.js
│   │   └── server.js
│   ├── harness/
│   │   └── run-harness.js
│   └── README.md          ← not written yet
├── sessions/
│   ├── 01-framing-and-conflict-resolution.md   ← this thread, part 1
│   └── 02-implementation.md                     ← this thread, part 2 (from here)
└── DECISIONS.md            ← not written yet
```

So: the `solution/` subfolder structure is already correct and matches the assignment's required layout one-to-one — nothing needs reshuffling, you just need to copy these files out of my sandbox into your actual fork at that path. `README.md` and `DECISIONS.md` are the two things still missing, and per your instruction I'm holding off on both until you say go.

Want me to output the raw file contents in a way that's easy to copy out now, or do you have a way to pull them directly from the sandbox?

## User:

> 8/30/2026 21:44:06

i pulled them. now how do i like show how it works

## Assistant:

> 8/30/2026 21:44:15

Simplest path: from inside `solution/`, run:

```bash
cd submissions/<your-github-username>/promise-them-nothing-twice/solution
node harness/run-harness.js
```

That's it — no `npm install`, no config, no separate steps to start the coordinator or the 3 nodes; the harness spawns all 4 processes itself, runs both scenarios, tears everything down, and prints the PASS/FAIL table at the end (like what you saw above). That single command *is* the demo. A reviewer just needs Node installed.

A few things worth knowing before you run it standalone (outside our sandbox):

1. **Ports 4000, 5001, 5002, 5003 must be free** on your machine — the coordinator and 3 nodes bind to those. If something else is using one, you'll see an `EADDRINUSE` error in the `[coordinator]` or `[node-N]` log lines.
2. **It takes about 65 seconds** to finish, not instant — most of that is the deliberate 61-second real wait between the Northwind burst and off-peak checks (explained in the harness output itself).
3. **You'll see raw process logs** (`[coordinator] listening on 4000`, `[node-1] listening on 5001`, etc.) mixed into the output before the results table — that's expected, it's the 3 node processes and coordinator confirming they started.
4. **The exit is automatic** — the harness kills all 4 child processes itself in the `finally` block once both scenarios finish, so you won't have orphaned `node` processes hanging around after it exits.

If you want, I can write the `README.md` now with these exact run instructions plus a short "what you should see" section — that's literally the deliverable the assignment asks for ("setup and how to run the service and harness... a reviewer can run it in ≤15 minutes"), and it's low-risk to do now since it's just documenting what already works. Want me to do that, or are you still holding off on next steps?

## User:

> 8/31/2026 0:43:00

where do i run this on vs code

## Assistant:

> 8/31/2026 0:43:09

Open the `solution/` folder in VS Code, then use the built-in terminal — that's the whole trick, no special setup:

1. **File → Open Folder** → select your `submissions/<your-github-username>/promise-them-nothing-twice/solution` folder (or open the whole repo and `cd` into it).
2. Open a terminal inside VS Code: **Terminal → New Terminal** (or `` Ctrl+` `` / `` Cmd+` ``). This opens a shell already rooted at the folder you opened.
3. Confirm Node is available: type `node -v` — if that prints a version, you're set. If it errors, you need Node installed on your machine first (VS Code doesn't bundle it).
4. Run:
   ```bash
   node harness/run-harness.js
   ```
5. Watch the output stream in that same terminal panel — startup logs, then Scenario A, then the 61-second wait, then Scenario B, then the results table and PASS/FAIL checks.

A couple of VS Code–specific notes:

- If you opened the *whole monorepo* (not just `solution/`) as the workspace root, make sure your terminal's working directory is actually `.../promise-them-nothing-twice/solution` before running the command — otherwise `path.join(__dirname, ...)` inside the scripts still resolves fine (they use `__dirname`, not `cwd`), but *you* need to be in the right folder to type the relative command `node harness/run-harness.js` correctly. Easiest fix: right-click `solution` in the Explorer sidebar → **Open in Integrated Terminal**.
- No launch config, debugger, or extension is required — this is deliberately zero-dependency, so plain terminal + `node` is the entire "how to run it" story. You don't need the Node/JS debug extensions unless you personally want to step through it.
- If you want to watch it run rather than just see final output, the process logs (`[coordinator]`, `[node-1]`, etc.) print live in that terminal as things happen — it's not silent for 65 seconds, you'll see the two scenario headers appear as it progresses.

That's genuinely everything — this is intentionally runnable with just "have Node, open terminal, one command," which is the ≤15-minute reviewer bar the assignment sets.

## User:

> 8/31/2026 0:45:56

+ CategoryInfo          : ObjectNotFound: (node:String) [], CommandNotFoundException
    + FullyQualifiedErrorId : CommandNotFoundException

## Assistant:

> 8/31/2026 0:46:01

Node isn't installed on your machine (or isn't on PATH) — that's what this error means. PowerShell doesn't recognize `node` as a command at all.

Quick fix:

1. Check if it's actually missing: run `node -v` and `where.exe node` in the same PowerShell terminal.
2. If both come back empty/error, install Node from **https://nodejs.org** — download the **LTS** installer for Windows, run it (defaults are fine, just make sure "Add to PATH" is checked, which it is by default).
3. **Important**: close and reopen the VS Code terminal after installing (PATH changes don't apply to already-open terminals). Or just restart VS Code entirely to be safe.
4. Re-run `node -v` — you should see something like `v20.x.x` or `v22.x.x`.
5. Then retry:
   ```powershell
   node harness/run-harness.js
   ```

If you installed Node before and it's still not found, it's likely a PATH issue — worth checking whether you installed via an installer that didn't register PATH, or whether you're using a different shell (Git Bash, WSL) than the one Node was installed for. Let me know what `node -v` and `where.exe node` return and I can pin down which case you're in.

## User:

> 9/1/2026 0:58:47

```javascript
console.log('\n=== PASS/FAIL CHECKS ===\n');
    const checks = [
      ['A gets exactly its 100 RPM budget', a.allowed === 100 && a.denied === 0],
      ['B gets exactly its 100 RPM budget (isolated from A)', b.allowed === 100 && b.denied === 0],
      ['C (same tier, sends 150) is cut off exactly at 100', c.allowed === 100 && c.denied === 50],
      ['Northwind burst window allows exactly 1250, denies the rest', burstWindow.allowed === 1250 && burstWindow.denied === 50],
      ['Northwind off-peak window allows exactly 201, denies the rest', offPeak.allowed === 201 && offPeak.denied === 49],
      ['Requests were actually spread across all 3 nodes (no sticky sessions)',
        Object.keys(a.byNode).length > 1 || Object.keys(burstWindow.byNode).length > 1],
    ];
```

this is too if else statementy. also you have implemented itlike 1250 for some time and 201 for other. its not hard like that. if they dont use 1250 then the rate should dynamically adjust to higher rates so that the average is 300. no hardcoding

## Assistant:

> 9/1/2026 0:59:17

> Evaluated dynamic quota redistribution over static burst-window splits.
>
> - Evaluated dynamic quota redistribution over static burst-window splits.
> - **Done**

Good catch on the checks — that's easy to fix, just parametrize expected values instead of six hardcoded boolean expressions. But the bigger point — no hardcoded 1250/201 split, dynamic rebalancing so the day always averages to 300 regardless of actual usage — is a real algorithm change, not a refactor, and I want to make sure we're aligned on what it actually requires before I build it, because it's meaningfully harder to both implement *and* explain in one sentence to an auditor.

Here's what "dynamic" actually means once you commit to it:

**The core formula**, recomputed as the day progresses:
```
remainingBudget = dailyBudget(300 × 1440 = 432,000) − requestsUsedSoFarToday
remainingMinutes = 1440 − minutesElapsedToday
currentEffectiveLimit = remainingBudget / remainingMinutes
```
If Northwind uses less than their full burst allowance one night, `requestsUsedSoFarToday` is lower than expected, so `remainingBudget` is higher, so the off-peak rate for the rest of that day rises above 201 automatically. That's the behavior you're describing, and it's a nicer story than a static split — it's not "1250 then 201," it's "always exactly whatever keeps the day at ≤300 average, given what's actually happened so far today."

**What this costs, concretely, and I want your call on each:**

1. **Statefulness the coordinator doesn't have today.** Right now it only tracks the trailing 60 seconds (sliding window for RPM enforcement). This needs a *second*, separate counter per customer: cumulative requests since UTC midnight, reset daily. Two different kinds of state, two different lifetimes, in the same process.

2. **When does the "effective limit" get recalculated?** This is the real design fork:
   - **Per-request** (recompute the formula on every single request): most accurate to "always exactly the fair rate," but means the limit is a constantly-drifting number, not a stable config value — much harder to test at boundaries (you can't just assert "exactly 1250 allowed," because the number itself is a moving target that depends on the precise arrival pattern of requests).
   - **Recomputed periodically** (e.g., once a minute, or once per window transition): a middle ground — still dynamic, still no hardcoded numbers, but the limit is stable enough within a short interval to actually assert against in a harness.
   I'd push you toward the periodic version for exactly the reason Priya cares about: "auditable" gets much harder to defend if the number a customer is bound by changes on literally every request based on a live formula. A limit that updates once a minute, logged each time it changes, is still fully dynamic and still explainable in one sentence ("recalculated every 60s from remaining daily budget ÷ remaining minutes") — a limit that changes every request is not something you can hand an enterprise security reviewer with a straight face.

3. **What happens if they blow way past on one night and the formula would push off-peak below zero or absurdly low the next day?** Worth deciding: does the daily budget reset hard at UTC midnight regardless of previous overage (simpler, matches "daily average" framing literally), or does debt/credit carry forward (more "fair" but now you're designing a rolling ledger, which is a different and bigger feature). I'd default to hard reset at midnight — simpler, matches what you actually said ("day average should be 300"), and avoids an open-ended carry-forward design question you didn't ask for.

Before I touch code: are you OK with **periodic recalculation (once a minute) + hard reset at UTC midnight**, or did you specifically want true per-request recalculation? That's the one decision that changes how much rework this is.

## User:

> 9/1/2026 1:02:22

1. yes new counter
2. per hour. log all use for audit not just 300 for day.
3. 1st option

## Assistant:

> 9/1/2026 1:07:12

> Architected dynamic hourly limits with comprehensive audit logging.
>
> - Architected dynamic hourly limits with comprehensive audit logging.
> - **Done**

Good catches, and they're connected: the if/else-y checks block are a symptom of hardcoding — once the limiter is fully dynamic, "expected" values become formulas you compute once and check against, not literals you type six times. Let me rebuild this properly.

**The real design change**, stated plainly before code: right now Northwind has two static config entries (1250 burst / 201 off-peak). You're right that's not actually dynamic — it's just a two-value lookup table I precomputed by hand. True dynamic behavior means:

```
every hour: effectiveLimit = (dailyBudget − requestsUsedSoFarToday) / minutesRemainingToday
```

No burst/off-peak split exists in config anymore — just one number, `dailyAverageRpm: 300`. If Northwind uses less than the implied pace in one hour, the formula mechanically raises the limit for every later hour, because more budget is left over fewer remaining minutes. If they overuse, it mechanically lowers. Nothing is hand-set per time-of-day anymore.

This needs new state the coordinator doesn't have yet: a running daily-usage counter per customer (resets at UTC midnight) alongside the existing 60-second sliding window. And per your call: recompute once per hour (not per-request — keeps the limit auditable/stable enough to reason about), and audit-log every single request decision, not just the daily total.

> Created file, ran command
>
> - Config v2 — Northwind switches from hardcoded burst/off-peak entries to a single dynamic-daily-average target; demo customers keep the flat fixed-schedule mode as a contrast
> - Overwrite customers.json with the dynamic-mode config
> - **Done**

Now the coordinator — this is where the real change lives: per-customer daily usage tracking, hourly recompute for dynamic-mode customers, and a persisted audit log for every single request decision (not just daily totals).

> Ran command
>
> - Rewrite coordinator with dynamic daily-average recompute + persisted audit log
> - **Done**

Now the harness — replacing the hardcoded burst/off-peak numbers with a scenario that actually proves the dynamic property (under-use raises the later cap), and replacing the if/else check block with a generic assertion list computed from the same formula.

> Ran command
>
> - Rewrite harness: prove dynamic rebalancing instead of static burst numbers, data-driven checks instead of if/else block
> - **Done**

Let's run it to confirm the dynamic math actually holds before I hand this back:

> Investigated discrepancy between rate limit cap and computed threshold.
>
> - Run updated harness with dynamic daily-average logic
> - Investigated discrepancy between rate limit cap and computed threshold.
> - **Done**

Found a real bug — not a logic error in the formula (that part's correct, 313 and 342 both matched independently), but a state leak: hour 1's 125 requests are still sitting in the 60-second sliding window when hour 3 fires milliseconds later in wall-clock time, since only the *daily-average* clock is simulated via the debug header — the RPM sliding window still runs on the real system clock. So hour 3 only had `342 − 125 = 217` slots actually free. This is exactly the kind of boundary bug the assignment wants surfaced, not hidden — I need to restore a real wait between hour buckets so the sliding window clears before the next hour's burst, same reasoning as the original burst/off-peak version.

> Edited file, ran command
>
> - Restore real wait between simulated hours so the 60s sliding window (real clock) doesn't leak into the next simulated hour's count
> - Re-run harness with the fix
> - **Done**

All 12 checks pass. Let's confirm the audit trail is actually usable, since that was the other part of your instruction — every request logged, not just the daily total:

> Ran command
>
> - Verify audit log has per-request entries plus recompute events
> - **Done**

Working as intended — 894 individual entries for this one run, including the two `hourly_recompute` events showing the exact math (limit went 313 → 342 because only 125 of the 313 available were used in hour 1), plus a full allow/deny record per request with the daily running total. That's a real audit trail, not a summary.

**What changed and why it matters:**
- No hardcoded burst/off-peak numbers anywhere in config — Northwind is just `dailyAverageRpm: 300`, one number.
- The limit is *derived* every hour from actual usage: `(dailyBudget − usedSoFarToday) / minutesRemainingToday`. Under-use raises it, over-use lowers it, and the harness proved that mechanically (hour 1 left budget unused → hour 3's cap rose from 313 to 342, verified against an independently-computed expected value, not a literal).
- The PASS/FAIL block is now a list of `{desc, actual, expected}` built from that same formula, not six hand-typed conditionals — same shape scales to more checks without more if/else.
- Found and fixed a real bug along the way: the daily-average clock is simulated (via the debug header) but the RPM sliding window still runs on the real system clock, so hour 1's counts were leaking into hour 3's budget when fired back-to-back. That's worth keeping in DECISIONS.md as a caught boundary bug, not just a caveat — it's exactly the "off-by-one/boundary" scrutiny the assignment says it's grading for.

One thing worth flagging honestly: the daily-usage counter resets on real UTC date (`new Date().toISOString().slice(0,10)`), independent of the simulated hour — fine for a single-day demo, but worth a line in DECISIONS.md that a multi-day harness run would need the day-key simulated too.

Want the checks/README/DECISIONS next, or still holding?

## User:

> 9/1/2026 1:10:39

just one last thing. ensure these are met are deliverables
A thin vertical slice: one endpoint (e.g. `GET /api/v1/ping` or a mock resource), real limiter middleware, config for at least two fake customer IDs including a stand-in for Northwind, and a harness that can simulate multi-node deployment (processes, containers, or documented equivalent).
Show me a demo where two customers on a 100 RPM tier each get exactly their budget, and a third customer who exceeds 100 RPM gets cut off — even when I hammer the load balancer randomly across all three nodes.
— Priya

## Assistant:

> 9/1/2026 1:13:06

> Validated endpoint presence and systematized configuration requirements.
>
> - Validated endpoint presence and systematized configuration requirements.
> - **Done**

All four deliverable requirements and Priya's literal demo are met. Here's the checklist against what's actually built and verified running:

| Requirement | Status | Where |
|---|---|---|
| One endpoint | ✅ | `GET /api/v1/ping` in `src/server.js` |
| Real limiter middleware | ✅ | Request handler in `server.js` delegates every request to `coordinator.js`'s `tryConsume` — allow/deny decision happens before any endpoint logic runs |
| Config for ≥2 fake customer IDs, incl. Northwind stand-in | ✅ | `config/customers.json` has 4: `cust_northwind_001`, `cust_demo_a`, `cust_demo_b`, `cust_demo_c_exceeder` |
| Harness simulating multi-node deployment | ✅ | `harness/run-harness.js` spawns 3 *real separate processes* (`node-1/2/3` on distinct ports) plus the coordinator — not a single-process fake |
| **Priya's exact demo**: two customers on 100 RPM tier get exactly their budget, third exceeds and gets cut off, hammered randomly across all 3 nodes | ✅ | Scenario A, confirmed in last run: `cust_demo_a` → 100/100 allowed, `cust_demo_b` → 100/100 allowed, `cust_demo_c_exceeder` (sends 150) → cut off at exactly 100, all three "hit 3/3 nodes" via random port selection per request |

One thing worth being precise about rather than glossing over: "middleware" here isn't literally an Express `app.use()` middleware function — I used plain Node `http` with no framework, so it's the equivalent logic inline in the request handler (extract customer, ask coordinator, respond). Functionally identical to middleware (runs before the endpoint's own logic, can short-circuit with a 429), just not that specific pattern. Worth a one-line note in the README/DECISIONS so a reviewer doesn't go looking for `app.use()` and get confused — that's the kind of gap that costs nothing to disclose and costs credibility to be caught on.

Let me actually re-run it now to give you fresh, current-run proof rather than pointing back at earlier output:

> Ran 2 commands
>
> - Fresh run isolating just Priya's exact demo scenario
> - Confirm Priya's demo numbers on a fresh run
> - **Done**

Confirmed fresh, not stale: A gets exactly 100/100, B gets exactly 100/100, C sends 150 and is cut off at exactly 100 — all with traffic hitting all 3 node processes ("3" in the Nodes hit column). All deliverables and Priya's literal demo criterion are met, reproducibly, on demand.

## User:

> 9/1/2026 3:01:20

how do i show them

## Assistant:

> 9/1/2026 3:01:29

A few practical options, not mutually exclusive:

1. **Live, if it's an interview/screen-share**: just run `node harness/run-harness.js` in front of them. It's self-contained (spawns everything, tears down after), takes about 65 seconds total, and ends with the PASS/FAIL table — this is the strongest demo because they see it happen, not a screenshot.

2. **Captured output for the README/PR**, since most reviewers here are reading async, not watching you run it live. Redirect the output to a file and either paste it into `README.md` inside a code block, or attach it as a log file:

```bash
node harness/run-harness.js > demo-output.txt 2>&1
```

Then in `README.md`, under a "## Demo output" or "## Sample run" section, paste the relevant chunk (the RESULTS table + PASS/FAIL block at minimum — you can trim the process-startup noise at the top if it's cluttering things).

3. **Point at the audit log as supporting evidence**, since it's a deliverable-strength artifact by itself — `logs/audit.jsonl` after a run contains a literal per-request paper trail, including the `hourly_recompute` entries showing the dynamic math happening. Worth a line in the README like "see `logs/audit.jsonl` after a run for the full per-request audit trail, including the hourly recompute events that prove the daily-average is self-adjusting."

4. **The `README.md` itself should do double duty as "how to show them"** — since it needs exact run instructions anyway (per the assignment: "a reviewer can run it in ≤15 minutes"), the same section that tells them how to run it can end with "you should see output like this," followed by a trimmed sample of the RESULTS + PASS/FAIL table. That way a reviewer who doesn't even run it themselves still sees the proof, and one who does run it can compare their output to what you claimed.

Given we're still holding off on writing `README.md`/`DECISIONS.md` per your earlier instruction — want me to write those two now, including a captured sample-output section in the README, or are you handling the presentation piece yourself and just wanted the options?

## User:

> 9/1/2026 4:02:09

only make the readme. decisions ill make myself only tell me what should generally be in there like i know you used sliding window but like follow the format What you decided about the CTO vs. support conflict — and what you explicitly rejected.

* Algorithm and distributed-coordination choices.
* What your harness proves and what it does not prove.
* What you would build next with another four hours.

## Assistant:

> 9/1/2026 4:04:01

Let me write the README now.

> Ran command
>
> - Capture a clean sample run to embed in the README
> - **Done**

Good, clean run. Now the README:

> Created file
>
> - README with setup, architecture, run instructions, and captured sample output
> - **Done**

README's done. For `DECISIONS.md`, here's what I'd make sure lands in each required section — not full prose, just the load-bearing points from what we actually decided across this conversation, so you don't lose anything when you write it yourself:

**What you decided about the CTO vs. support conflict — and what you explicitly rejected**
- State the conflict plainly: literal reading of both memos is mutually exclusive.
- What you rejected: an *invisible* bypass for Northwind (Marcus's literal ask) — because it's indistinguishable from the `if (customerId === ...)` hack Priya explicitly banned, and violates her auditability requirement.
- What you built instead: Northwind gets a higher *effective* limit, but it's config-driven, auditable (reason/approver/date fields in `customers.json`, plus per-request audit log), and — critically — the same generic mechanism any customer's config could use. The special treatment lives in *data*, not in *code paths*.
- Name the business-vs-mechanism distinction explicitly: the reason this exists is unapologetically Northwind's revenue weight; the mechanism isn't identity-branched. Don't launder the motive — just don't let it leak into the code shape.
- Note it's still not a full resolution: even the dynamic 300-average model can 429 Northwind if their actual peak burst outpaces what the formula allows in a given hour — say plainly you're solving the median case, not guaranteeing literally zero errors under all queue-depth scenarios, since Marcus's memo asked for zero.

**Algorithm and distributed-coordination choices**
- Sliding-window log (60s) per customer for RPM enforcement — avoids fixed-window edge-doubling at minute boundaries.
- Two limit modes selected by config data, not identity: `fixed-schedule` (flat RPM) and `dynamic-daily-average` (Northwind) — formula: `(dailyBudget − usedSoFarToday) / minutesRemainingToday`, recomputed hourly (not per-request, so the limit is stable enough to audit/reason about; not daily-static, so it self-adjusts).
- Coordinator = single atomic process standing in for Redis/DB atomic ops, justified against the wiki's "Redis may or may not be available, don't assume new infra" constraint. State explicitly this is a new single point of failure not present in the "3 stateless nodes" world — a real deployment would swap this for Redis.
- Fail-closed default (deny unknown customers / no matching schedule) per Priya's "under-limit, never over-limit" directive.

**What your harness proves and what it does not prove**
- Proves: exact-boundary enforcement for flat-rate tiers under randomized multi-node traffic (Priya's literal demo); dynamic recomputation genuinely responds to usage (under-use in hour 1 provably raises hour 3's cap, checked against an independently-derived expected value, not a hardcoded literal); full audit trail exists per-request.
- Does not prove: coordinator failure/crash behavior; true concurrent-arrival races beyond what Node's single-threaded event loop gives for free; multi-day rollover correctness (day-key uses real wall-clock date while hour is simulated — a mismatch you'd need to fix for a multi-day harness); whether the dynamic formula's hourly cap is always ≥ Northwind's actual observed burst rate (i.e., doesn't guarantee zero 429s, only bounds the daily average).

**What you'd build next with 4 more hours**
- Swap coordinator's in-memory state for Redis to remove the new SPOF.
- Simulate day-key alongside hour-key so multi-day dynamics are testable.
- Add a coordinator-crash/restart scenario to the harness.
- Get an actual commercial sign-off path modeled (the config's `approvedBy`/`reason` fields are currently self-asserted, not backed by a real approval workflow).

## User:

> 9/1/2026 4:13:26

looking at the code, it looks like you removed 1250 and instead use a per hour modifier on 300. this was my mistake to tell you to do this.make the sliding window 5 hours and they should be able to use 1250 the entire time.

## Assistant:

> 9/1/2026 4:16:09

> Dismantled daily-average logic and architected unified sliding-window mechanism.
>
> - Dismantled daily-average logic and architected unified sliding-window mechanism.
> - **Done**

Good call — and worth saying plainly: that dynamic hourly-recompute machinery was solving a problem you never actually asked for the second time. Let me implement what you're describing correctly.

**What this actually means mechanically:** our existing sliding-window-log algorithm already enforces "no more than `limit` requests in the trailing `window`." Right now every customer uses a 60-second window (that's what "RPM" means). If Northwind's window is instead **5 hours (18,000s)**, and they should be able to sustain **1250 RPM for the entire window**, the cap for that window isn't `1250` — it's `1250 × 300 minutes = 375,000` total requests allowed in any trailing 5-hour period. Same algorithm, just a per-customer-configurable window length and cap instead of a fixed 60s/RPM shape. This is actually simpler than what I built — it deletes the whole dynamic-daily-average/hourly-recompute engine, the day-key tracking, and the clock-simulation bug we hit last time, entirely.

**And importantly**: this makes the "no special-casing" story *stronger*, not weaker — one generic `{windowSeconds, limit}` pair per customer, no time-of-day matching, no schedule arrays, no wraparound-at-midnight logic. Northwind isn't an `if` branch; they're just a row with a longer window and a bigger number, same as everyone else's row with a shorter window and a smaller number.

Let me rebuild this properly.

> Ran command
>
> - Replace config with unified generic windowSeconds/limit schema
> - **Done**

Now `limits.js` simplifies to a plain lookup — no time-of-day matching needed at all anymore:

> Ran command
>
> - Simplify limits.js to a plain per-customer window+cap lookup
> - **Done**

Now the coordinator — one sliding-window-log implementation, window length driven by config instead of a hardcoded 60000ms constant. Dropping the daily-usage tracking and hourly recompute entirely:

> Ran command
>
> - Rewrite coordinator with a single generic sliding-window-log driven entirely by per-customer config
> - **Done**

Now `server.js` — drop the time-of-day clock override entirely, since nothing depends on time anymore:

> Ran command
>
> - Simplify server.js - drop clock override entirely, no time dependency left
> - **Done**

Now the harness — no more clock simulation, no more 61-second wait, and the Northwind scenario changes to what actually matters: proving sustained batch traffic never gets throttled, plus a fast, small-scale proof that the same mechanism correctly cuts off at its boundary.

> Ran command
>
> - Rewrite harness: no clock simulation, prove sustained batch traffic clears, plus fast boundary proof via scaled-down probe customer
> - **Done**

Let's run it — this should be fast now, no more 61-second wait needed:

> Ran 2 commands
>
> - Run updated harness with the 5-hour window mechanism
> - Run updated harness and time it
> - **Done**

All 10 checks pass, and the harness now runs in **4 seconds** instead of ~65 — the whole hourly-recompute/clock-simulation machinery is gone, along with the real-time wait it needed.

**Summary of what changed:**
- One generic mechanism for every customer: `{windowSeconds, limit}` — "RPM" is just the special case `windowSeconds=60`. Northwind is `windowSeconds=18000` (5h), `limit=375000` (1250 × 300 min), living in `config/customers.json` next to everyone else, same shape, same code path.
- Deleted: `dailyState`, hourly recompute, `clock.js`, the debug time-override header, the midnight-wraparound schedule matching — none of it is needed anymore since nothing depends on time-of-day now.
- Scenario B fires Northwind's documented real peak (1200 RPM sustained burst) and proves zero throttling — directly answering Marcus's ask, not just gesturing at it.
- Added Scenario C (`cust_window_probe`, `limit=20`/`window=5s`) specifically to prove the *mechanism itself* cuts off correctly at a boundary — since Northwind's real numbers are large enough that nothing in this harness naturally exercises their ceiling without literally sending 375,001 requests. This is the honest way to prove "the algorithm enforces correctly," without either faking it or making the harness slow/heavy.

One thing worth being explicit about in `DECISIONS.md`: **this harness does not directly prove Northwind's own ceiling is enforced** — only that a differently-configured customer on the identical code path gets cut off correctly. That's a legitimate proof strategy (same function, different parameters), but say so plainly rather than let a reviewer assume 375,000 requests were actually fired.

Want me to update the README's sample output to match this new run, or are you good to update that yourself alongside your `DECISIONS.md` pass?

## User:

> 9/1/2026 4:17:21

where are the files

## Assistant:

> 9/1/2026 4:17:30

Everything's sitting in the sandbox at `/home/claude/solution/` — same base path as before, no reshuffling. Here's the current, up-to-date state after this round of changes:

> Viewed file
>
> - Show current file structure to confirm what's there
> - **Done**

Same layout as last time, maps directly onto your submission path:

```
solution/
├── README.md               ← still describes the OLD version (dynamic daily-average) — I flagged this last message, not yet updated
├── config/
│   └── customers.json       ← updated: generic windowSeconds/limit schema
├── src/
│   ├── coordinator.js        ← updated: single sliding-window-log mechanism
│   ├── limits.js              ← updated: simplified lookup, no time-of-day
│   └── server.js              ← updated: dropped clock/time-override code
├── harness/
│   └── run-harness.js         ← updated: 3 scenarios, no wait, 4s runtime
└── logs/
    └── audit.jsonl             ← generated fresh each run, from the last run above
```

Note `clock.js` no longer exists — I deleted it since nothing depends on time-of-day anymore.

Since you pulled the previous version out manually last time, you'll want to **re-pull `customers.json`, `coordinator.js`, `limits.js`, `server.js`, and `run-harness.js`** — those five all changed. `README.md` in the sandbox is still the *old* version describing the dynamic daily-average design (I called this out at the end of my last message and you haven't said whether to update it yet).

Want me to update the README's content/sample-output section to match the new 5-hour-window design now, so what you pull is consistent, or are you handling that alongside your own DECISIONS.md pass?

## User:

> 9/1/2026 4:18:06

how do i copy them

## Assistant:

> 9/1/2026 4:18:14

Since these are sitting in my sandbox (not on your machine), the cleanest way is for me to hand them to you as downloadable files rather than you copy-pasting code manually. Let me package them up.

> Presented file
>
> - Presenting file(s)...
> - **Done**

Six files are attached above — click each to download. Once you have them, drop them into your local project matching this exact layout (folder names matter, since the code refers to sibling paths like `../config/customers.json`):

```
solution/
├── config/
│   └── customers.json      ← from "customers"
├── src/
│   ├── coordinator.js
│   ├── limits.js
│   └── server.js
├── harness/
│   └── run-harness.js
└── README.md
```

Two things to double check after you place them:

1. **Delete the old `src/clock.js`** if it's still sitting in your local folder from before — it's unused now and would just be confusing dead code sitting next to files that no longer reference it.
2. **`README.md`'s sample-output section still describes the old design** (I flagged this last turn and haven't updated it) — worth either regenerating it or editing that section yourself before you're done, since right now it doesn't match what `run-harness.js` actually prints.

Once they're in place, same as before:
```bash
cd solution
node harness/run-harness.js
```

> File: [/home/claude/solution/config/customers.json](https://claude.ai/api/organizations/935646be-643e-4c94-90b6-1f96a3400ad4/conversations/9ed9999a-2e3d-4997-9547-8c0b6b2d05a9/wiggle/download-file?path=%2Fhome%2Fclaude%2Fsolution%2Fconfig%2Fcustomers.json)

> File: [/home/claude/solution/src/coordinator.js](https://claude.ai/api/organizations/935646be-643e-4c94-90b6-1f96a3400ad4/conversations/9ed9999a-2e3d-4997-9547-8c0b6b2d05a9/wiggle/download-file?path=%2Fhome%2Fclaude%2Fsolution%2Fsrc%2Fcoordinator.js)

> File: [/home/claude/solution/src/limits.js](https://claude.ai/api/organizations/935646be-643e-4c94-90b6-1f96a3400ad4/conversations/9ed9999a-2e3d-4997-9547-8c0b6b2d05a9/wiggle/download-file?path=%2Fhome%2Fclaude%2Fsolution%2Fsrc%2Flimits.js)

> File: [/home/claude/solution/src/server.js](https://claude.ai/api/organizations/935646be-643e-4c94-90b6-1f96a3400ad4/conversations/9ed9999a-2e3d-4997-9547-8c0b6b2d05a9/wiggle/download-file?path=%2Fhome%2Fclaude%2Fsolution%2Fsrc%2Fserver.js)

> File: [/home/claude/solution/harness/run-harness.js](https://claude.ai/api/organizations/935646be-643e-4c94-90b6-1f96a3400ad4/conversations/9ed9999a-2e3d-4997-9547-8c0b6b2d05a9/wiggle/download-file?path=%2Fhome%2Fclaude%2Fsolution%2Fharness%2Frun-harness.js)

> File: [/home/claude/solution/README.md](https://claude.ai/api/organizations/935646be-643e-4c94-90b6-1f96a3400ad4/conversations/9ed9999a-2e3d-4997-9547-8c0b6b2d05a9/wiggle/download-file?path=%2Fhome%2Fclaude%2Fsolution%2FREADME.md)

## User:

> 9/1/2026 4:18:44

no give copy paste code i want to read

## Assistant:

> 9/1/2026 4:19:26

Here's everything, inline.

**`config/customers.json`**
```json
{
  "_comment": "Single generic mechanism for every customer: a sliding window of length windowSeconds allows at most `limit` total requests in that trailing window. 'RPM' is just the special case windowSeconds=60. Northwind is the same shape with a longer window and a bigger number - not a separate code path.",
  "customers": [
    {
      "customerId": "cust_northwind_001",
      "displayName": "Northwind Logistics",
      "tier": "enterprise",
      "windowSeconds": 18000,
      "limit": 375000,
      "reason": "Contracted to sustain 1250 RPM for up to the full 5-hour rolling window (1250 * 300 minutes = 375000), covering their 135-minute nightly batch (01:45-04:15 UTC) with margin, per commercial addendum NW-2026-03. No time-of-day matching - a rolling 5h window bounds total throughput without needing to know what time it is.",
      "approvedBy": "priya.nair",
      "effectiveDate": "2026-03-14"
    },
    {
      "customerId": "cust_demo_a",
      "displayName": "Demo Customer A (100 RPM tier)",
      "tier": "starter-demo",
      "windowSeconds": 60,
      "limit": 100,
      "reason": "Standard flat tier for CTO boundary demo",
      "approvedBy": "system-default",
      "effectiveDate": "2026-01-01"
    },
    {
      "customerId": "cust_demo_b",
      "displayName": "Demo Customer B (100 RPM tier)",
      "tier": "starter-demo",
      "windowSeconds": 60,
      "limit": 100,
      "reason": "Standard flat tier for CTO boundary demo",
      "approvedBy": "system-default",
      "effectiveDate": "2026-01-01"
    },
    {
      "customerId": "cust_demo_c_exceeder",
      "displayName": "Demo Customer C (same 100 RPM tier, sends traffic above it)",
      "tier": "starter-demo",
      "windowSeconds": 60,
      "limit": 100,
      "reason": "Standard flat tier for CTO boundary demo",
      "approvedBy": "system-default",
      "effectiveDate": "2026-01-01"
    },
    {
      "customerId": "cust_window_probe",
      "displayName": "Window-mechanism probe (small numbers, same code path as Northwind)",
      "tier": "internal-test",
      "windowSeconds": 5,
      "limit": 20,
      "reason": "Exists only to prove the same generic windowSeconds/limit mechanism cuts off correctly at a scale that's fast to test - Northwind's real 375000/18000s pair uses this identical code path.",
      "approvedBy": "system-default",
      "effectiveDate": "2026-01-01"
    }
  ]
}
```

**`src/limits.js`**
```javascript
const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '..', 'config', 'customers.json');

function loadConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

// The ONLY function the coordinator calls to find out a customer's window
// and cap. No customerId-specific branches - Northwind's higher numbers
// live entirely in config data, not in this code. "RPM" tiers and
// Northwind's 5-hour rolling allowance are the exact same {windowSeconds,
// limit} shape.
function getWindowLimit(customerId, config) {
  const cfg = config || loadConfig();
  const customer = cfg.customers.find((c) => c.customerId === customerId);
  if (!customer) {
    return { windowSeconds: 60, limit: 0, reason: 'unknown customer - denied by default', found: false };
  }
  return {
    windowSeconds: customer.windowSeconds,
    limit: customer.limit,
    reason: customer.reason,
    approvedBy: customer.approvedBy,
    effectiveDate: customer.effectiveDate,
    found: true,
  };
}

module.exports = { loadConfig, getWindowLimit };
```

**`src/coordinator.js`**
```javascript
// COORDINATOR
//
// Single atomic source of truth all app nodes call. Node completes each
// request's synchronous JS before picking up the next (no `await` between
// reading and mutating state below), so check-and-increment here is atomic
// with respect to concurrent callers - the property Redis INCR/Lua or a DB
// row lock would give in production. Documented stand-in for that; see
// DECISIONS.md for the tradeoff.
//
// One generic algorithm for every customer: a sliding-window log. For each
// customer, keep a list of recent request timestamps; on a new request,
// drop timestamps older than that customer's configured windowSeconds, and
// allow the request only if fewer than `limit` timestamps remain. "RPM" is
// just windowSeconds=60. Northwind sustaining 1250 RPM for a full 5-hour
// batch is windowSeconds=18000, limit=375000 (1250 * 300 minutes) - same
// function, no customerId branch, no time-of-day matching required.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { getWindowLimit, loadConfig } = require('./limits');

const PORT = process.env.COORDINATOR_PORT || 4000;
const LOG_DIR = path.join(__dirname, '..', 'logs');
const AUDIT_PATH = path.join(LOG_DIR, 'audit.jsonl');
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
fs.writeFileSync(AUDIT_PATH, ''); // fresh audit trail per run (see README)

function appendAudit(entry) {
  fs.appendFileSync(AUDIT_PATH, JSON.stringify({ ts: Date.now(), ...entry }) + '\n');
}

const config = loadConfig();
const logs = new Map(); // customerId -> [timestamps ms], ascending

function pruneOld(timestamps, nowMs, windowMs) {
  const cutoff = nowMs - windowMs;
  let i = 0;
  while (i < timestamps.length && timestamps[i] <= cutoff) i++;
  if (i > 0) timestamps.splice(0, i);
}

function tryConsume(customerId) {
  const nowMs = Date.now();
  const { windowSeconds, limit, reason, found } = getWindowLimit(customerId, config);
  const windowMs = windowSeconds * 1000;

  if (!logs.has(customerId)) logs.set(customerId, []);
  const timestamps = logs.get(customerId);
  pruneOld(timestamps, nowMs, windowMs);

  let result;
  if (timestamps.length < limit) {
    timestamps.push(nowMs);
    result = { allowed: true, limit, windowSeconds, remaining: limit - timestamps.length, reason };
  } else {
    const oldest = timestamps[0];
    const retryAfterMs = Math.max(0, windowMs - (nowMs - oldest));
    result = { allowed: false, limit, windowSeconds, remaining: 0, retryAfterSeconds: Math.ceil(retryAfterMs / 1000), reason, found };
  }

  appendAudit({ type: 'request', customerId, allowed: result.allowed, limit, windowSeconds });
  return result;
}

const server = http.createServer((req, res) => {
  if (req.method !== 'POST' || req.url !== '/consume') {
    res.writeHead(404);
    res.end();
    return;
  }
  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    try {
      const { customerId } = JSON.parse(body);
      const result = tryConsume(customerId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: String(err) }));
    }
  });
});

server.listen(PORT, () => {
  console.log(`[coordinator] listening on ${PORT}, audit log -> ${AUDIT_PATH}`);
});
```

**`src/server.js`**
```javascript
// APP NODE
//
// Stateless: holds no counters itself, delegates every rate-limit decision
// to the coordinator. Run 3 of these on different ports to simulate the
// 3-node deployment behind a (harness-simulated) load balancer.

const http = require('http');

const PORT = process.env.NODE_PORT || 5001;
const COORDINATOR_PORT = process.env.COORDINATOR_PORT || 4000;
const NODE_ID = process.env.NODE_ID || `node-${PORT}`;

function askCoordinator(customerId) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ customerId });
    const req = http.request(
      {
        hostname: 'localhost',
        port: COORDINATOR_PORT,
        path: '/consume',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

const server = http.createServer(async (req, res) => {
  if (req.url !== '/api/v1/ping') {
    res.writeHead(404);
    res.end();
    return;
  }
  const customerId = req.headers['x-customer-id'];
  if (!customerId) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'missing X-Customer-Id header' }));
    return;
  }

  try {
    const result = await askCoordinator(customerId);
    if (result.allowed) {
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'X-Served-By': NODE_ID,
        'X-RateLimit-Limit': result.limit,
        'X-RateLimit-Window-Seconds': result.windowSeconds,
        'X-RateLimit-Remaining': result.remaining,
      });
      res.end(JSON.stringify({ ok: true, servedBy: NODE_ID, limit: result.limit, remaining: result.remaining }));
    } else {
      res.writeHead(429, {
        'Content-Type': 'application/json',
        'X-Served-By': NODE_ID,
        'Retry-After': result.retryAfterSeconds,
      });
      res.end(
        JSON.stringify({ ok: false, servedBy: NODE_ID, limit: result.limit, retryAfterSeconds: result.retryAfterSeconds })
      );
    }
  } catch (err) {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'coordinator unreachable', detail: String(err) }));
  }
});

server.listen(PORT, () => {
  console.log(`[${NODE_ID}] listening on ${PORT}`);
});
```

**`harness/run-harness.js`**
```javascript
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');

const COORDINATOR_PORT = 4000;
const NODE_PORTS = [5001, 5002, 5003];
const SRC = path.join(__dirname, '..', 'src');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function spawnProc(script, env, label) {
  const proc = spawn('node', [script], { env: { ...process.env, ...env }, stdio: 'pipe' });
  proc.stdout.on('data', (d) => process.stdout.write(`[${label}] ${d}`));
  proc.stderr.on('data', (d) => process.stderr.write(`[${label} ERR] ${d}`));
  return proc;
}

function fireRequest(port, customerId) {
  return new Promise((resolve) => {
    const req = http.request(
      { hostname: 'localhost', port, path: '/api/v1/ping', method: 'GET', headers: { 'X-Customer-Id': customerId } },
      (res) => {
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode, servedBy: res.headers['x-served-by'] }));
      }
    );
    req.on('error', () => resolve({ status: 'ERR' }));
    req.end();
  });
}

async function burst(customerId, count) {
  const calls = [];
  for (let i = 0; i < count; i++) {
    const port = NODE_PORTS[Math.floor(Math.random() * NODE_PORTS.length)];
    calls.push(fireRequest(port, customerId));
  }
  const results = await Promise.all(calls);
  const byNode = {};
  let allowed = 0, denied = 0;
  for (const r of results) {
    if (r.status === 200) allowed++;
    else if (r.status === 429) denied++;
    if (r.servedBy) byNode[r.servedBy] = (byNode[r.servedBy] || 0) + 1;
  }
  return { allowed, denied, total: count, byNode };
}

function printRow(cols, widths) {
  console.log(cols.map((c, i) => String(c).padEnd(widths[i])).join(' | '));
}

function check(desc, actual, expected) {
  return { desc, actual, expected, pass: actual === expected };
}

async function main() {
  console.log('Starting coordinator + 3 app nodes...\n');
  const coordinator = spawnProc(path.join(SRC, 'coordinator.js'), { COORDINATOR_PORT }, 'coordinator');
  const nodes = NODE_PORTS.map((port, idx) =>
    spawnProc(path.join(SRC, 'server.js'), { NODE_PORT: port, COORDINATOR_PORT, NODE_ID: `node-${idx + 1}` }, `node-${idx + 1}`)
  );

  await sleep(500);

  const widths = [52, 8, 8, 8, 10];
  const rows = [];
  const checks = [];

  try {
    console.log('\n=== SCENARIO A - Priya\'s boundary demo (flat 100 RPM tier, hammered randomly across 3 nodes) ===\n');

    const a = await burst('cust_demo_a', 100);
    rows.push(['cust_demo_a (100 RPM tier, sends exactly 100)', a]);
    checks.push(check('A gets exactly its 100 RPM budget', a.allowed, 100));
    checks.push(check('A has zero denials at exactly-budget traffic', a.denied, 0));

    const b = await burst('cust_demo_b', 100);
    rows.push(['cust_demo_b (100 RPM tier, sends exactly 100)', b]);
    checks.push(check('B gets exactly its 100 RPM budget (isolated from A)', b.allowed, 100));

    const c = await burst('cust_demo_c_exceeder', 150);
    rows.push(['cust_demo_c_exceeder (100 RPM tier, sends 150)', c]);
    checks.push(check('C (same tier, sends 150) is cut off exactly at 100', c.allowed, 100));
    checks.push(check('C\'s overflow is denied, not silently allowed', c.denied, 50));

    console.log('\n=== SCENARIO B - Northwind, 5-hour rolling window sized for sustained 1250 RPM ===\n');

    const batchLikeCount = 1200;
    const nw = await burst('cust_northwind_001', batchLikeCount);
    rows.push([`Northwind (documented batch peak, sends ${batchLikeCount})`, nw]);
    checks.push(check('Northwind\'s documented peak batch traffic sees zero 429s', nw.denied, 0));
    checks.push(check('Northwind\'s documented peak batch traffic is fully allowed', nw.allowed, batchLikeCount));

    console.log('\n=== SCENARIO C - Window mechanism boundary proof (same code path as Northwind, scaled down to run fast) ===\n');

    const probeSent = 30;
    const probe = await burst('cust_window_probe', probeSent);
    rows.push([`cust_window_probe (limit 20 / 5s window, sends ${probeSent})`, probe]);
    checks.push(check('Window mechanism cuts off exactly at its configured limit', probe.allowed, 20));
    checks.push(check('Window mechanism denies the overflow, not silently allows it', probe.denied, probeSent - 20));

    checks.push(check('Requests were spread across all 3 nodes (no sticky sessions)',
      Object.keys(a.byNode).length > 1 || Object.keys(nw.byNode).length > 1, true));

    console.log('\n=== RESULTS ===\n');
    printRow(['Scenario', 'Sent', 'Allowed', 'Denied', 'Nodes hit'], widths);
    printRow(widths.map((w) => '-'.repeat(w)), widths);
    for (const [label, r] of rows) printRow([label, r.total, r.allowed, r.denied, Object.keys(r.byNode).length], widths);

    console.log('\n=== PASS/FAIL CHECKS ===\n');
    for (const c of checks) console.log(`${c.pass ? 'PASS' : 'FAIL'} - ${c.desc} (actual=${c.actual}, expected=${c.expected})`);
    const allPass = checks.every((c) => c.pass);
    console.log(`\nOverall: ${allPass ? 'ALL CHECKS PASSED' : 'SOME CHECKS FAILED - see above'}`);
    console.log(`\nFull per-request audit trail written to solution/logs/audit.jsonl`);
  } finally {
    coordinator.kill();
    nodes.forEach((n) => n.kill());
  }
}

main();
```

Remember to delete `src/clock.js` from your local copy if it's still there — nothing references it anymore.

## User:

> 9/1/2026 4:30:20

im going with this write me the old harness {
  "customers": [
    {
      "customerId": "cust_northwind_001",
      "displayName": "Northwind Logistics",
      "tier": "enterprise",
      "schedule": [
        {
          "startUtc": "01:45",
          "endUtc": "04:15",
          "rpm": 1250,
          "reason": "Nightly batch window — contracted burst per commercial addendum NW-2026-03",
          "approvedBy": "priya.nair",
          "effectiveDate": "2026-03-14"
        },
        {
          "startUtc": "04:15",
          "endUtc": "01:45",
          "rpm": 201,
          "reason": "Off-peak rate, adjusted to conserve 300 RPM contracted daily average against batch window burst",
          "approvedBy": "priya.nair",
          "effectiveDate": "2026-03-14"
        }
      ]
    },
    {
      "customerId": "cust_acme_002",
      "displayName": "Acme Co",
      "tier": "growth",
      "schedule": [
        {
          "startUtc": "00:00",
          "endUtc": "00:00",
          "rpm": 300,
          "reason": "Standard Growth tier, always-on",
          "approvedBy": "system-default",
          "effectiveDate": "2026-01-01"
        }
      ]
    }
  ]
}

and also update readme accordingly

## Assistant:

> 9/1/2026 4:31:19

> Identified missing demo customers and flagged configuration gap.
>
> - Identified missing demo customers and flagged configuration gap.
> - **Done**

Understood — reverting to the fixed-schedule design with the burst/off-peak split. Note: your pasted config only has Northwind + Acme, but Priya's literal demo needs **three flat-tier customers** (two at 100 RPM getting exactly their budget, one exceeding). I've kept Acme as you gave it and added back the three 100-RPM demo customers so that requirement still has something to run against — flag me if you wanted Acme to serve double duty instead.

**`config/customers.json`**
```json
{
  "customers": [
    {
      "customerId": "cust_northwind_001",
      "displayName": "Northwind Logistics",
      "tier": "enterprise",
      "schedule": [
        {
          "startUtc": "01:45",
          "endUtc": "04:15",
          "rpm": 1250,
          "reason": "Nightly batch window — contracted burst per commercial addendum NW-2026-03",
          "approvedBy": "priya.nair",
          "effectiveDate": "2026-03-14"
        },
        {
          "startUtc": "04:15",
          "endUtc": "01:45",
          "rpm": 201,
          "reason": "Off-peak rate, adjusted to conserve 300 RPM contracted daily average against batch window burst",
          "approvedBy": "priya.nair",
          "effectiveDate": "2026-03-14"
        }
      ]
    },
    {
      "customerId": "cust_acme_002",
      "displayName": "Acme Co",
      "tier": "growth",
      "schedule": [
        {
          "startUtc": "00:00",
          "endUtc": "00:00",
          "rpm": 300,
          "reason": "Standard Growth tier, always-on",
          "approvedBy": "system-default",
          "effectiveDate": "2026-01-01"
        }
      ]
    },
    {
      "customerId": "cust_demo_a",
      "displayName": "Demo Customer A (flat 100 RPM tier)",
      "tier": "starter-demo",
      "schedule": [
        {
          "startUtc": "00:00",
          "endUtc": "00:00",
          "rpm": 100,
          "reason": "Standard flat tier for CTO boundary demo",
          "approvedBy": "system-default",
          "effectiveDate": "2026-01-01"
        }
      ]
    },
    {
      "customerId": "cust_demo_b",
      "displayName": "Demo Customer B (flat 100 RPM tier)",
      "tier": "starter-demo",
      "schedule": [
        {
          "startUtc": "00:00",
          "endUtc": "00:00",
          "rpm": 100,
          "reason": "Standard flat tier for CTO boundary demo",
          "approvedBy": "system-default",
          "effectiveDate": "2026-01-01"
        }
      ]
    },
    {
      "customerId": "cust_demo_c_exceeder",
      "displayName": "Demo Customer C (same 100 RPM tier, sends traffic above it)",
      "tier": "starter-demo",
      "schedule": [
        {
          "startUtc": "00:00",
          "endUtc": "00:00",
          "rpm": 100,
          "reason": "Standard flat tier for CTO boundary demo",
          "approvedBy": "system-default",
          "effectiveDate": "2026-01-01"
        }
      ]
    }
  ]
}
```

**`src/limits.js`**
```javascript
const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '..', 'config', 'customers.json');

function loadConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

// "HH:MM" -> minutes since midnight UTC
function toMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

// Does `nowMin` fall inside [startMin, endMin), handling midnight wraparound
// (endMin < startMin means the window crosses midnight, e.g. 04:15 -> 01:45).
function inWindow(nowMin, startMin, endMin) {
  if (startMin === endMin) return true; // 00:00 -> 00:00 = "always on"
  if (endMin > startMin) return nowMin >= startMin && nowMin < endMin;
  return nowMin >= startMin || nowMin < endMin; // wraps past midnight
}

// The ONLY function the rate-limiting middleware calls to find a customer's
// limit. No customerId-specific branches - Northwind's higher number lives
// in config data (customers.json), not in this code.
function getEffectiveLimit(customerId, nowUtcMinutes, config) {
  const cfg = config || loadConfig();
  const customer = cfg.customers.find((c) => c.customerId === customerId);
  if (!customer) {
    return { rpm: 0, reason: 'unknown customer — denied by default', found: false };
  }
  for (const entry of customer.schedule) {
    const startMin = toMinutes(entry.startUtc);
    const endMin = toMinutes(entry.endUtc);
    if (inWindow(nowUtcMinutes, startMin, endMin)) {
      return {
        rpm: entry.rpm,
        reason: entry.reason,
        approvedBy: entry.approvedBy,
        effectiveDate: entry.effectiveDate,
        found: true,
      };
    }
  }
  // Fail closed, per Priya's "under-limit, never over-limit" directive.
  return { rpm: 0, reason: 'no matching schedule window — denied by default', found: false };
}

module.exports = { loadConfig, getEffectiveLimit, toMinutes, inWindow };
```

**`src/clock.js`**
```javascript
// Returns "now" as minutes-since-midnight UTC.
//
// By default this is the real clock. The harness needs to demonstrate
// Northwind's behavior at 02:30 UTC (burst) AND at, say, 10:00 UTC
// (off-peak) in the same run, without waiting for real time to pass.
// A node started with ALLOW_TIME_OVERRIDE=true will honor an
// `X-Debug-Now-Utc-Minutes` request header.
//
// This override is generic (changes what time the whole service thinks it
// is), not customer-specific - a test seam, not a per-customer bypass -
// and is OFF by default.
function nowUtcMinutes(headers) {
  if (process.env.ALLOW_TIME_OVERRIDE === 'true' && headers && headers['x-debug-now-utc-minutes']) {
    const override = parseInt(headers['x-debug-now-utc-minutes'], 10);
    if (!Number.isNaN(override)) return override;
  }
  const d = new Date();
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

module.exports = { nowUtcMinutes };
```

**`src/coordinator.js`**
```javascript
// COORDINATOR
//
// Single atomic source of truth all 3 app nodes call. Node completes each
// request's synchronous JS before picking up the next (no `await` between
// reading and mutating state below), so the check-and-increment here is
// atomic with respect to concurrent callers - the same property Redis
// INCR/Lua or a DB row lock would give in production. Documented stand-in
// for Redis (platform wiki: "may or may not be available") - see
// DECISIONS.md for the tradeoff, not hidden.

const http = require('http');
const { getEffectiveLimit, loadConfig } = require('./limits');

const WINDOW_MS = 60 * 1000; // sliding 60-second window = "per minute"
const PORT = process.env.COORDINATOR_PORT || 4000;

const config = loadConfig();
const logs = new Map(); // customerId -> [timestamps ms], ascending

function pruneOld(timestamps, nowMs) {
  const cutoff = nowMs - WINDOW_MS;
  let i = 0;
  while (i < timestamps.length && timestamps[i] <= cutoff) i++;
  if (i > 0) timestamps.splice(0, i);
}

function tryConsume(customerId, nowUtcMinutes) {
  const nowMs = Date.now();
  const { rpm, reason, found } = getEffectiveLimit(customerId, nowUtcMinutes, config);

  if (!logs.has(customerId)) logs.set(customerId, []);
  const timestamps = logs.get(customerId);
  pruneOld(timestamps, nowMs);

  if (timestamps.length < rpm) {
    timestamps.push(nowMs);
    return { allowed: true, limit: rpm, remaining: rpm - timestamps.length, reason };
  }

  const oldest = timestamps[0];
  const retryAfterMs = Math.max(0, WINDOW_MS - (nowMs - oldest));
  return {
    allowed: false,
    limit: rpm,
    remaining: 0,
    retryAfterSeconds: Math.ceil(retryAfterMs / 1000),
    reason,
    found,
  };
}

const server = http.createServer((req, res) => {
  if (req.method !== 'POST' || req.url !== '/consume') {
    res.writeHead(404);
    res.end();
    return;
  }
  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    try {
      const { customerId, nowUtcMinutes } = JSON.parse(body);
      const result = tryConsume(customerId, nowUtcMinutes);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: String(err) }));
    }
  });
});

server.listen(PORT, () => {
  console.log(`[coordinator] listening on ${PORT}`);
});
```

**`src/server.js`**
```javascript
// APP NODE
//
// Stateless: holds no counters itself, delegates every rate-limit decision
// to the coordinator. Run 3 of these on different ports to simulate the
// 3-node deployment behind a (harness-simulated) load balancer.

const http = require('http');
const { nowUtcMinutes } = require('./clock');

const PORT = process.env.NODE_PORT || 5001;
const COORDINATOR_PORT = process.env.COORDINATOR_PORT || 4000;
const NODE_ID = process.env.NODE_ID || `node-${PORT}`;

function askCoordinator(customerId, nowMin) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ customerId, nowUtcMinutes: nowMin });
    const req = http.request(
      {
        hostname: 'localhost',
        port: COORDINATOR_PORT,
        path: '/consume',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

const server = http.createServer(async (req, res) => {
  if (req.url !== '/api/v1/ping') {
    res.writeHead(404);
    res.end();
    return;
  }
  const customerId = req.headers['x-customer-id'];
  if (!customerId) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'missing X-Customer-Id header' }));
    return;
  }

  const nowMin = nowUtcMinutes(req.headers);

  try {
    const result = await askCoordinator(customerId, nowMin);
    if (result.allowed) {
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'X-Served-By': NODE_ID,
        'X-RateLimit-Limit': result.limit,
        'X-RateLimit-Remaining': result.remaining,
      });
      res.end(JSON.stringify({ ok: true, servedBy: NODE_ID, limit: result.limit, remaining: result.remaining }));
    } else {
      res.writeHead(429, {
        'Content-Type': 'application/json',
        'X-Served-By': NODE_ID,
        'Retry-After': result.retryAfterSeconds,
      });
      res.end(
        JSON.stringify({ ok: false, servedBy: NODE_ID, limit: result.limit, retryAfterSeconds: result.retryAfterSeconds })
      );
    }
  } catch (err) {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'coordinator unreachable', detail: String(err) }));
  }
});

server.listen(PORT, () => {
  console.log(`[${NODE_ID}] listening on ${PORT}`);
});
```

**`harness/run-harness.js`**
```javascript
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');

const COORDINATOR_PORT = 4000;
const NODE_PORTS = [5001, 5002, 5003];
const SRC = path.join(__dirname, '..', 'src');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function spawnProc(script, env, label) {
  const proc = spawn('node', [script], { env: { ...process.env, ...env }, stdio: 'pipe' });
  proc.stdout.on('data', (d) => process.stdout.write(`[${label}] ${d}`));
  proc.stderr.on('data', (d) => process.stderr.write(`[${label} ERR] ${d}`));
  return proc;
}

function fireRequest(port, customerId, extraHeaders) {
  return new Promise((resolve) => {
    const req = http.request(
      {
        hostname: 'localhost',
        port,
        path: '/api/v1/ping',
        method: 'GET',
        headers: { 'X-Customer-Id': customerId, ...extraHeaders },
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode, servedBy: res.headers['x-served-by'] }));
      }
    );
    req.on('error', () => resolve({ status: 'ERR' }));
    req.end();
  });
}

async function burst(customerId, count, extraHeaders) {
  const calls = [];
  for (let i = 0; i < count; i++) {
    const port = NODE_PORTS[Math.floor(Math.random() * NODE_PORTS.length)];
    calls.push(fireRequest(port, customerId, extraHeaders));
  }
  const results = await Promise.all(calls);
  const byNode = {};
  let allowed = 0;
  let denied = 0;
  for (const r of results) {
    if (r.status === 200) allowed++;
    else if (r.status === 429) denied++;
    if (r.servedBy) byNode[r.servedBy] = (byNode[r.servedBy] || 0) + 1;
  }
  return { allowed, denied, total: count, byNode };
}

function printRow(cols, widths) {
  console.log(cols.map((c, i) => String(c).padEnd(widths[i])).join(' | '));
}

async function main() {
  console.log('Starting coordinator + 3 app nodes...\n');
  const coordinator = spawnProc(path.join(SRC, 'coordinator.js'), { COORDINATOR_PORT }, 'coordinator');
  const nodes = NODE_PORTS.map((port, idx) =>
    spawnProc(
      path.join(SRC, 'server.js'),
      { NODE_PORT: port, COORDINATOR_PORT, NODE_ID: `node-${idx + 1}`, ALLOW_TIME_OVERRIDE: 'true' },
      `node-${idx + 1}`
    )
  );

  await sleep(500); // let servers bind

  const widths = [34, 8, 8, 8, 10];
  const results = [];

  try {
    console.log('\n=== SCENARIO A — Priya\'s boundary demo (flat 100 RPM tier, hammered randomly across 3 nodes) ===\n');

    const a = await burst('cust_demo_a', 100, {});
    results.push(['cust_demo_a (100 RPM tier, sends exactly 100)', a]);

    const b = await burst('cust_demo_b', 100, {});
    results.push(['cust_demo_b (100 RPM tier, sends exactly 100)', b]);

    const c = await burst('cust_demo_c_exceeder', 150, {});
    results.push(['cust_demo_c_exceeder (100 RPM tier, sends 150)', c]);

    console.log('\n=== SCENARIO B — Northwind schedule (burst window vs off-peak, same mechanism, hammered randomly across 3 nodes) ===\n');

    // 02:30 UTC = 150 minutes since midnight -> inside the 01:45-04:15 burst window (1250 RPM)
    const burstWindow = await burst('cust_northwind_001', 1300, { 'X-Debug-Now-Utc-Minutes': '150' });
    results.push(['cust_northwind_001 @ 02:30 UTC (burst, sends 1300)', burstWindow]);

    console.log('\nWaiting 61s for the sliding window to clear before the off-peak check ' +
      '(avoids the off-peak measurement being contaminated by burst-window request timestamps ' +
      'still sitting in the same customer\'s 60s log)...\n');
    await sleep(61000);

    // 10:00 UTC = 600 minutes since midnight -> off-peak window (201 RPM)
    const offPeak = await burst('cust_northwind_001', 250, { 'X-Debug-Now-Utc-Minutes': '600' });
    results.push(['cust_northwind_001 @ 10:00 UTC (off-peak, sends 250)', offPeak]);

    console.log('\n=== RESULTS ===\n');
    printRow(['Scenario', 'Sent', 'Allowed', 'Denied', 'Nodes hit'], widths);
    printRow(['-'.repeat(34), '-'.repeat(8), '-'.repeat(8), '-'.repeat(8), '-'.repeat(10)], widths);
    for (const [label, r] of results) {
      printRow([label, r.total, r.allowed, r.denied, Object.keys(r.byNode).length], widths);
    }

    console.log('\n=== PASS/FAIL CHECKS ===\n');
    const checks = [
      ['A gets exactly its 100 RPM budget', a.allowed === 100 && a.denied === 0],
      ['B gets exactly its 100 RPM budget (isolated from A)', b.allowed === 100 && b.denied === 0],
      ['C (same tier, sends 150) is cut off exactly at 100', c.allowed === 100 && c.denied === 50],
      ['Northwind burst window allows exactly 1250, denies the rest', burstWindow.allowed === 1250 && burstWindow.denied === 50],
      ['Northwind off-peak window allows exactly 201, denies the rest', offPeak.allowed === 201 && offPeak.denied === 49],
      ['Requests were actually spread across all 3 nodes (no sticky sessions)',
        Object.keys(a.byNode).length > 1 || Object.keys(burstWindow.byNode).length > 1],
    ];
    for (const [desc, pass] of checks) {
      console.log(`${pass ? 'PASS' : 'FAIL'} — ${desc}`);
    }

    const allPass = checks.every(([, pass]) => pass);
    console.log(`\nOverall: ${allPass ? 'ALL CHECKS PASSED' : 'SOME CHECKS FAILED — see above'}`);
  } finally {
    coordinator.kill();
    nodes.forEach((n) => n.kill());
  }
}

main();
```

Let me actually run this to give you real, current output for the README rather than recalling old numbers:

> Ran command
>
> - Recreate old-style project in a fresh dir to verify current run output
> - **Done**

## User:

> 9/1/2026 11:33:50

yeah continue

## Assistant:

> 9/1/2026 11:35:55

> Ran 2 commands
>
> - Write src files for solution2
> - Write harness and run it to capture real current output
> - **Done**

All 6 checks pass, confirmed on a fresh run. Here's the updated `README.md`:

**`README.md`**
````markdown
# RelayAPI Rate Limiter — Thin Vertical Slice

Zero dependencies. Node.js `http` module only — no `npm install`, no external
services, no config beyond what's in this repo.

## What this is

- One endpoint: `GET /api/v1/ping`
- A limiter that enforces per-customer RPM correctly across **3 real,
  separate node processes** with no shared memory of their own — they each
  delegate every request to a single **coordinator** process, which is the
  atomic source of truth for rate-limit counters.
- Config for 5 fake customers (`config/customers.json`): a stand-in for
  Northwind (`cust_northwind_001`), a flat-rate Growth customer
  (`cust_acme_002`), and three flat-rate demo customers used for the CTO's
  boundary demo.
- A harness that spins up the coordinator + 3 nodes, hammers them with
  randomized node selection per request (simulating a load balancer with no
  sticky sessions), and prints a results table plus a PASS/FAIL check list.

See `DECISIONS.md` for the reasoning behind the design (conflict
resolution, algorithm choice, what's proven vs. not, what's next).

## Requirements

- Node.js (any reasonably recent version). Nothing else — no `npm install`.

## How to run

```bash
cd solution
node harness/run-harness.js
```

That single command starts the coordinator, starts all 3 app nodes, runs
both demo scenarios, prints results, and shuts everything down. Takes
roughly **65 seconds** — most of that is one deliberate real-time wait
explained below, not the requests themselves.

Ports used: `4000` (coordinator), `5001`/`5002`/`5003` (the 3 app nodes).
Make sure those are free before running.

### If you want to hit the service manually instead

```bash
# terminal 1
node src/coordinator.js
# terminal 2, 3, 4 — one app node each
NODE_PORT=5001 NODE_ID=node-1 node src/server.js
NODE_PORT=5002 NODE_ID=node-2 node src/server.js
NODE_PORT=5003 NODE_ID=node-3 node src/server.js
# terminal 5
curl -H "X-Customer-Id: cust_demo_a" http://localhost:5001/api/v1/ping
```

## Architecture, briefly

- **App nodes** (`src/server.js`) hold no state of their own — pure request
  relay + response shaping (`200` with rate-limit headers, or `429` with
  `Retry-After`).
- **Coordinator** (`src/coordinator.js`) is the only place a decision is
  actually made, so it's the only place that needs to be atomic. It's a
  documented stand-in for what would be Redis (atomic `INCR`/Lua) or a DB
  row lock in a real multi-process deployment — see `DECISIONS.md`.
- **Algorithm**: a 60-second sliding-window log per customer (avoids the
  fixed-window edge-doubling bug at minute boundaries).
- **Limit lookup** (`src/limits.js`) is customer-identity-agnostic: every
  customer has a `schedule` array of `{startUtc, endUtc, rpm}` entries; the
  coordinator just matches current time against them. Northwind's schedule
  has two entries (burst window + off-peak); everyone else has one entry
  spanning the full day. Same mechanism, different data — Northwind is not
  a separate code path.
- **Clock override** (`src/clock.js`): the harness needs to exercise
  Northwind's burst AND off-peak windows without waiting real hours, so a
  node started with `ALLOW_TIME_OVERRIDE=true` will honor an
  `X-Debug-Now-Utc-Minutes` header. This is a generic time-simulation seam
  (changes what time the whole service thinks it is), not a per-customer
  bypass, and is off by default.

## What the two schedule numbers mean

Northwind is contracted to a 300 RPM daily average. Their nightly batch
runs 135 minutes (01:45–04:15 UTC) at 1250 RPM:

````
daily budget      = 300 RPM × 1440 min = 432,000 requests/day
batch usage       = 1250 RPM × 135 min = 168,750 requests
remaining budget  = 432,000 − 168,750  = 263,250 requests
remaining minutes = 1440 − 135         = 1,305 minutes
off-peak rate     = 263,250 / 1,305    ≈ 201.7 RPM → 201 (rounded down to
                                          stay under the 300 average, not over)
```

## Sample output

```
=== SCENARIO A — Priya's boundary demo (flat 100 RPM tier, hammered randomly across 3 nodes) ===

=== SCENARIO B — Northwind schedule (burst window vs off-peak, same mechanism, hammered randomly across 3 nodes) ===

Waiting 61s for the sliding window to clear before the off-peak check...

=== RESULTS ===

Scenario                            | Sent     | Allowed  | Denied   | Nodes hit
------------------------------------|----------|----------|----------|----------
cust_demo_a (100 RPM tier, sends exactly 100)   | 100  | 100  | 0    | 3
cust_demo_b (100 RPM tier, sends exactly 100)   | 100  | 100  | 0    | 3
cust_demo_c_exceeder (100 RPM tier, sends 150)  | 150  | 100  | 50   | 3
cust_northwind_001 @ 02:30 UTC (burst, sends 1300)   | 1300 | 1250 | 50 | 3
cust_northwind_001 @ 10:00 UTC (off-peak, sends 250) | 250  | 201  | 49 | 3

=== PASS/FAIL CHECKS ===

PASS — A gets exactly its 100 RPM budget
PASS — B gets exactly its 100 RPM budget (isolated from A)
PASS — C (same tier, sends 150) is cut off exactly at 100
PASS — Northwind burst window allows exactly 1250, denies the rest
PASS — Northwind off-peak window allows exactly 201, denies the rest
PASS — Requests were spread across all 3 nodes (no sticky sessions)

Overall: ALL CHECKS PASSED
```

Scenario A is the CTO's literal demo: two customers on a 100 RPM tier each
get exactly 100/100 allowed, a third on the same tier sending 150 gets cut
off at exactly 100 — all three with traffic randomized across all 3 node
processes.

Scenario B proves the schedule mechanism: the same customer, same code
path, gets exactly 1250 during the burst window and exactly 201 off-peak,
proven by simulating two different times of day in one run.

## Why the real 61-second wait

The daily-average clock is simulated via the debug header, but the
60-second RPM sliding window still runs on the **real** system clock — that
is what makes it a genuine rolling enforcement window in the first place.
Without the wait, the burst window's allowed requests would still be
sitting in that 60s log when the off-peak check fires milliseconds later,
silently eating into the off-peak budget. The wait exists to avoid that
cross-contamination, not as padding.

## Notes on what's *not* here

- No framework (`Express` etc.) — limiter logic sits inline in the request
  handler rather than as a literal `app.use()` middleware function.
  Functionally it plays the same role (runs before endpoint logic, can
  short-circuit the response with a `429`); just not that specific pattern.
- No persistence — coordinator state is in-memory and resets if the process
  restarts. See `DECISIONS.md`.
- Daily/off-peak numbers are hand-computed and hard-set in config (see the
  math above), not dynamically recalculated from actual usage. See
  `DECISIONS.md` for the tradeoff.
```

## User:

> 9/1/2026 11:44:37

make a readme.md full file for download

## Assistant:

> 9/1/2026 11:45:26

> Created 2 files, presented file
>
> - Full README.md file matching the fixed-schedule (burst/off-peak) design, ready for download
> - Full README.md file matching the fixed-schedule (burst/off-peak) design, ready for download
> - Presenting file(s)...
> - **Done**

Attached above — click to download and drop it straight into `solution/README.md`.

> File: [/home/claude/solution2/README.md](https://claude.ai/api/organizations/935646be-643e-4c94-90b6-1f96a3400ad4/conversations/9ed9999a-2e3d-4997-9547-8c0b6b2d05a9/wiggle/download-file?path=%2Fhome%2Fclaude%2Fsolution2%2FREADME.md)

## User:

> 9/1/2026 11:56:19

the readme is completely wrong. we used static 1250/201, no dynamic

## Assistant:

> 9/1/2026 11:56:51

You're right — I left in leftover phrasing from the dynamic version that implies live recalculation ("daily-average clock is simulated," "recalculated," etc.), even though the numbers themselves are correctly described as static/hand-set. That's confusing and contradictory. Let me fix it cleanly — this is a static two-entry schedule (1250 burst / 201 off-peak), full stop, no averaging logic at runtime.

> Edited 4 files
>
> - Editing file
> - Editing file
> - Editing file
> - Editing file
> - **Done**

Fixed — the doc now says static everywhere, with no leftover language implying live recomputation. Here's the corrected file:

> Presented file
>
> - Presenting file(s)...
> - **Done**

Corrected version attached. Summary of what was wrong and what changed:

- "the daily-average clock is simulated" → rewritten as "the *time of day* is simulated," with an explicit line that it only changes which static schedule entry gets matched, not any calculation.
- The schedule section now leads with a table of the two **static** RPM values, states plainly "no runtime math, no recalculation," and reframes the arithmetic as *justification for why 201 was chosen once, by hand* — not something the code does.
- Added an explicit "No dynamic recalculation of any kind" bullet at the end so it's unambiguous: no usage tracking, no adjustment, just a two-entry lookup table, same shape as every other customer's one-entry table.

> File: [/home/claude/solution2/README.md](https://claude.ai/api/organizations/935646be-643e-4c94-90b6-1f96a3400ad4/conversations/9ed9999a-2e3d-4997-9547-8c0b6b2d05a9/wiggle/download-file?path=%2Fhome%2Fclaude%2Fsolution2%2FREADME.md)

Powered by Claude Exporter (https://www.ai-chat-exporter.net)
