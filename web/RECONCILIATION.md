# Adapter reconciliation checklist — connecting the console to the real control plane

When the cloud backend plan is approved and the FastAPI control plane exists, this is
the mechanical path to go from MockClient → live. **The UI does not change.** Only two
files touch the wire: `src/api/adapter.js` (shape mapping) and `src/api/client.js`
(endpoints/auth). Everything below is anchored to functions in those two files.

Work top to bottom. Each item is: **Assumption** (what the code does today) →
**Confirm** (what to read from the plan / a live response) → **Change** (if it differs)
→ **Verify** (how to prove it).

---

## 0. First, extract these unknowns from the approved plan

Fill this table from the backend plan before touching code — it drives everything else.

| # | Question | Where it lands |
|---|---|---|
| 0.1 | Exact `RunStatus` string values the API emits? | §1 |
| 0.2 | JSON field names on a run record (`runId`? `run_id`? `id`?) | §2 |
| 0.3 | How is a *pending approval* represented — inline on the run, or a separate `/approvals` feed? | §3 |
| 0.4 | Does the API send a human-readable gate question + options, or only an action class? | §3 |
| 0.5 | Base path + auth scheme (bearer token? session cookie? OIDC?) | §4, §5 |
| 0.6 | Is there a stream (SSE/WebSocket) for live run updates, or is it poll-only? | §6 |
| 0.7 | Idempotency: does the server key on `runId+gate`, or require the worker's `actionKey` (task_id, logical_date, content_hash)? | §7 |
| 0.8 | Error body shape on 4xx/5xx (`{detail}`? `{error}`?) | §8 |

> If the plan is silent on any row, that's a question back to the backend owner **before**
> wiring — not a guess. A wrong guess here fails silently in production.

---

## 1. Status enum → `statusToVerdict(outcome)`

- **Assumption:** the API's status is one of
  `landed | escalated | quarantined | awaiting_human | running | admitted | verifying | dropped`
  (the worker's `RunStatus` from `src/types.ts`), and maps →
  `verified | vetoed | failed | awaiting | running`.
- **Confirm:** `curl $BASE/runs | jq '.[].status' | sort -u` and compare to the switch's cases.
- **Change:** add any new status string to the `switch` in `adapter.js`. **Default stays
  `"failed"`** — an unmapped status must read red, never silently `verified`.
- **Edge case to nail:** the API likely can't distinguish "escalated by verifier veto"
  (→ `vetoed`, rust `!`) from "escalated for another reason". If it exposes a reason/flag
  (e.g. `outcome.escalationCause === "verifier_veto"`), branch on it; otherwise all
  escalations show as `vetoed`, which is acceptable but note it.
- **Verify:** `web/tests/adapter.test.js` already asserts every mapping — add a case per
  new status and keep it green (`npm test`).

## 2. Run record fields → `toConsoleRun(r)`

- **Assumption (current fallbacks):**
  `id←runId|id`, `task←taskId|task`, `at`, `dur←durationHuman|dur`,
  `tok←tokensHuman|tok`, `verdict←verdict|statusToVerdict`, `note←note|reasons.join`,
  `check←check|successCheck`, `actions←actions`, `gate` (spread if present).
- **Confirm:** `curl $BASE/runs | jq '.[0]'` — read the real keys.
- **Change points (most likely mismatches):**
  - **snake_case vs camelCase.** If the API sends `run_id`, `task_id`, `success_check`,
    add those to the `??` chains in `toConsoleRun` (one line each). Prefer fixing it here
    over renaming across the UI.
  - **`at`** — the console wants a short label like `"04:00"`. If the API sends an ISO
    timestamp, format it in `toConsoleRun` (`new Date(r.startedAt).toLocaleTimeString(...)`).
  - **`dur` / `tok`** — the console wants pre-humanised strings (`"6m 12s"`, `"84.2k"`).
    If the API sends raw ms / integer tokens, add `humanizeDuration()` / `humanizeTokens()`
    helpers in `adapter.js` and use them here. Do NOT push formatting into the components.
  - **`actions`** — the console renders chips like `"read ×14"`. If the API sends raw
    audit events, aggregate `{tool → count}` in `toConsoleRun` into `"tool ×n"` strings.
- **Verify:** the two `toConsoleRun` tests in `adapter.test.js`; add one built from a real
  captured `/runs` record (paste it into the test as a fixture).

## 3. Pending gate shape → `gate: { cls, ask, opts }`

This is the highest-risk mapping — it drives the human approval UX, the whole point of §2.1.

- **Assumption:** a run awaiting approval carries
  `gate: { cls: "publish_public", ask: "<question>", opts: ["Publish all five", ...] }`.
- **Confirm (0.3/0.4):** does the control plane send this inline, and does it include the
  human question + option labels?
- **Change — two scenarios:**
  - **API sends inline gate** → map its fields into `{cls, ask, opts}` inside `toConsoleRun`.
    `cls` = the action class (`public_publish` etc.); if the API uses the worker's class
    names (`public_publish`, `external_email`), either display them as-is or add a
    `CLASS_LABELS` map in `adapter.js`.
  - **API only sends the action class** (likely — the worker's `awaiting_human` outcome
    carries a `pendingAction`, not prose) → synthesise `ask`/`opts` in the adapter from a
    small `GATE_PROMPTS` table keyed by action class, e.g.
    `public_publish → { ask: "Publish …?", opts: ["Publish", "Hold, I'll edit"] }`.
    Keep this table in `adapter.js` so it's one place.
- **Critical:** `opts[0]` renders as the amber primary button. Ensure the *safe* default is
  never index 0 for a destructive class — for irreversible gates the primary should be the
  cautious option, or make primary explicit rather than positional.
- **Verify in-browser:** an awaiting run shows in "WAITING ON YOU" with a real question and
  buttons; approving decrements the header count.

## 4. Endpoints & payloads → `HttpClient`

- **Assumption (current calls):**
  | Call | Method + path | Body |
  |---|---|---|
  | bootstrap | `GET /metrics`, `/chats`, `/runs`, `/runs/timeline` | — |
  | thread | `GET /chats/:id` | — |
  | chat | `POST /neop/chat` | `{chatId, text}` |
  | gate | `POST /runs/:id/gates/:gate` | `{decision, note}` |
- **Confirm:** match each against the plan's route table. The console's routes were written
  *from* the plan (§4/§5) but the plan may have renamed them.
- **Change:** rename paths in the four `HttpClient` methods only. If `/metrics`/`/chats`/
  `/runs/timeline` don't exist yet, the current `.catch(() => <mock fallback>)` keeps the UI
  alive on partial backends — leave those catches until each route ships, then remove.
- **Metrics shape** (`§ getBootstrap`): console needs
  `{contracts, scopes, spend:{used,cap}, vetoRate, interruptsToday, breakers}`. Map the
  API's metrics object to this in a `toMetrics()` helper if names differ.
- **Timeline shape:** console needs `[{h:0-23, v:<verdict>}]`. If the API sends timestamped
  runs instead, derive ticks in `toBootstrap` (bucket by hour, map status→verdict).
- **Verify:** `VITE_NEOP_API_BASE=/api NEOP_API_ORIGIN=<plane> npm run dev`, watch the
  Network tab — every call 200s, no console fallback firing.

## 5. Auth & transport

- **Assumption:** `HttpClient.#json` sends only `content-type: application/json`. **No auth.**
- **Confirm (0.5):** bearer token, cookie, or OIDC?
- **Change:** add an `Authorization` header (or `credentials: "include"` for cookies) in
  `#json`. Source the token from an env var or a `/session` call — **never** hardcode it,
  never put it in a query string (mirrors the worker's secret posture). CORS: prefer the
  dev proxy (`/api` → origin, already in `vite.config.js`) so calls stay same-origin.
- **Verify:** an unauthenticated call gets 401 and surfaces the error banner (§8), an
  authenticated one 200s.

## 6. Real-time freshness

- **Assumption:** the console loads once on mount (`getBootstrap`) and never refreshes —
  fine for mock, wrong for a live operator watching runs flip `running → awaiting`.
- **Confirm (0.6):** SSE/WebSocket available?
- **Change (pick one, smallest first):**
  - **Poll:** add a `setInterval` re-`getBootstrap()` every ~10s (add a `refresh()` on the
    client; guard against clobbering a `decided`/optimistic state).
  - **Stream:** if the plane exposes SSE, add `client.subscribe(onRun)` to `HttpClient` and
    patch runs into state on each event. Keep it behind the same interface so Mock ignores it.
- **Verify:** trigger a run server-side; the timeline + run list update without a manual reload.

## 7. Idempotency & decision semantics

- **Assumption:** `decideGate` posts `{decision, note}`; idempotency is the **server's** job,
  keyed (we assume) on `runId+gate`. `decisionFromOption()` infers approve/deny from the
  option text (`/don't|hold|no|cancel|skip/i → deny`).
- **Confirm (0.7):** does the server dedupe on `runId+gate`, or does it need the worker's
  `actionKey(task_id, logical_date, content_hash)`? Does it want an explicit `decision`
  field or infer from a chosen `optionId`?
- **Change:**
  - If the server needs a richer key, send `actionKey` in the body (the run record must then
    expose `logicalDate` + a content hash; add them to `toConsoleRun`'s passthrough).
  - Prefer the server returning the **canonical `Approval`** (`{decision, actionKey, ts,
    approvedBy}`); the console already stores exactly that from `decideGate` and renders
    approved/declined from `approval.decision`. Keep `decisionFromOption` only as a client-side
    label hint, not the source of truth once the server decides.
- **Verify:** double-click an option → one server-side decision, UI shows it once, a repeat
  is a no-op (the worker's §6.2 guarantee, now proven across the wire).

## 8. Errors

- **Assumption:** `#json` throws `"<METHOD> <path> → <status>"` on `!res.ok`; the component
  shows it in the error banner.
- **Confirm (0.8):** the 4xx/5xx body shape.
- **Change:** in `#json`, on `!res.ok` parse the body and throw its message
  (`{detail}`/`{error}`) so the banner says *why*, not just the status code.
- **Verify:** force a 400 (bad gate id) → banner shows the server's message; a failed
  approval says "Nothing was sent."

---

## 9. Verification matrix (run before calling it connected)

| Check | Command / action | Pass |
|---|---|---|
| statuses map | `curl $BASE/runs \| jq '.[].status' \| sort -u` vs switch | every value has a case |
| run fields | `curl $BASE/runs \| jq '.[0]'` vs `toConsoleRun` | no `undefined` in the UI card |
| bootstrap | open console, Network tab | metrics/chats/runs/timeline all 200 |
| gate render | an awaiting run | real question + options in WAITING panel |
| approve | click primary | header count −1, run shows "approved" |
| deny | click a "don't/hold" option | run shows "declined" (not approved) |
| idempotency | double-click an option | one decision server-side |
| auth fail | drop the token | 401 → error banner |
| errors | bad gate id | banner shows server message |
| unit tests | `cd web && npm test` | adapter + client green (extend fixtures with real payloads) |

## 10. Definition of done

- [ ] §0 table filled from the approved plan
- [ ] `adapter.js`: `statusToVerdict` + `toConsoleRun` (+ `toMetrics`/timeline/gate helpers) match live JSON
- [ ] `client.js`: four endpoints + auth header match the plane
- [ ] real-time strategy chosen and wired (§6)
- [ ] `web/tests/*` extended with a captured live `/runs` record as a fixture; `npm test` green
- [ ] verification matrix (§9) all pass against the running control plane
- [ ] `.env` documents `VITE_NEOP_API_BASE`; MockClient still works with it unset (keep the fallback path alive for offline dev)

> Scope guard: if any step needs a component change beyond `adapter.js`/`client.js`, stop —
> that means the API is imposing shape on the UI. Absorb it in the adapter instead. The
> whole design of the seam is that the control plane's JSON never reaches a component.
