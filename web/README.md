# NEOP Console

The operator's window into NEOP: chat with it about the run ledger, watch the last 24
hours of runs, and **approve or deny the gates it's blocked on** — the human half of
the reversibility invariant (§2.1) and the approval UX (§7).

Three panes: chat history · conversation · run sessions. Amber means a run is waiting
on you, and it's the only colour allowed to move.

## Run it

```bash
cd web
npm install
npm run dev        # http://localhost:5173
```

Out of the box it runs against an **in-memory MockClient** — no backend required. This
is the "wind it up today" mode: real interactions (send a message, approve a gate),
mock data underneath.

```bash
npm test           # 13 tests: adapter mapping + client seam (idempotency, approve/deny)
```

## Go live (when the control plane exists)

The console talks to exactly one interface, `NeopClient` (`src/api/client.js`), with two
implementations chosen by env:

| `VITE_NEOP_API_BASE` | Client | Behaviour |
|---|---|---|
| _unset_ | `MockClient` | in-memory seed data, mutations kept locally |
| e.g. `/api` | `HttpClient` | calls the FastAPI control plane |

```bash
cp .env.example .env
# set VITE_NEOP_API_BASE=/api   (dev proxies /api → NEOP_API_ORIGIN, default :8000)
NEOP_API_ORIGIN=http://localhost:8000 npm run dev
```

### Endpoints the HttpClient expects (from the plan, §4/§5)

| Call | Method + path |
|---|---|
| bootstrap | `GET /metrics`, `GET /chats`, `GET /runs`, `GET /runs/timeline` |
| open a thread | `GET /chats/:id` |
| chat | `POST /neop/chat` `{ chatId, text }` → `{ who, at, text, log? }` |
| **approve/deny a gate** | `POST /runs/:id/gates/:gate` `{ decision, note }` (idempotent, §5) |

## The seam to the worker core

`src/api/adapter.js` maps the worker's `RunStatus` (`landed / escalated / awaiting_human
/ quarantined / running`) → the console's verdict vocabulary (`verified / vetoed /
awaiting / failed / running`). When the control plane ships, only `adapter.js` needs to
match its exact JSON — the UI doesn't change.

## Layout

```
web/src/
  NeopConsole.jsx     the three-pane console (design unchanged from the mockup)
  styles.js           design tokens + stylesheet
  api/
    client.js         NeopClient: MockClient + HttpClient + createClient()
    adapter.js        worker RunStatus  →  console verdict
    mockData.js       seed runs / chats / threads / metrics
```
