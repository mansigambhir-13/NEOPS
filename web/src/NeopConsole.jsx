import React, { useState, useMemo, useRef, useEffect } from "react";
import {
  Plus, Check, ChevronRight, CircleDot, ShieldAlert, Send, Search,
  Clock, Hash, GitBranch, Eye, CornerDownLeft
} from "lucide-react";
import { C, VERDICT, CSS } from "./styles.js";
import { createClient, IS_LIVE } from "./api/client.js";

/* ------------------------------------------------------------------
   NEOP — operator console.  Three vertical panes:

     ┌──────────────┬────────────────────────┬──────────────────┐
     │ CHAT HISTORY │  CONVERSATION          │  RUN SESSIONS    │
     └──────────────┴────────────────
     ────────┴──────────────────┘

   Data comes from a NeopClient (mock in dev, the control plane when
   VITE_NEOP_API_BASE is set). The component never knows which.
   Design is unchanged from the original mockup — only the data source
   and the two mutating actions (send, decide) go through the client.
------------------------------------------------------------------- */

export default function NeopConsole() {
  const client = useMemo(() => createClient(), []);

  // server-backed state (loaded on mount)
  const [chats, setChats] = useState([]);
  const [runs, setRuns] = useState([]);
  const [ticks, setTicks] = useState([]);
  const [metrics, setMetrics] = useState(null);
  const [ready, setReady] = useState(false);

  // ui state
  const [chatId, setChatId] = useState("c1");
  const [threads, setThreads] = useState({});
  const [query, setQuery] = useState("");
  const [openRun, setOpenRun] = useState("7b09");
  const [decided, setDecided] = useState({});
  const [deciding, setDeciding] = useState(null); // runId currently posting
  const [draft, setDraft] = useState("");
  const [thinking, setThinking] = useState(false);
  const [pane, setPane] = useState("chat");
  const [error, setError] = useState(null); // surfaced failures (a swallowed approval is worse than a visible one)

  const endRef = useRef(null);
  const messages = threads[chatId] || [];

  // bootstrap: metrics + chats + runs + timeline. In live mode, poll every 10s so
  // runs flipping running → awaiting/landed reach the operator without a reload.
  useEffect(() => {
    let live = true;
    const load = () =>
      client.getBootstrap().then((b) => {
        if (!live) return;
        setMetrics(b.metrics);
        setChats((prev) => (b.chats.length || !prev.length ? b.chats : prev));
        setRuns(b.runs);
        setTicks(b.ticks);
        setReady(true);
        // once the server has settled a run past awaiting, its own verdict wins; and a
        // RE-PARK under a new actionKey is a fresh gate — drop the stale decision so
        // the new question surfaces (§2.1: changed content needs a fresh human look)
        setDecided((d) => {
          const next = { ...d };
          for (const id of Object.keys(next)) {
            const r = b.runs.find((x) => x.id === id);
            if (!r) continue;
            const rekeyed = r.gate?.actionKey && next[id]?.actionKey && r.gate.actionKey !== next[id].actionKey;
            if (r.verdict !== "awaiting" || rekeyed) delete next[id];
          }
          return next;
        });
      }).catch(() => {});
    load();
    if (!IS_LIVE) return () => { live = false; };
    const t = setInterval(load, 10_000);
    return () => { live = false; clearInterval(t); };
  }, [client]);

  // load a thread the first time its chat is opened
  useEffect(() => {
    if (!chatId || chatId === "new" || threads[chatId]) return;
    let live = true;
    client.getThread(chatId).then((msgs) => {
      if (live) setThreads((t) => ({ ...t, [chatId]: msgs }));
    });
    return () => { live = false; };
  }, [chatId, client, threads]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.length, thinking, chatId]);

  const pending = useMemo(
    () => runs.filter((r) => r.verdict === "awaiting" && r.gate && !decided[r.id]),
    [runs, decided]
  );

  const grouped = useMemo(() => {
    const q = query.toLowerCase();
    const hit = chats.filter(
      (c) => c.title.toLowerCase().includes(q) || c.preview.toLowerCase().includes(q)
    );
    return ["Today", "This week", "Earlier"]
      .map((g) => [g, hit.filter((c) => c.group === g)])
      .filter(([, l]) => l.length);
  }, [query, chats]);

  const now = () => new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

  const send = async () => {
    const text = draft.trim();
    if (!text) return;
    const id = chatId;
    setThreads((t) => ({ ...t, [id]: [...(t[id] || []), { who: "human", at: now(), text }] }));
    setDraft("");
    setThinking(true);
    setError(null);
    try {
      const reply = await client.sendMessage(id, text);
      setThreads((t) => ({ ...t, [id]: [...(t[id] || []), reply] }));
    } catch (e) {
      setError(`Message didn't reach NEOP — ${e.message}`);
    } finally {
      setThinking(false);
    }
  };

  const decide = async (runId, gateClass, option) => {
    if (decided[runId] || deciding) return;
    setDeciding(runId);
    setError(null);
    try {
      // the control plane is authoritative: we record only what it confirms (§5).
      const approval = await client.decideGate(runId, gateClass, option);
      setDecided((d) => ({ ...d, [runId]: approval }));
      // an approve RESUMES the worker server-side — refetch so the run's real
      // post-resume verdict (landed / vetoed) replaces the optimistic chip
      const b = await client.getBootstrap();
      setRuns(b.runs);
      setTicks(b.ticks);
      setMetrics(b.metrics);
      setDecided((d) => {
        const next = { ...d };
        for (const id of Object.keys(next)) {
          const r = b.runs.find((x) => x.id === id);
          if (!r) continue;
          const rekeyed = r.gate?.actionKey && next[id]?.actionKey && r.gate.actionKey !== next[id].actionKey;
          if (r.verdict !== "awaiting" || rekeyed) delete next[id];
        }
        return next;
      });
    } catch (e) {
      setError(`Couldn't record your decision — ${e.message}. Nothing was sent.`);
    } finally {
      setDeciding(null);
    }
  };

  const contracts = metrics?.contracts ?? 0;
  const scopes = metrics?.scopes ?? 0;
  const spend = metrics?.spend ?? { used: "—", cap: "—" };

  return (
    <div className="np">
      <style>{`@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500&family=JetBrains+Mono:wght@400;500;700&display=swap');${CSS}`}</style>

      <header className="np-top">
        <span className="np-brand">NEOP</span>
        <span className="np-meta">{contracts} CONTRACTS · {scopes} SCOPES</span>
        {IS_LIVE && <span className="np-meta">· LIVE</span>}
        <div style={{ flex: 1 }} />
        {pending.length > 0 && (
          <span className="np-alert np-pulse">
            <ShieldAlert size={11} />{pending.length} WAITING ON YOU
          </span>
        )}
        <span className="np-meta">SPEND {spend.used} / {spend.cap}</span>
      </header>

      <nav className="np-tabs">
        {[["chats", "HISTORY"], ["chat", "CHAT"], ["runs", "SESSIONS"]].map(([k, l]) => (
          <button key={k} data-on={pane === k ? "1" : "0"} onClick={() => setPane(k)}>{l}</button>
        ))}
      </nav>

      {error && (
        <div className="np-err" role="alert">
          <span>{error}</span>
          <button className="np-err-x" aria-label="Dismiss" onClick={() => setError(null)}>✕</button>
        </div>
      )}

      <div className="np-body">
        {/* ══ 1 · chat history ══════════════════════════ */}
        <aside className="np-pane np-left" data-show={pane === "chats" ? "1" : "0"}>
          <div style={{ padding: 12, flexShrink: 0 }}>
            <button className="np-newchat" onClick={() => { setChatId("new"); setPane("chat"); }}>
              <Plus size={13} color={C.amber} /> New chat
            </button>
            <div className="np-search">
              <Search size={12} color={C.faint} />
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search chats" />
            </div>
          </div>

          <div style={{ flex: 1, overflowY: "auto", padding: "0 8px 12px" }}>
            {ready && grouped.length === 0 && (
              <p style={{ padding: "18px 10px", fontSize: 11, lineHeight: 1.6, color: C.faint, fontFamily: "var(--sans)" }}>
                No chats match that. Try a task name — doc-sync, triage, outreach.
              </p>
            )}
            {grouped.map(([group, list]) => (
              <div key={group} style={{ marginBottom: 8 }}>
                <div className="np-grouplabel">{group.toUpperCase()}</div>
                {list.map((c) => (
                  <button
                    key={c.id}
                    className="np-chat"
                    data-on={c.id === chatId ? "1" : "0"}
                    onClick={() => { setChatId(c.id); setPane("chat"); }}
                  >
                    <span className="np-chat-row">
                      <span className="np-chat-title">{c.title}</span>
                      <span className="np-chat-when">{c.when}</span>
                    </span>
                    <span className="np-chat-prev" style={{ display: "block" }}>{c.preview}</span>
                  </button>
                ))}
              </div>
            ))}
          </div>
        </aside>

        {/* ══ 2 · conversation ══════════════════════════ */}
        <main className="np-pane np-mid" data-show={pane === "chat" ? "1" : "0"}>
          <div className="np-head">
            <span className="np-head-title">
              {chats.find((c) => c.id === chatId)?.title || "New chat"}
            </span>
            <span className="np-chip">scope repos/backend</span>
          </div>

          <div className="np-scroll">
            <div className="np-thread">
              {messages.length === 0 && (
                <div className="np-empty">
                  <p>Ask about a run, or reshape a contract.</p>
                  <span>NEOP answers from the run ledger and the session transcripts.</span>
                </div>
              )}

              {messages.map((m, i) => {
                const same = i > 0 && messages[i - 1].who === m.who;
                return (
                  <div className="np-msg" data-grouped={same ? "1" : "0"} key={i}>
                    {!same && (
                      <div className="np-who">
                        <span className="np-tag" data-w={m.who}>{m.who === "human" ? "YOU" : "NEOP"}</span>
                        <span style={{ fontSize: 9, color: C.faint }}>{m.at}</span>
                      </div>
                    )}
                    <div className="np-bubble" data-w={m.who}>
                      <p className="np-text">{m.text}</p>
                      {m.log && <pre className="np-log">{m.log}</pre>}
                    </div>
                  </div>
                );
              })}

              {thinking && (
                <div className="np-msg">
                  <div className="np-who"><span className="np-tag" data-w="neop">NEOP</span></div>
                  <div className="np-bubble" data-w="neop" style={{ display: "flex", gap: 6, padding: "14px" }}>
                    <span className="np-dot" /><span className="np-dot" /><span className="np-dot" />
                  </div>
                </div>
              )}
              <div ref={endRef} />
            </div>
          </div>

          <div className="np-composer">
            <div className="np-composer-in">
              <div className="np-box">
                <textarea
                  rows={2}
                  value={draft}
                  placeholder="Message NEOP"
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
                />
                <button className="np-send" aria-label="Send message" data-live={draft.trim() ? "1" : "0"} onClick={send}>
                  <Send size={13} />
                </button>
              </div>
              <div className="np-hint"><CornerDownLeft size={9} /> to send · shift + enter for a new line</div>
            </div>
          </div>
        </main>

        {/* ══ 3 · run sessions ══════════════════════════ */}
        <aside className="np-pane np-right" data-show={pane === "runs" ? "1" : "0"}>
          <div className="np-sec">
            <div className="np-sec-h"><span>LAST 24 HOURS</span><span>{ticks.length} runs</span></div>
            <div className="np-night">
              <div className="np-night-rule" />
              {ticks.map((t, i) => {
                const v = VERDICT[t.v];
                const wait = t.v === "awaiting";
                return (
                  <span
                    key={i}
                    className={wait ? "np-tick np-pulse" : "np-tick"}
                    title={`${String(t.h).padStart(2, "0")}:00 · ${v.label}`}
                    style={{ left: `${(t.h / 24) * 100}%`, top: wait ? 4 : 11, height: wait ? 20 : 10, background: v.color }}
                  />
                );
              })}
              <div className="np-night-ax"><span>00</span><span>06</span><span>12</span><span>18</span><span>24</span></div>
            </div>
          </div>

          {pending.length > 0 && (
            <div className="np-sec">
              <div className="np-sec-h" style={{ color: C.amber }}><span>WAITING ON YOU</span></div>
              {pending.map((r) => (
                <div className="np-gate" key={r.id}>
                  <div>
                    <span className="np-gate-cls">{r.gate.cls}</span>
                    <span style={{ fontSize: 9, color: C.faint }}> · run {r.id}</span>
                  </div>
                  <p className="np-gate-ask">{r.gate.ask}</p>
                  <div className="np-opts">
                    {r.gate.opts.map((o, i) => (
                      <button
                        key={o}
                        className="np-opt"
                        data-primary={i === 0 ? "1" : "0"}
                        data-busy={deciding === r.id ? "1" : "0"}
                        disabled={deciding === r.id}
                        onClick={() => decide(r.id, r.gate.cls, o)}
                      >
                        {o}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="np-grouplabel" style={{ padding: "10px 13px 6px" }}>RUN SESSIONS</div>

          <div style={{ flex: 1, overflowY: "auto", padding: "0 4px 14px" }}>
            {runs.map((r) => {
              const settled = decided[r.id];
              const approved = settled?.decision === "approve";
              // a decided gate reflects the actual decision — deny must NOT read as approved.
              const v = settled
                ? { color: approved ? C.teal : C.mute, glyph: approved ? "✓" : "✕", label: approved ? "approved" : "declined" }
                : VERDICT[r.verdict];
              const open = openRun === r.id;
              return (
                <div key={r.id}>
                  <button className="np-run" data-on={open ? "1" : "0"} onClick={() => setOpenRun(open ? null : r.id)}>
                    <span style={{ color: v.color, fontSize: 11, flexShrink: 0, marginTop: 1 }}>{v.glyph}</span>
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                        <span className="np-run-name">{r.task}</span>
                        <span className="np-run-id">{r.id}</span>
                      </span>
                      <span className="np-run-meta">
                        <span style={{ color: v.color }}>{v.label}</span>
                        <span><Clock size={9} />{r.at}</span>
                        <span>{r.dur}</span>
                        <span><Hash size={9} />{r.tok}</span>
                      </span>
                    </span>
                    <ChevronRight size={12} style={{ flexShrink: 0, marginTop: 2, color: C.faint,
                      transform: open ? "rotate(90deg)" : "none" }} />
                  </button>

                  {open && (
                    <div className="np-detail">
                      <p>{r.note}</p>
                      <div className="np-fact"><Check size={10} /><span>{r.check}</span></div>
                      <div className="np-fact"><Eye size={10} /><span>verifier ran on a cold context</span></div>
                      <div className="np-fact"><GitBranch size={10} /><span>worktree neop/run-{r.id}</span></div>
                      <div className="np-acts">
                        {r.actions.map((a) => <span className="np-act" key={a}>{a}</span>)}
                      </div>
                      <div className="np-detail-btns">
                        <button>Open transcript</button>
                        {r.verdict === "vetoed" && (
                          <button style={{ borderColor: "rgba(194,86,74,.4)", color: C.rust }}>Tighten the check</button>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          <div className="np-foot">
            <span>veto rate {metrics?.vetoRate ?? "—"}</span>
            <span>interrupts today {metrics?.interruptsToday ?? 0}</span>
            <span><CircleDot size={9} color={C.teal} /> breakers {metrics?.breakers ?? "—"}</span>
          </div>
        </aside>
      </div>
    </div>
  );
}
