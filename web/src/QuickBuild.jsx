import React, { useState, useMemo, useEffect } from "react";
import {
  Search, Plus, Check, AlertTriangle, Zap, FileText, Package,
  ArrowRight, X, Clock, Shield, Globe, Key
} from "lucide-react";
import { createClient, IS_LIVE } from "./api/client.js";

/* ------------------------------------------------------------------
   Quick Build — the library and the workbench.

   Sibling to the operator console, deliberately inverted: the console
   is a night shift (ink ground, bone text) and watches things run.
   This is a daylight workshop (bone ground, ink text) and composes
   them. Same three hues, flipped, so you always know which you're in.

   Signature is the envelope bar — one horizontal strip showing what
   you are about to create. Quiet segments are reversible, amber ones
   cannot be undone, hatched ones ingest input you don't control.

   Data comes from GET /registry (the markdown library on disk) and the
   Spawn button is POST /quickbuild/spawn — a REAL spawn: the resolver
   validates (taint×irreversibility, forbidden, ground truth), stamps
   pins, writes neops/<client>/<slug>/spec.md. Its refusals render in
   the envelope pane verbatim; they are the product.
------------------------------------------------------------------- */

const C = {
  paper: "#F2EFE8", card: "#FBFAF7", edge: "#DDD8CE", rule: "#C9C3B6",
  ink: "#1A1E27", mid: "#5A6070", faint: "#8B9099",
  amber: "#B8791F", teal: "#2E7D74", rust: "#A8412F",
};

const CSS = `
.qb, .qb * { box-sizing: border-box; }
.qb {
  --paper:${C.paper}; --card:${C.card}; --edge:${C.edge}; --rule:${C.rule};
  --ink:${C.ink}; --mid:${C.mid}; --faint:${C.faint}; --amber:${C.amber};
  --mono:'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
  --sans:'Inter', ui-sans-serif, system-ui, sans-serif;
  height:100vh; display:flex; flex-direction:column; overflow:hidden;
  background:var(--paper); color:var(--ink); font-family:var(--mono); font-size:13px;
}
.qb button { font:inherit; color:inherit; background:none; border:none; cursor:pointer; }
.qb input { font:inherit; color:inherit; background:none; border:none; outline:none; }
.qb ::-webkit-scrollbar { width:8px; height:8px; }
.qb ::-webkit-scrollbar-thumb { background:var(--rule); border-radius:4px; }

.qb-top { display:flex; align-items:center; gap:14px; padding:11px 16px; flex-shrink:0;
  background:var(--card); border-bottom:1px solid var(--edge); }
.qb-brand { font-weight:700; letter-spacing:.2em; font-size:13px; }
.qb-sub { font-size:10px; letter-spacing:.1em; color:var(--faint); }
.qb-nav { font-size:10px; letter-spacing:.1em; color:var(--mid); text-decoration:none; }
.qb-nav:hover { color:var(--ink); }

.qb-body { flex:1; display:grid; grid-template-columns:242px minmax(0,1fr) 316px; min-height:0; }
@media (max-width:1040px){ .qb-body{ grid-template-columns:190px minmax(0,1fr) 258px; } }
@media (max-width:720px) { .qb-body{ grid-template-columns:1fr; } }

.qb-pane { display:flex; flex-direction:column; min-height:0; min-width:0; }
.qb-left { background:var(--card); border-right:1px solid var(--edge); }
.qb-right{ background:var(--card); border-left:1px solid var(--edge); }

.qb-tabs { display:none; flex-shrink:0; border-bottom:1px solid var(--edge); background:var(--card); }
.qb-tabs button { flex:1; padding:9px 0; font-size:10px; letter-spacing:.11em; color:var(--faint);
  border-bottom:2px solid transparent; }
.qb-tabs button[data-on="1"] { color:var(--ink); border-bottom-color:var(--amber); }
@media (max-width:720px){ .qb-tabs{ display:flex; } .qb-pane[data-show="0"]{ display:none; } }

.qb-seg { display:flex; margin:12px 12px 0; border:1px solid var(--edge); }
.qb-seg button { flex:1; padding:6px 0; font-size:10px; letter-spacing:.1em; color:var(--faint); }
.qb-seg button[data-on="1"] { background:var(--ink); color:var(--paper); }
.qb-find { display:flex; align-items:center; gap:7px; margin:8px 12px; padding:6px 9px;
  border:1px solid var(--edge); }
.qb-find input { width:100%; font-size:11px; }

.qb-item { width:100%; text-align:left; display:block; padding:8px 12px;
  border-left:2px solid transparent; border-bottom:1px solid var(--paper); }
.qb-item[data-on="1"] { background:var(--paper); border-left-color:var(--amber); }
.qb-item-top { display:flex; align-items:center; gap:6px; }
.qb-item-name { font-size:11.5px; flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.qb-item-does { font-family:var(--sans); font-size:10.5px; color:var(--faint); margin-top:3px;
  line-height:1.35; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }
.qb-pip { width:6px; height:6px; border-radius:9px; flex-shrink:0; }

.qb-doc { flex:1; overflow-y:auto; padding:26px 30px; }
.qb-doc-in { max-width:640px; }
.qb-doc h1 { font-size:19px; margin:0 0 4px; letter-spacing:-.01em; }
.qb-doc .qb-lede { font-family:var(--sans); font-size:14px; line-height:1.6; color:var(--mid); margin:0 0 20px; }
.qb-doc h2 { font-size:12px; letter-spacing:.09em; margin:22px 0 8px; color:var(--faint); }
.qb-doc p { font-family:var(--sans); font-size:13.5px; line-height:1.65; margin:0 0 10px; }
.qb-doc li { font-family:var(--sans); font-size:13.5px; line-height:1.6; margin-bottom:5px; }
.qb-doc code { background:var(--card); border:1px solid var(--edge); padding:1px 4px; font-size:12px; }
.qb-doc strong { font-weight:600; }
.qb-front { display:flex; flex-wrap:wrap; gap:6px; margin:0 0 20px; }
.qb-badge { display:flex; align-items:center; gap:4px; padding:3px 7px; font-size:10px;
  border:1px solid var(--edge); background:var(--card); color:var(--mid); }
.qb-badge[data-warn="1"] { border-color:var(--amber); color:var(--amber); }
.qb-add { display:flex; align-items:center; gap:6px; padding:7px 12px; margin-top:22px;
  background:var(--ink); color:var(--paper); font-size:11.5px; }
.qb-add[data-in="1"] { background:none; color:var(--mid); border:1px solid var(--edge); }

.qb-blank { padding:80px 20px; text-align:center; }
.qb-blank p { font-family:var(--sans); font-size:14px; color:var(--mid); margin:0 0 6px; }
.qb-blank span { font-size:11px; color:var(--faint); }

.qb-sec { padding:13px; border-bottom:1px solid var(--edge); flex-shrink:0; }
.qb-sec-h { font-size:9px; letter-spacing:.18em; color:var(--faint); margin-bottom:9px; }

/* signature — the envelope bar */
.qb-env { display:flex; height:26px; gap:2px; margin-bottom:8px; }
.qb-env-seg { flex:1; min-width:3px; }
.qb-env-seg[data-k="rev"]  { background:var(--rule); }
.qb-env-seg[data-k="irr"]  { background:var(--amber); }
.qb-env-seg[data-k="taint"]{ background:repeating-linear-gradient(45deg,
  var(--mid) 0 3px, transparent 3px 6px); border:1px solid var(--mid); }
.qb-env-empty { flex:1; border:1px dashed var(--rule); }
.qb-legend { display:flex; gap:12px; font-size:9px; color:var(--faint); }
.qb-legend span { display:flex; align-items:center; gap:4px; }
.qb-key { width:9px; height:9px; }

.qb-row { display:flex; align-items:center; gap:7px; padding:5px 0; font-size:11px;
  border-bottom:1px solid var(--paper); }
.qb-row-name { flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.qb-x { color:var(--faint); flex-shrink:0; }
.qb-fact { display:flex; gap:7px; font-size:10px; color:var(--faint); margin-bottom:5px; align-items:flex-start; }

.qb-warn { padding:10px; margin-top:10px; background:var(--paper);
  border-left:2px solid var(--amber); }
.qb-warn[data-err="1"] { border-left-color:${C.rust}; }
.qb-warn-h { display:flex; align-items:center; gap:6px; font-size:10px; color:var(--amber); margin-bottom:5px; }
.qb-warn[data-err="1"] .qb-warn-h { color:${C.rust}; }
.qb-warn p { font-family:var(--sans); font-size:11.5px; line-height:1.5; color:var(--mid); margin:0; }

/* the Foreman composer — conversation in, NEOP out */
.qb-composer { flex-shrink:0; padding:12px; border-top:1px solid var(--edge); background:var(--card); }
.qb-chatbox { display:flex; align-items:flex-end; gap:8px; padding:8px; max-width:640px;
  background:var(--paper); border:1px solid var(--edge); }
.qb-chatbox textarea { flex:1; resize:none; font-family:var(--sans); font-size:13px;
  line-height:1.5; background:none; border:none; outline:none; color:var(--ink); }
.qb-go { padding:8px 12px; flex-shrink:0; background:var(--ink); color:var(--paper); font-size:11px; }
.qb-go[data-off="1"] { background:var(--edge); color:var(--faint); }
.qb-hint { margin-top:6px; font-size:9.5px; color:var(--faint); max-width:640px; }
.qb-step { display:flex; align-items:center; gap:8px; padding:6px 0; font-size:11.5px;
  border-bottom:1px solid var(--card); }
.qb-step-tool { min-width:110px; }
.qb-step-detail { color:var(--faint); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; flex:1; }
.qb-result { margin-top:16px; padding:12px; border:1px solid var(--amber); }
.qb-result[data-bad="1"] { border-color:${C.rust}; }
.qb-fleet-row { display:flex; align-items:center; gap:7px; padding:5px 0; font-size:11px;
  border-bottom:1px solid var(--paper); }

.qb-slug { display:flex; align-items:center; gap:6px; margin:13px 13px 0; padding:7px 9px;
  border:1px solid var(--edge); background:var(--card); }
.qb-slug input { width:100%; font-size:11.5px; }
.qb-spawn { margin:9px 13px 13px; padding:11px; background:var(--ink); color:var(--paper);
  display:flex; align-items:center; justify-content:center; gap:8px; font-size:12px; letter-spacing:.04em; }
.qb-spawn[data-off="1"] { background:var(--edge); color:var(--faint); cursor:not-allowed; }
.qb-live { margin:13px; padding:11px; border:1px solid var(--amber); color:var(--amber); font-size:11.5px; }
`;

export default function QuickBuild() {
  const client = useMemo(() => createClient(), []);
  const [tools, setTools] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [kind, setKind] = useState("templates");
  const [sel, setSel] = useState(null);
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState([]);
  const [tpl, setTpl] = useState(null);
  const [slug, setSlug] = useState("");
  const [spawned, setSpawned] = useState(null); // {slug, spec, pins}
  const [refusal, setRefusal] = useState(null); // resolver/server refusal text
  const [busy, setBusy] = useState(false);
  const [pane, setPane] = useState("doc");
  // the Foreman chat: requirement in, NEOP out
  const [req, setReq] = useState("");
  const [building, setBuilding] = useState(false);
  const [buildResult, setBuildResult] = useState(null); // last turn {status, spawned, actions, verdict, questions?, error?}
  const [convo, setConvo] = useState([]); // the whole build conversation: {role:'operator'|'foreman', ...}
  const [fleet, setFleet] = useState([]);

  const refreshFleet = () => client.getFleet().then(setFleet).catch(() => {});

  // the library comes from the real registry on disk (GET /registry)
  useEffect(() => {
    let live = true;
    client.getRegistry().then((r) => {
      if (!live) return;
      setTools(r.tools ?? []);
      setTemplates(r.templates ?? []);
      const first = (r.templates ?? [])[0];
      if (first) {
        setSel(first.id);
        setTpl(first.id);
        setPicked([...first.required]);
        setSlug(`you/${first.id}`);
      }
    }).catch(() => {});
    client.getFleet().then((f) => { if (live) setFleet(f); }).catch(() => {});
    return () => { live = false; };
  }, [client]);

  // the wire: requirement (+ conversation so far) → POST /build → a Foreman turn.
  // needs_input renders as questions and the next message answers them in-thread.
  const build = async () => {
    const requirement = req.trim();
    if (!requirement || building) return;
    const history = convo.map((t) => ({
      role: t.role,
      text: t.role === "operator" ? t.text : (t.questions?.join("\n") || t.summary || t.status),
    }));
    setConvo((c) => [...c, { role: "operator", text: requirement }]);
    setBuilding(true);
    setBuildResult(null);
    setPane("doc");
    try {
      const r = await client.buildNeop(requirement, "operator", history);
      setBuildResult(r);
      setConvo((c) => [...c, { role: "foreman", ...r }]);
      refreshFleet();
    } catch (e) {
      const r = { status: "failed", error: e.message, actions: [], spawned: [], verdict: [] };
      setBuildResult(r);
      setConvo((c) => [...c, { role: "foreman", ...r }]);
    } finally {
      setBuilding(false);
      setReq("");
    }
  };

  const reap = async (s) => {
    try {
      await client.reapQuickBuild(s);
      refreshFleet();
    } catch { /* surfaced by fleet staying put */ }
  };

  const list = kind === "tools" ? tools : templates;
  const filtered = list.filter((x) => {
    const s = (kind === "tools" ? x.name : x.id) + " " + (x.does ?? "");
    return s.toLowerCase().includes(q.toLowerCase());
  });

  const doc = kind === "tools"
    ? tools.find((t) => t.name === sel)
    : templates.find((t) => t.id === sel);

  const activeTemplate = templates.find((t) => t.id === tpl);

  const env = useMemo(() => {
    const ts = picked.map((n) => tools.find((t) => t.name === n)).filter(Boolean);
    const irr = ts.filter((t) => !t.rev);
    const taint = ts.filter((t) => t.taint === "untrusted");
    return {
      tools: ts, irr, taint,
      classes: [...new Set(ts.map((t) => t.cls))],
      egress: [...new Set(ts.flatMap((t) => t.egress ?? []))],
      secrets: [...new Set(ts.flatMap((t) => t.secrets ?? []))],
      collision: irr.length > 0 && taint.length > 0,
      forbidden: ts.filter((t) => activeTemplate?.forbidden?.includes(t.name)),
      optionalPicked: ts.filter((t) => activeTemplate?.optional?.includes(t.name)).map((t) => t.name),
    };
  }, [picked, tools, activeTemplate]);

  const toggle = (name) => {
    setSpawned(null);
    setRefusal(null);
    setPicked((p) => (p.includes(name) ? p.filter((x) => x !== name) : [...p, name]));
  };

  const pickTemplate = (t) => {
    setTpl(t.id);
    setPicked([...t.required]);
    setSlug(`you/${t.id}`);
    setSpawned(null);
    setRefusal(null);
  };

  // THE spawn — real: the resolver validates, pins, writes spec.md. Refusals render.
  const spawn = async () => {
    if (!env.tools.length || !tpl || busy) return;
    setBusy(true);
    setRefusal(null);
    const t0 = performance.now();
    try {
      const r = await client.spawnQuickBuild({
        slug: slug.trim(),
        template: tpl,
        withOptional: env.optionalPicked,
        owner: "operator",
      });
      setSpawned({ ...r, ms: Math.round(performance.now() - t0) });
    } catch (e) {
      setRefusal(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="qb">
      <style>{`@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500;700&display=swap');${CSS}`}</style>

      <header className="qb-top">
        <span className="qb-brand">QUICK BUILD</span>
        <span className="qb-sub">{tools.length} TOOLS · {templates.length} TEMPLATES · {IS_LIVE ? "LIVE REGISTRY" : "MOCK"}</span>
        <div style={{ flex: 1 }} />
        <a className="qb-nav" href="#console">CONSOLE →</a>
      </header>

      <nav className="qb-tabs">
        {[["lib", "LIBRARY"], ["doc", "DOC"], ["env", "ENVELOPE"]].map(([k, l]) => (
          <button key={k} data-on={pane === k ? "1" : "0"} onClick={() => setPane(k)}>{l}</button>
        ))}
      </nav>

      <div className="qb-body">
        {/* ══ library ═══════════════════════════════════ */}
        <aside className="qb-pane qb-left" data-show={pane === "lib" ? "1" : "0"}>
          <div className="qb-seg">
            {[["templates", "TEMPLATES"], ["tools", "TOOLS"]].map(([k, l]) => (
              <button key={k} data-on={kind === k ? "1" : "0"}
                onClick={() => {
                  setKind(k);
                  setSel(k === "tools" ? tools[0]?.name : templates[0]?.id);
                }}>
                {l}
              </button>
            ))}
          </div>

          <div className="qb-find">
            <Search size={12} color={C.faint} />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="grep the registry" />
          </div>

          <div style={{ flex: 1, overflowY: "auto" }}>
            {filtered.map((x) => {
              const id = kind === "tools" ? x.name : x.id;
              const on = sel === id;
              return (
                <button key={id} className="qb-item" data-on={on ? "1" : "0"}
                  onClick={() => { setSel(id); setPane("doc"); setBuildResult(null); }}>
                  <span className="qb-item-top">
                    {kind === "tools" ? (
                      <span className="qb-pip" style={{
                        background: x.taint === "untrusted" ? C.mid : x.rev ? C.rule : C.amber,
                      }} />
                    ) : (
                      <Package size={11} color={C.faint} />
                    )}
                    <span className="qb-item-name">{id}</span>
                    {kind === "templates" && <span style={{ fontSize: 9, color: C.faint }}>{x.ver}</span>}
                  </span>
                  <span className="qb-item-does" style={{ display: "block" }}>{x.does}</span>
                </button>
              );
            })}
            {!filtered.length && (
              <p style={{ padding: "20px 14px", fontFamily: "var(--sans)", fontSize: 11.5, color: C.faint, lineHeight: 1.5 }}>
                Nothing matches. The registry is markdown on disk — you can also just open{" "}
                <code>registry/{kind}/</code> and read it.
              </p>
            )}
          </div>
        </aside>

        {/* ══ the doc + the Foreman ═════════════════════ */}
        <main className="qb-pane" data-show={pane === "doc" ? "1" : "0"} style={{ minWidth: 0 }}>
          <div className="qb-doc">
          {building || (convo.length && buildResult) ? (
            <div className="qb-doc-in">
              <h1>the Foreman</h1>
              {convo.map((t, ti) =>
                t.role === "operator" ? (
                  <p key={ti} className="qb-lede" style={{ marginTop: ti ? 18 : 0 }}>{t.text}</p>
                ) : (
                  <div key={ti}>
                    {(t.actions ?? []).map((a, i) => (
                      <div className="qb-step" key={i}>
                        <span className="qb-pip" style={{ background: a.verdict === "allow" ? C.teal : C.rust }} />
                        <span className="qb-step-tool">{a.tool}</span>
                        <span className="qb-step-detail">{a.detail}</span>
                      </div>
                    ))}
                    {t.status === "needs_input" ? (
                      <div className="qb-result" data-bad="0" style={{ borderColor: C.amber }}>
                        <div style={{ fontSize: 11, letterSpacing: ".08em", marginBottom: 6, color: C.amber }}>
                          FOREMAN ASKS
                        </div>
                        <ul style={{ fontFamily: "var(--sans)", fontSize: 13, color: C.ink, margin: 0, paddingLeft: 18, lineHeight: 1.7 }}>
                          {(t.questions ?? []).map((qq, qi) => (
                            <li key={qi}>{qq.replace(/^-\s*/, "")}</li>
                          ))}
                        </ul>
                        <p style={{ fontFamily: "var(--sans)", fontSize: 11.5, color: C.faint, margin: "8px 0 0" }}>
                          answer below — the build continues in this thread{t.mode ? ` (${t.mode} foreman)` : ""}
                        </p>
                      </div>
                    ) : (
                      <div className="qb-result" data-bad={t.status === "landed" ? "0" : "1"}>
                        <div style={{ fontSize: 11, letterSpacing: ".08em", marginBottom: 6,
                          color: t.status === "landed" ? C.amber : C.rust }}>
                          {t.status === "landed"
                            ? `SPAWNED ${(t.spawned ?? []).join(", ") || "(nothing new)"}`
                            : `BUILD ${String(t.status).toUpperCase()}`}
                        </div>
                        {t.summary && (
                          <p style={{ fontFamily: "var(--sans)", fontSize: 13, color: C.ink, margin: "0 0 8px", lineHeight: 1.55 }}>
                            {t.summary}
                          </p>
                        )}
                        <p style={{ fontFamily: "var(--sans)", fontSize: 12.5, color: C.mid, margin: 0, lineHeight: 1.5 }}>
                          {t.error ?? (t.verdict ?? []).join(" ") ?? ""}
                          {t.mode ? ` (${t.mode} foreman)` : ""}
                        </p>
                      </div>
                    )}
                  </div>
                ),
              )}
              {building && <p style={{ color: C.faint, fontSize: 12, marginTop: 12 }}>composing — reading the registry, writing the spec…</p>}
              {!building && convo.length > 0 && (
                <button className="qb-add" data-in="1" style={{ marginTop: 14 }} onClick={() => { setConvo([]); setBuildResult(null); }}>
                  <ArrowRight size={12} /> new build — back to the library
                </button>
              )}
            </div>
          ) : !doc ? (
            <div className="qb-blank">
              <p>Pick a template to start from.</p>
              <span>Or browse tools — every one is a markdown file you can read in full.</span>
            </div>
          ) : (
            <div className="qb-doc-in">
              <h1>{kind === "tools" ? doc.name : doc.id}</h1>
              <p className="qb-lede">{doc.does}</p>

              <div className="qb-front">
                {kind === "tools" ? (
                  <>
                    <span className="qb-badge">{doc.cls}</span>
                    <span className="qb-badge" data-warn={doc.rev ? "0" : "1"}>
                      {doc.rev ? <Check size={10} /> : <AlertTriangle size={10} />}
                      {doc.rev ? "reversible" : "irreversible"}
                    </span>
                    <span className="qb-badge" data-warn={doc.taint === "untrusted" ? "1" : "0"}>
                      <Shield size={10} />{doc.taint}
                    </span>
                    {(doc.egress ?? []).map((e) => (
                      <span className="qb-badge" key={e}><Globe size={10} />{e}</span>
                    ))}
                    {(doc.secrets ?? []).map((s) => (
                      <span className="qb-badge" key={s}><Key size={10} />{s}</span>
                    ))}
                  </>
                ) : (
                  <>
                    <span className="qb-badge">v{doc.ver}</span>
                    <span className="qb-badge">{doc.required.length} required</span>
                    {(doc.groundTruth ?? []).map((g) => (
                      <span className="qb-badge" key={g}><FileText size={10} />needs {g}</span>
                    ))}
                    {doc.forbidden.map((f) => (
                      <span className="qb-badge" key={f}><X size={10} />{f}</span>
                    ))}
                  </>
                )}
              </div>

              <Markdown src={doc.body ?? ""} />

              {kind === "tools" ? (
                <button className="qb-add" data-in={picked.includes(doc.name) ? "1" : "0"}
                  onClick={() => toggle(doc.name)}>
                  {picked.includes(doc.name) ? <><X size={12} /> Remove from build</> : <><Plus size={12} /> Add to build</>}
                </button>
              ) : (
                <button className="qb-add" onClick={() => pickTemplate(doc)}>
                  <ArrowRight size={12} /> Start from {doc.id}
                </button>
              )}
            </div>
          )}
          </div>

          {/* the Foreman composer — conversation in, NEOP out */}
          <div className="qb-composer">
            <div className="qb-chatbox">
              <textarea
                rows={2}
                value={req}
                placeholder="Describe the NEOP you need — the Foreman reads the registry and builds it"
                onChange={(e) => setReq(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); build(); } }}
              />
              <button className="qb-go" data-off={req.trim() && !building ? "0" : "1"} onClick={build}>
                {building ? "BUILDING…" : "BUILD"}
              </button>
            </div>
            <div className="qb-hint">
              the Foreman: reads INDEX → picks a template → writes spec.md → spawns with pins. Its refusals render verbatim.
            </div>
          </div>
        </main>

        {/* ══ the envelope ══════════════════════════════ */}
        <aside className="qb-pane qb-right" data-show={pane === "env" ? "1" : "0"}>
          <div className="qb-sec">
            <div className="qb-sec-h">ENVELOPE · {tpl ?? "—"}</div>
            <div className="qb-env">
              {env.tools.length === 0 && <span className="qb-env-empty" />}
              {env.tools.map((t) => (
                <span key={t.name} className="qb-env-seg" title={`${t.name} · ${t.cls}`}
                  data-k={t.taint === "untrusted" ? "taint" : t.rev ? "rev" : "irr"} />
              ))}
            </div>
            <div className="qb-legend">
              <span><i className="qb-key" style={{ background: C.rule }} />reversible</span>
              <span><i className="qb-key" style={{ background: C.amber }} />irreversible</span>
              <span><i className="qb-key" style={{
                background: `repeating-linear-gradient(45deg, ${C.mid} 0 3px, transparent 3px 6px)`,
                border: `1px solid ${C.mid}`,
              }} />untrusted input</span>
            </div>

            {env.collision && (
              <div className="qb-warn">
                <div className="qb-warn-h"><AlertTriangle size={11} /> reader/writer collision</div>
                <p>
                  Reads untrusted input via <b>{env.taint.map((t) => t.name).join(", ")}</b> and
                  holds irreversible <b>{env.irr.map((t) => t.name).join(", ")}</b>. A stranger's
                  text can reach an action that can't be undone. The resolver will REFUSE this —
                  it wants to be two NEOPs: a reader that writes a brief, and a writer that reads
                  only the brief.
                </p>
              </div>
            )}

            {env.forbidden.length > 0 && (
              <div className="qb-warn">
                <div className="qb-warn-h"><X size={11} /> forbidden by template</div>
                <p>
                  {env.forbidden.map((t) => t.name).join(", ")} — the <b>{tpl}</b> template excludes
                  {env.forbidden.length > 1 ? " these" : " this"}. Read its doc for why.
                </p>
              </div>
            )}

            {refusal && (
              <div className="qb-warn" data-err="1">
                <div className="qb-warn-h"><X size={11} /> the resolver refused</div>
                <p>{refusal}</p>
              </div>
            )}
          </div>

          <div style={{ flex: 1, overflowY: "auto", padding: "10px 13px" }}>
            <div className="qb-sec-h">TOOLS · {env.tools.length}</div>
            {env.tools.map((t) => (
              <div className="qb-row" key={t.name}>
                <span className="qb-pip" style={{
                  background: t.taint === "untrusted" ? C.mid : t.rev ? C.rule : C.amber,
                }} />
                <span className="qb-row-name">{t.name}</span>
                <button className="qb-x" aria-label={`remove ${t.name}`} onClick={() => toggle(t.name)}><X size={11} /></button>
              </div>
            ))}
            {!env.tools.length && (
              <p style={{ fontFamily: "var(--sans)", fontSize: 11.5, color: C.faint, lineHeight: 1.5 }}>
                Empty. Start from a template, or add tools one at a time.
              </p>
            )}

            <div className="qb-sec-h" style={{ marginTop: 18 }}>RESOLVED</div>
            <div className="qb-fact"><Zap size={10} style={{ marginTop: 1 }} /><span>{env.classes.join(", ") || "—"}</span></div>
            <div className="qb-fact"><Globe size={10} style={{ marginTop: 1 }} /><span>{env.egress.join(", ") || "no network"}</span></div>
            <div className="qb-fact"><Key size={10} style={{ marginTop: 1 }} /><span>{env.secrets.join(", ") || "no secrets"}</span></div>
            <div className="qb-fact"><Shield size={10} style={{ marginTop: 1 }} /><span>{env.taint.length ? "untrusted input" : "trusted inputs only"}</span></div>
            {(activeTemplate?.groundTruth ?? []).length > 0 && (
              <div className="qb-fact"><FileText size={10} style={{ marginTop: 1 }} />
                <span>needs ground truth: {activeTemplate.groundTruth.join(", ")}</span></div>
            )}

            <div className="qb-sec-h" style={{ marginTop: 18 }}>FLEET · {fleet.length}</div>
            {fleet.map((f) => (
              <div className="qb-fleet-row" key={f.slug}>
                <Package size={10} color={C.faint} />
                <span className="qb-row-name">{f.slug}</span>
                <span style={{ fontSize: 9, color: C.faint }}>{f.template}</span>
                <button className="qb-x" aria-label={`reap ${f.slug}`} title="reap" onClick={() => reap(f.slug)}>
                  <X size={11} />
                </button>
              </div>
            ))}
            {!fleet.length && (
              <p style={{ fontFamily: "var(--sans)", fontSize: 11, color: C.faint, margin: 0 }}>
                No NEOPs yet. Ask the Foreman below, or spawn from a template.
              </p>
            )}
          </div>

          <div className="qb-slug">
            <FileText size={11} color={C.faint} />
            <input value={slug} onChange={(e) => { setSlug(e.target.value); setSpawned(null); }}
              placeholder="client/slug" aria-label="NEOP slug" />
          </div>

          {spawned ? (
            <div className="qb-live">
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 5 }}>
                <Clock size={11} /> spawned in {spawned.ms}ms
              </div>
              <span style={{ color: C.mid, fontSize: 10.5 }}>
                spec written to {spawned.spec} · pins{" "}
                {Object.entries(spawned.pins ?? {}).map(([k, v]) => `${k}@${v}`).join(", ")}
              </span>
            </div>
          ) : (
            <button className="qb-spawn" data-off={env.tools.length && !busy ? "0" : "1"} onClick={spawn}>
              <Zap size={13} /> {busy ? "spawning…" : `Spawn ${tpl ?? ""}`}
            </button>
          )}
        </aside>
      </div>
    </div>
  );
}

/* minimal markdown — headings, bold, inline code, bullets */
function Markdown({ src }) {
  const blocks = src.split("\n").filter((l) => l.trim().length);
  return (
    <>
      {blocks.map((line, i) => {
        if (line.startsWith("## ")) return <h2 key={i}>{line.slice(3).toUpperCase()}</h2>;
        if (line.startsWith("- ")) return <li key={i}>{inline(line.slice(2))}</li>;
        if (line.startsWith("|")) return <p key={i} style={{ fontFamily: "var(--mono)", fontSize: 11.5 }}>{line}</p>;
        return <p key={i}>{inline(line)}</p>;
      })}
    </>
  );
}

function inline(s) {
  const parts = s.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  return parts.map((p, i) => {
    if (p.startsWith("**")) return <strong key={i}>{p.slice(2, -2)}</strong>;
    if (p.startsWith("`")) return <code key={i}>{p.slice(1, -1)}</code>;
    return <React.Fragment key={i}>{p}</React.Fragment>;
  });
}
