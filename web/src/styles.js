/* Design tokens + stylesheet for the NEOP console.
   Ink-blue ground, warm bone text. Amber means a run is blocked on you, and it is
   the only colour on screen allowed to move. Extracted verbatim from the original
   single-file mockup — do not restyle without a design reason. */

export const C = {
  ink: "#12151C", panel: "#171B24", raised: "#1E232E", line: "#282E3A",
  bone: "#E6E3DC", soft: "#C9CDD4", mute: "#7E8794", faint: "#565E6B",
  amber: "#E0A458", teal: "#5FB8B0", rust: "#C2564A",
};

/** verdict → label / colour / glyph. The console's display vocabulary. */
export const VERDICT = {
  verified: { label: "verified",      color: C.teal,  glyph: "✓" },
  vetoed:   { label: "verifier veto", color: C.rust,  glyph: "!" },
  awaiting: { label: "awaiting you",  color: C.amber, glyph: "⏸" },
  failed:   { label: "check failed",  color: C.rust,  glyph: "✕" },
  running:  { label: "running",       color: C.mute,  glyph: "•" },
  declined: { label: "declined",      color: C.mute,  glyph: "✕" },
};

export const CSS = `
.np, .np * { box-sizing: border-box; }
.np {
  --ink:${C.ink}; --panel:${C.panel}; --raised:${C.raised}; --line:${C.line};
  --bone:${C.bone}; --soft:${C.soft}; --mute:${C.mute}; --faint:${C.faint};
  --amber:${C.amber};
  --mono:'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
  --sans:'Inter', ui-sans-serif, system-ui, sans-serif;
  height:100vh; display:flex; flex-direction:column; overflow:hidden;
  background:var(--ink); color:var(--bone); font-family:var(--mono); font-size:13px;
}
.np button { font:inherit; color:inherit; background:none; border:none; cursor:pointer; }
.np input, .np textarea { font:inherit; color:inherit; background:none; border:none; outline:none; }
.np ::-webkit-scrollbar { width:7px; height:7px; }
.np ::-webkit-scrollbar-thumb { background:var(--line); border-radius:4px; }

/* ---- top bar ---- */
.np-top { display:flex; align-items:center; gap:12px; padding:9px 14px; flex-shrink:0;
  background:var(--panel); border-bottom:1px solid var(--line); }
.np-brand { font-weight:700; letter-spacing:.22em; font-size:13px; }
.np-meta { font-size:10px; letter-spacing:.09em; color:var(--faint); }
.np-alert { display:flex; align-items:center; gap:6px; padding:4px 8px; font-size:10px;
  letter-spacing:.09em; color:var(--amber); border:1px solid rgba(224,164,88,.3); }

/* ---- error banner ---- */
.np-err { display:flex; align-items:center; gap:10px; padding:8px 14px; flex-shrink:0;
  font-size:11px; color:${C.rust}; background:rgba(194,86,74,.09);
  border-bottom:1px solid rgba(194,86,74,.35); }
.np-err span { flex:1; }
.np-err-x { color:${C.rust}; font-size:12px; padding:0 4px; }

/* ---- the three panes ---- */
.np-body { flex:1; display:grid; grid-template-columns:250px minmax(0,1fr) 320px; min-height:0; }
@media (max-width:1040px) { .np-body { grid-template-columns:196px minmax(0,1fr) 262px; } }
@media (max-width:720px)  { .np-body { grid-template-columns:1fr; } }

.np-pane { display:flex; flex-direction:column; min-height:0; min-width:0; background:var(--panel); }
.np-left  { border-right:1px solid var(--line); }
.np-right { border-left:1px solid var(--line); }
.np-mid   { background:var(--ink); }

.np-tabs { display:none; flex-shrink:0; border-bottom:1px solid var(--line); background:var(--panel); }
.np-tabs button { flex:1; padding:9px 0; font-size:10px; letter-spacing:.11em; color:var(--faint);
  border-bottom:2px solid transparent; }
.np-tabs button[data-on="1"] { color:var(--bone); border-bottom-color:var(--amber); }
@media (max-width:720px) {
  .np-tabs { display:flex; }
  .np-pane[data-show="0"] { display:none; }
}

/* ---- left pane ---- */
.np-newchat { width:100%; display:flex; align-items:center; gap:8px; padding:8px 10px;
  font-size:11px; background:var(--raised); border:1px solid var(--line); }
.np-search { display:flex; align-items:center; gap:8px; padding:6px 10px;
  border:1px solid var(--line); margin-top:8px; }
.np-search input { width:100%; font-size:11px; }
.np-grouplabel { padding:8px 10px 5px; font-size:9px; letter-spacing:.18em; color:var(--faint); }
.np-chat { width:100%; text-align:left; display:block; padding:7px 10px; margin-bottom:1px;
  border-left:2px solid transparent; }
.np-chat[data-on="1"] { background:var(--raised); border-left-color:var(--amber); }
.np-chat-row { display:flex; align-items:baseline; gap:8px; }
.np-chat-title { font-family:var(--sans); font-size:12px; color:#BFC4CC; flex:1;
  white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.np-chat[data-on="1"] .np-chat-title { color:var(--bone); }
.np-chat-when { font-size:9px; color:var(--faint); flex-shrink:0; }
.np-chat-prev { font-size:10px; color:var(--faint); margin-top:2px;
  white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }

/* ---- middle pane ---- */
.np-head { padding:9px 18px; flex-shrink:0; display:flex; align-items:center; gap:8px;
  border-bottom:1px solid var(--line); }
.np-head-title { font-family:var(--sans); font-size:12.5px; white-space:nowrap;
  overflow:hidden; text-overflow:ellipsis; }
.np-chip { font-size:9px; padding:2px 6px; color:var(--faint); border:1px solid var(--line); flex-shrink:0; }
.np-scroll { flex:1; overflow-y:auto; padding:24px 18px; }
.np-thread { max-width:680px; margin:0 auto; }
.np-msg { margin-bottom:18px; }
.np-msg[data-grouped="1"] { margin-top:-12px; }
.np-who { display:flex; align-items:center; gap:8px; margin-bottom:6px; }
.np-tag { font-size:9px; padding:2px 6px; letter-spacing:.11em; }
.np-tag[data-w="human"] { color:var(--faint); border:1px solid var(--line); }
.np-tag[data-w="neop"] { color:var(--ink); background:var(--amber); font-weight:700; }
.np-bubble { padding:9px 14px; border-left:2px solid transparent; }
.np-bubble[data-w="human"] { border-left-color:var(--line); }
.np-bubble[data-w="neop"] { background:var(--panel); }
.np-text { font-family:var(--sans); font-size:13.5px; line-height:1.6; margin:0; color:var(--soft); }
.np-bubble[data-w="human"] .np-text { color:var(--bone); }
.np-log { margin:10px 0 0; padding:10px; font-family:var(--mono); font-size:10.5px;
  line-height:1.65; white-space:pre-wrap; overflow-x:auto;
  background:var(--ink); color:var(--mute); border:1px solid var(--line); }
.np-empty { padding-top:70px; text-align:center; }
.np-empty p { font-family:var(--sans); margin:0 0 6px; font-size:13.5px; color:var(--soft); }
.np-empty span { font-size:11px; color:var(--faint); }

.np-composer { padding:12px; flex-shrink:0; border-top:1px solid var(--line); }
.np-composer-in { max-width:680px; margin:0 auto; }
.np-box { display:flex; align-items:flex-end; gap:8px; padding:8px;
  background:var(--panel); border:1px solid var(--line); }
.np-box textarea { flex:1; resize:none; font-family:var(--sans); font-size:13px; line-height:1.55; }
.np-send { padding:8px; flex-shrink:0; background:var(--raised); color:var(--faint); }
.np-send[data-live="1"] { background:var(--amber); color:var(--ink); }
.np-hint { display:flex; align-items:center; gap:4px; margin-top:6px; font-size:9px; color:var(--faint); }

/* ---- right pane ---- */
.np-sec { padding:12px 13px; flex-shrink:0; border-bottom:1px solid var(--line); }
.np-sec-h { display:flex; align-items:baseline; justify-content:space-between; margin-bottom:8px;
  font-size:9px; letter-spacing:.18em; color:var(--faint); }
.np-night { position:relative; height:36px; }
.np-night-rule { position:absolute; left:0; right:0; top:16px; height:1px; background:var(--line); }
.np-tick { position:absolute; width:2px; }
.np-night-ax { position:absolute; left:0; right:0; bottom:0; display:flex;
  justify-content:space-between; font-size:8px; color:var(--faint); }
.np-gate { margin-bottom:10px; padding:10px; background:var(--raised); border-left:2px solid var(--amber); }
.np-gate-cls { font-size:10px; color:var(--amber); }
.np-gate-ask { font-family:var(--sans); font-size:12.5px; line-height:1.4; color:var(--bone); margin:6px 0 10px; }
.np-opts { display:flex; flex-wrap:wrap; gap:6px; }
.np-opt { padding:4px 8px; font-size:10px; border:1px solid var(--line); color:#BFC4CC; }
.np-opt[data-primary="1"] { background:var(--amber); color:var(--ink); border-color:var(--amber); }
.np-opt[data-busy="1"] { opacity:.5; cursor:default; }
.np-run { width:100%; text-align:left; display:flex; align-items:flex-start; gap:9px; padding:7px 10px; }
.np-run[data-on="1"] { background:var(--raised); }
.np-run-name { font-size:12px; }
.np-run-id { font-size:9px; color:var(--faint); }
.np-run-meta { display:flex; align-items:center; gap:9px; margin-top:4px; font-size:9.5px; color:var(--faint); }
.np-run-meta span { display:flex; align-items:center; gap:3px; }
.np-detail { padding:2px 10px 12px 34px; }
.np-detail p { font-size:11px; line-height:1.55; color:var(--soft); margin:0 0 9px; }
.np-fact { display:flex; gap:7px; font-size:9.5px; color:var(--faint); margin-bottom:5px; }
.np-acts { display:flex; flex-wrap:wrap; gap:4px; margin-top:9px; }
.np-act { padding:2px 6px; font-size:9px; border:1px solid var(--line); color:var(--mute); }
.np-detail-btns { display:flex; gap:8px; margin-top:11px; }
.np-detail-btns button { padding:4px 8px; font-size:10px; border:1px solid var(--line); color:#BFC4CC; }
.np-foot { padding:8px 13px; flex-shrink:0; display:flex; justify-content:space-between;
  font-size:9px; color:var(--faint); border-top:1px solid var(--line); }
.np-foot span { display:flex; align-items:center; gap:4px; }

.np-pulse { animation:npP 2.6s ease-in-out infinite; }
.np-dot { width:4px; height:4px; border-radius:9px; background:var(--mute); animation:npD 1.2s ease-in-out infinite; }
.np-dot:nth-child(2){ animation-delay:.15s } .np-dot:nth-child(3){ animation-delay:.3s }
@keyframes npP { 0%,100%{opacity:1} 50%{opacity:.45} }
@keyframes npD { 0%,100%{opacity:.25} 50%{opacity:1} }
@media (prefers-reduced-motion:reduce){ .np-pulse,.np-dot{ animation:none } }
.np button:focus-visible, .np input:focus-visible, .np textarea:focus-visible {
  outline:2px solid var(--amber); outline-offset:1px; }
`;
