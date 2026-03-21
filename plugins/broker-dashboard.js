/**
 * PodBay Broker Dashboard Plugin
 *
 * Opens the broker telemetry dashboard as a popup window from within the
 * injected game page context.
 *
 * The dashboard is written directly into an about:blank popup — this keeps
 * it same-origin with the game page, allowing window.opener.PodBayBrokerTelemetry
 * to be read freely without cross-origin restrictions.
 *
 * Requires: window.PodBayBridge, window.PodBayIdentity (for clientId)
 */
; (function () {
  'use strict';

  if (window.__podBayBrokerDashboardInstalled) return;
  window.__podBayBrokerDashboardInstalled = true;

  var TAG = '[PodBay:BrokerDashboard]';
  var POPUP_NAME = 'podbay_broker_dashboard';
  var WIN_OPTS = 'width=1400,height=900,resizable=yes,scrollbars=yes';

  // ── Dashboard HTML (embedded so it runs in an about:blank popup
  //    that is same-origin with this game page, giving it full access
  //    to window.opener.PodBayBrokerTelemetry without CORS restrictions)
  // Source of truth: broker-client-dashboard.html in the PodBay repo root.
  // ─────────────────────────────────────────────────────────────────────
  var DASHBOARD_HTML = '<!DOCTYPE html>'
    + '<html lang="en" data-theme="dark"><head>'
    + '<meta charset="UTF-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>PodBay Broker Telemetry</title>'
    + '<style>'
    + '*,*::before,*::after{margin:0;padding:0;box-sizing:border-box}'
    + ':root{'
    + '--bg-base:#0a0e17;--bg-surface:#111827;--bg-el:#1a2236;--bg-hover:#1e293b;'
    + '--accent:#63b3ed;--acc-dim:rgba(99,179,237,.15);'
    + '--success:#68d391;--suc-dim:rgba(104,211,145,.15);'
    + '--danger:#fc8181;--dan-dim:rgba(252,129,129,.15);'
    + '--warning:#f6ad55;--war-dim:rgba(246,173,85,.15);'
    + '--purple:#b794f6;--pur-dim:rgba(183,148,246,.15);'
    + '--info:#76e4f7;--inf-dim:rgba(118,228,247,.15);'
    + '--text1:#e2e8f0;--text2:#a0aec0;--textm:#4a5568;'
    + '--bdr:rgba(255,255,255,.06);--r:8px;--overlay:rgba(10,14,23,.92);--scrollbar:rgba(255,255,255,.12);--scrollbar-hover:rgba(255,255,255,.22)}'
    + '[data-theme="light"]{--bg-base:#f0f4f8;--bg-surface:#fff;--bg-el:#e2e8f0;--bg-hover:#cbd5e0;--accent:#2b6cb0;--acc-dim:rgba(43,108,176,.12);--success:#276749;--suc-dim:rgba(39,103,73,.12);--danger:#c53030;--dan-dim:rgba(197,48,48,.1);--warning:#c05621;--war-dim:rgba(192,86,33,.1);--purple:#553c9a;--pur-dim:rgba(85,60,154,.1);--info:#0987a0;--inf-dim:rgba(9,135,160,.1);--text1:#1a202c;--text2:#2d3748;--textm:#718096;--bdr:rgba(0,0,0,.1);--overlay:rgba(240,244,248,.92);--scrollbar:rgba(0,0,0,.15);--scrollbar-hover:rgba(0,0,0,.28)}'
    + 'body{font-family:"Inter",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;'
    + 'font-size:12px;background:var(--bg-base);color:var(--text1);height:100vh;'
    + 'display:flex;flex-direction:column;overflow:hidden;-webkit-font-smoothing:antialiased}'
    + '.top-bar{height:48px;background:var(--bg-surface);border-bottom:1px solid var(--bdr);'
    + 'display:flex;align-items:center;padding:0 16px;gap:12px;flex-shrink:0}'
    + '.brand{font-size:14px;font-weight:700;white-space:nowrap}'
    + '.brand span{color:var(--accent)}'
    + '.stats{display:flex;gap:6px;margin-left:12px}'
    + '.stat-pill{background:var(--bg-el);border:1px solid var(--bdr);border-radius:20px;padding:2px 10px;font-size:11px}'
    + '.stat-pill .n{font-weight:700;margin-right:3px}'
    + '.s-total .n{color:var(--accent)}.s-connected .n{color:var(--success)}'
    + '.s-calls .n{color:var(--warning)}.s-errors .n{color:var(--danger)}'
    + '.spacer{flex:1}'
    + '.src-badge{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--text2)}'
    + '.src-dot{width:8px;height:8px;border-radius:50%;background:var(--textm)}'
    + '.src-dot.ok{background:var(--success);box-shadow:0 0 5px var(--success)}'
    + '.src-dot.missing{background:var(--danger);animation:pulse 1.2s infinite}'
    + '.btn{background:var(--bg-el);border:1px solid var(--bdr);border-radius:6px;'
    + 'color:var(--text2);padding:4px 10px;font-size:11px;cursor:pointer;'
    + 'transition:background 120ms,color 120ms,border-color 120ms}'
    + '.btn:hover{background:var(--bg-hover);color:var(--text1)}'
    + '.btn.danger:hover{background:var(--dan-dim);color:var(--danger);border-color:var(--danger)}'
    + '.btn.active{background:var(--war-dim);color:var(--warning);border-color:var(--warning)}'
    + '.main{display:flex;flex:1;overflow:hidden}'
    + '.panel-instances{width:290px;min-width:200px;flex-shrink:0;background:var(--bg-surface);'
    + 'border-right:1px solid var(--bdr);display:flex;flex-direction:column;overflow:hidden}'
    + '.panel-header{padding:10px 12px 8px;border-bottom:1px solid var(--bdr);font-size:10px;'
    + 'font-weight:600;text-transform:uppercase;letter-spacing:.5px;color:var(--text2);flex-shrink:0}'
    + '.instance-list{flex:1;overflow-y:auto;padding:8px;display:flex;flex-direction:column;gap:6px}'
    + '.instance-card{background:var(--bg-el);border:1px solid var(--bdr);border-radius:var(--r);'
    + 'padding:10px 12px;cursor:pointer;transition:border-color 120ms,background 120ms}'
    + '.instance-card:hover{background:var(--bg-hover)}'
    + '.instance-card.selected{border-color:var(--accent)}'
    + '.instance-card.selected.is-connected{border-color:var(--success);background:rgba(104,211,145,.06)}'
    + '.ic-head{display:flex;align-items:center;gap:8px;margin-bottom:6px}'
    + '.status-dot{width:8px;height:8px;border-radius:50%;flex-shrink:0}'
    + '.status-dot.connected{background:var(--success);box-shadow:0 0 5px var(--success)}'
    + '.status-dot.disconnected{background:var(--danger)}'
    + '.status-dot.reconnecting{background:var(--warning);animation:pulse 1s infinite}'
    + '.ic-id{font-size:11px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}'
    + '.ic-badges{display:flex;gap:4px;flex-wrap:wrap;margin-bottom:6px}'
    + '.badge{font-size:10px;padding:1px 6px;border-radius:10px;font-weight:500}'
    + '.badge.tools{background:var(--acc-dim);color:var(--accent)}'
    + '.badge.registered{background:var(--suc-dim);color:var(--success)}'
    + '.badge.reconnect{background:var(--war-dim);color:var(--warning);font-size:9px}'
    + '.ic-tools{font-size:10px;color:var(--textm);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:4px}'
    + '.ic-actions{display:flex;gap:4px;margin-top:7px}'
    + '.ic-actions .btn{flex:1;text-align:center;padding:3px 0;font-size:10px}'
    + '.empty-state{text-align:center;padding:48px 20px;color:var(--textm)}'
    + '.empty-state .icon{font-size:36px;margin-bottom:10px}'
    + '.empty-state p{font-size:12px;line-height:1.7}'
    + '.panel-right{flex:1;display:flex;flex-direction:column;overflow:hidden}'
    + '.log-toolbar{display:flex;align-items:center;gap:8px;padding:8px 12px;'
    + 'background:var(--bg-surface);border-bottom:1px solid var(--bdr);flex-shrink:0}'
    + '.log-toolbar label{font-size:10px;font-weight:600;text-transform:uppercase;'
    + 'letter-spacing:.5px;color:var(--text2);white-space:nowrap}'
    + '.filter-input{flex:1;max-width:300px;background:var(--bg-el);border:1px solid var(--bdr);'
    + 'border-radius:6px;color:var(--text1);font-size:11px;padding:4px 10px;outline:none}'
    + '.filter-input:focus{border-color:var(--accent)}'
    + '.filter-input::placeholder{color:var(--textm)}'
    + '.chk-label{display:flex;align-items:center;gap:5px;font-size:11px;color:var(--text2);cursor:pointer;white-space:nowrap}'
    + '.log-count{font-size:11px;color:var(--textm)}'
    + '.log-body{flex:1;overflow-y:auto;font-family:"Consolas","JetBrains Mono","Fira Code",monospace;font-size:11px}'
    + '.log-row{display:grid;grid-template-columns:88px 160px 132px 1fr 16px;gap:0 8px;padding:3px 12px;'
    + 'border-bottom:1px solid rgba(255,255,255,.02);align-items:baseline;transition:background 60ms;cursor:pointer}'
    + '.log-row:hover{background:var(--bg-el)}'
    + '.log-row.is-error{background:rgba(252,129,129,.04)}'
    + '.log-row.expanded{background:var(--bg-el);align-items:start}'
    + '.log-chevron{color:var(--textm);font-size:9px;line-height:1.8;user-select:none;text-align:center}'
    + '.log-expand{grid-column:1/-1;padding:8px 10px 10px;margin:2px 0 4px;background:var(--bg-hover);border-radius:4px;overflow-x:auto}'
    + '.log-expand pre{font-family:"Consolas","JetBrains Mono","Fira Code",monospace;font-size:11px;line-height:1.6;margin:0;white-space:pre-wrap;word-break:break-word;color:var(--text1)}'
    + '.jk{color:var(--accent)}.js{color:var(--info)}.jn{color:var(--warning)}.jb{color:var(--purple)}.jnull{color:var(--danger);font-style:italic}'
    + '.log-ts{color:var(--textm);font-size:10px}'
    + '.log-client{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text2);font-size:10px}'
    + '.ev-badge{display:inline-block;padding:1px 6px;border-radius:3px;font-size:10px;font-weight:600;letter-spacing:.3px}'
    + '.ev-purple{background:var(--pur-dim);color:var(--purple)}'
    + '.ev-accent{background:var(--acc-dim);color:var(--accent)}'
    + '.ev-success{background:var(--suc-dim);color:var(--success)}'
    + '.ev-info{background:var(--inf-dim);color:var(--info)}'
    + '.ev-warning{background:var(--war-dim);color:var(--warning)}'
    + '.ev-danger{background:var(--dan-dim);color:var(--danger)}'
    + '.ev-muted{background:rgba(255,255,255,.04);color:var(--text2)}'
    + '.ev-result-ok{background:var(--suc-dim);color:var(--success)}'
    + '.ev-result-err{background:var(--dan-dim);color:var(--danger)}'
    + '.log-detail{color:var(--text2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:10px}'
    + '.log-detail .hi{color:var(--text1)}.log-detail .ok{color:var(--success)}'
    + '.log-detail .err{color:var(--danger)}.log-detail .ms{color:var(--textm)}'
    + '.no-source{position:fixed;inset:0;background:var(--overlay);display:flex;'
    + 'align-items:center;justify-content:center;flex-direction:column;gap:14px;z-index:1000}'
    + '.no-source.hidden{display:none}'
    + '.no-source .ns-title{font-size:16px;font-weight:700}'
    + '.no-source .ns-sub{font-size:12px;color:var(--text2);text-align:center;max-width:420px;line-height:1.7}'
    + '.ns-spin{width:32px;height:32px;border:3px solid var(--bg-el);border-top-color:var(--accent);border-radius:50%}'
    + '::-webkit-scrollbar{width:6px;height:6px}'
    + '::-webkit-scrollbar-track{background:transparent}'
    + '::-webkit-scrollbar-thumb{background:var(--scrollbar);border-radius:3px}'
    + '::-webkit-scrollbar-thumb:hover{background:var(--scrollbar-hover)}'
    + ':focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:3px}'
    + '@keyframes pulse{0%,100%{opacity:1}50%{opacity:.35}}'
    + '@keyframes spin{to{transform:rotate(360deg)}}'
    + '</style><scri' + 'pt>(function(){var t=localStorage.getItem("broker-dash-theme");if(t)document.documentElement.setAttribute("data-theme",t)})()</scri' + 'pt></head><body>'
    + '<div class="no-source" id="no-source">'
    + '<div class="ns-spin" style="animation:spin .8s linear infinite"></div>'
    + '<div class="ns-title">Searching for telemetry source\u2026</div>'
    + '<div class="ns-sub">This window was opened from a PodBay-injected page. '
    + 'Waiting for window.opener.PodBayBrokerTelemetry to become available.</div></div>'
    + '<div class="top-bar">'
    + '<div class="brand">PodBay <span>Broker Telemetry</span></div>'
    + '<div class="stats">'
    + '<div class="stat-pill s-total"><span class="n" id="s-total">0</span> instances</div>'
    + '<div class="stat-pill s-connected"><span class="n" id="s-conn">0</span> connected</div>'
    + '<div class="stat-pill s-calls"><span class="n" id="s-calls">0</span> calls</div>'
    + '<div class="stat-pill s-errors"><span class="n" id="s-errors">0</span> errors</div>'
    + '</div><div class="spacer"></div>'
    + '<div class="src-badge"><div class="src-dot" id="src-dot"></div><span id="src-label">no source</span></div>'
    + '<button class="btn" id="btn-theme" aria-label="Toggle theme">\u2600 Theme</button>'
    + '<button class="btn active" id="btn-pause">Pause</button>'
    + '<button class="btn danger" id="btn-clear">Clear History</button>'
    + '</div>'
    + '<div class="main">'
    + '<div class="panel-instances"><div class="panel-header">Instances</div>'
    + '<div class="instance-list" id="inst-list"></div></div>'
    + '<div class="panel-right"><div class="log-toolbar"><label>Event Log</label>'
    + '<input class="filter-input" id="log-filter" placeholder="Filter by clientId, event, or detail\u2026" aria-label="Filter events">'
    + '<label class="chk-label"><input type="checkbox" id="chk-auto" checked> Auto-scroll</label>'
    + '<div class="spacer"></div><span class="log-count" id="log-count" aria-live="polite" aria-atomic="true">0 events</span></div>'
    + '<div class="log-body" id="log-body"></div></div></div>'
    + '<script>;(function(){"use strict";'
    + 'var eBT=document.getElementById("btn-theme");'
    + '(function(){var t=localStorage.getItem("broker-dash-theme")||"dark";document.documentElement.setAttribute("data-theme",t);eBT.textContent=t==="light"?"\uD83C\uDF19 Theme":"\u2600 Theme"})();'
    + 'eBT.addEventListener("click",function(){var c=document.documentElement.getAttribute("data-theme");var n=c==="dark"?"light":"dark";document.documentElement.setAttribute("data-theme",n);localStorage.setItem("broker-dash-theme",n);eBT.textContent=n==="light"?"\uD83C\uDF19 Theme":"\u2600 Theme"});'
    + 'function getS(){try{if(window.PodBayBrokerTelemetry)return window.PodBayBrokerTelemetry}catch(e){}'
    + 'try{if(window.opener&&window.opener.PodBayBrokerTelemetry)return window.opener.PodBayBrokerTelemetry}catch(e){}'
    + 'return null}'
    + 'var EV={constructed:{cls:"ev-purple",label:"constructed"},reused:{cls:"ev-accent",label:"reused"},'
    + 'connected:{cls:"ev-success",label:"connected"},registered:{cls:"ev-info",label:"registered"},'
    + 'server_ack:{cls:"ev-success",label:"server_ack"},tool_upserted:{cls:"ev-accent",label:"tool_upserted"},'
    + 'tool_called:{cls:"ev-warning",label:"tool_called"},tool_result:{cls:"ev-result-ok",label:"tool_result"},'
    + 'disconnected:{cls:"ev-danger",label:"disconnected"},reconnect_scheduled:{cls:"ev-muted",label:"reconnect_sched"}};'
    + 'function em(ev,d){var b=EV[ev]||{cls:"ev-muted",label:ev};var m={cls:b.cls,label:b.label};'
    + 'if(ev==="tool_result"&&d&&d.isError)m.cls="ev-result-err";'
    + 'if(ev==="disconnected"&&d&&!d.reconnecting)m.cls="ev-danger";'
    + 'if(ev==="disconnected"&&d&&d.reconnecting)m.cls="ev-warning";return m}'
    + 'function esc(s){return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")}'
    + 'function pj(v,i){i=i||0;var p=new Array(i+1).join("  "),p1=new Array(i+2).join("  ");'
    + 'if(v===null)return"<span class=\\"jnull\\">null</span>";'
    + 'if(typeof v==="boolean")return"<span class=\\"jb\\">"+v+"</span>";'
    + 'if(typeof v==="number")return"<span class=\\"jn\\">"+v+"</span>";'
    + 'if(typeof v==="string")return"<span class=\\"js\\">\\\""+esc(v)+"\\\"</span>";'
    + 'if(Array.isArray(v)){if(!v.length)return"[]";return"[\\n"+v.map(function(x){return p1+pj(x,i+1)}).join(",\\n")+"\\n"+p+"]"}'
    + 'if(typeof v==="object"){var ks=Object.keys(v);if(!ks.length)return"{}";return"{\\n"+ks.map(function(k){return p1+"<span class=\\"jk\\">\\\""+esc(k)+"\\\"</span>: "+pj(v[k],i+1)}).join(",\\n")+"\\n"+p+"}"}'
    + 'return esc(String(v))}'
    + 'function fd(ev,d){if(!d)return"";switch(ev){'
    + 'case"constructed":return"<span class=\\"hi\\">"+(d.tools&&d.tools.length?esc(d.tools.join(", ")):"no tools")+"</span>";'
    + 'case"reused":return"upserted: <span class=\\"hi\\">"+esc((d.upserted||[]).join(", ")||"none")+"</span>";'
    + 'case"registered":return"<span class=\\"hi\\">"+d.toolCount+"</span> tools";'
    + 'case"tool_upserted":return"<span class=\\"hi\\">"+esc(d.name||"")+"</span> "+(d.replaced?"<span class=\\"ok\\">replaced</span>":"<span class=\\"hi\\">added</span>");'
    + 'case"tool_called":return"tool: <span class=\\"hi\\">"+esc(d.tool||"")+"</span>";'
    + 'case"tool_result":{var dur=d.durationMs!=null?" <span class=\\"ms\\">("+d.durationMs+"ms)</span>":"";return"tool: <span class=\\"hi\\">"+esc(d.tool||"")+"</span>"+(d.isError?" <span class=\\"err\\">error</span>":" <span class=\\"ok\\">ok</span>")+dur}'
    + 'case"disconnected":return d.reconnecting?"<span class=\\"ok\\">will reconnect</span>":"<span class=\\"err\\">permanently disconnected</span>";'
    + 'case"reconnect_scheduled":return"delay: <span class=\\"hi\\">"+(d.delayMs||0)+"ms</span>";'
    + 'default:{var ks=Object.keys(d).slice(0,3);return ks.map(function(k){return"<span class=\\"ms\\">"+esc(k)+":</span> <span class=\\"hi\\">"+esc(JSON.stringify(d[k]))+"</span>"}).join(" ")}}'
    + '}'
    + 'function ft(ts){var d=new Date(ts);function p(n){return n<10?"0"+n:""+n}function p3(n){return n<10?"00"+n:n<100?"0"+n:""+n}'
    + 'return p(d.getHours())+":"+p(d.getMinutes())+":"+p(d.getSeconds())+"."+p3(d.getMilliseconds())}'
    + 'var sel=null,paused=false,_is="",_ll=-1,_lf="",_ls=null,_ek={};'
    + 'var eNS=document.getElementById("no-source"),eDot=document.getElementById("src-dot"),eLbl=document.getElementById("src-label");'
    + 'var eIL=document.getElementById("inst-list"),eLB=document.getElementById("log-body");'
    + 'var eFil=document.getElementById("log-filter"),eCA=document.getElementById("chk-auto");'
    + 'var eBP=document.getElementById("btn-pause"),eBCl=document.getElementById("btn-clear");'
    + 'var eST=document.getElementById("s-total"),eSC=document.getElementById("s-conn");'
    + 'var eSCl=document.getElementById("s-calls"),eSE=document.getElementById("s-errors"),eLCnt=document.getElementById("log-count");'
    + 'eBP.addEventListener("click",function(){paused=!paused;eBP.textContent=paused?"Resume":"Pause";eBP.classList.toggle("active",paused)});'
    + 'var sav=localStorage.getItem("broker-dash-autoscroll");if(sav!==null)eCA.checked=sav==="1";'
    + 'eCA.addEventListener("change",function(){localStorage.setItem("broker-dash-autoscroll",eCA.checked?"1":"0")});'
    + 'eBCl.addEventListener("click",function(){if(!confirm("Clear all event history? This cannot be undone."))return;var s=getS();if(s&&s.clearHistory){s.clearHistory();_ll=-1}});'
    + 'eFil.addEventListener("input",function(){_lf="";rLog(getS())});'
    + 'function render(){if(paused)return;var s=getS();'
    + 'if(!s){eNS.classList.remove("hidden");eDot.className="src-dot missing";eLbl.textContent="no telemetry source";return}'
    + 'eNS.classList.add("hidden");eDot.className="src-dot ok";'
    + 'var ids=Object.keys(s.instances);eLbl.textContent=ids.length+" instance"+(ids.length!==1?"s":"")+" live";'
    + 'rStats(s);rInst(s);rLog(s)}'
    + 'function rStats(s){var ids=Object.keys(s.instances),cn=0,cl=0,er=0;'
    + 'ids.forEach(function(id){if(s.instances[id].connected)cn++});'
    + 's.history.forEach(function(e){if(e.event==="tool_called")cl++;if(e.event==="tool_result"&&e.detail&&e.detail.isError)er++});'
    + 'eST.textContent=ids.length;eSC.textContent=cn;eSCl.textContent=cl;eSE.textContent=er}'
    + 'function rInst(s){var insts=s.instances,ids=Object.keys(insts);'
    + 'var sig=sel+"|"+ids.map(function(id){var c=insts[id];return id+(c.connected?"C":"D")+(c.registered?"R":"")+c.tools.length}).join("|");'
    + 'if(_is===sig)return;_is=sig;'
    + 'if(!ids.length){eIL.innerHTML="<div class=\\"empty-state\\"><div class=\\"icon\\">📡</div><p>No broker clients constructed yet.</p></div>";return}'
    + 'eIL.innerHTML=ids.map(function(id){var c=insts[id];'
    + 'var dc=c.connected?"connected":(c.reconnectDelay>3000?"reconnecting":"disconnected");'
    + 'var cc=c.connected?" is-connected":"",sc=(sel===id?" selected":"");'
    + 'var rb=c.registered?"<span class=\\"badge registered\\">registered</span>":"";'
    + 'var rcb=(!c.connected&&c.reconnectDelay>3000)?"<span class=\\"badge reconnect\\">reconnecting\u2026</span>":"";'
    + 'var ab=c.connected?"<button class=\\"btn danger ic-btn\\" data-a=\\"disconnect\\" data-id=\\""+esc(id)+"\\">Disconnect</button>"'
    + ':"<button class=\\"btn ic-btn\\" data-a=\\"reconnect\\" data-id=\\""+esc(id)+"\\">Reconnect</button>";'
    + 'var tl=c.tools.length?"<div class=\\"ic-tools\\">"+esc(c.tools.join(", "))+"</div>":"";'
    + 'return"<div class=\\"instance-card"+sc+cc+"\\" data-id=\\""+esc(id)+"\\">"'
    + '+"<div class=\\"ic-head\\"><div class=\\"status-dot "+dc+"\\"></div>"'
    + '+"<div class=\\"ic-id\\" title=\\""+esc(id)+"\\">"+esc(id)+"</div></div>"'
    + '+"<div class=\\"ic-badges\\"><span class=\\"badge tools\\">"+c.tools.length+" tools</span>"+rb+rcb+"</div>"'
    + '+tl+"<div class=\\"ic-actions\\">"+ab+"</div></div>"}).join("");'
    + 'eIL.querySelectorAll(".instance-card").forEach(function(card){'
    + 'card.addEventListener("click",function(e){if(e.target.classList.contains("ic-btn"))return;'
    + 'sel=(card.dataset.id===sel)?null:card.dataset.id;_is="";_ls=null;render()})});'
    + 'eIL.querySelectorAll(".ic-btn").forEach(function(btn){'
    + 'btn.addEventListener("click",function(e){e.stopPropagation();var s2=getS();if(!s2)return;'
    + 'if(btn.dataset.a==="disconnect"&&s2.disconnect)s2.disconnect(btn.dataset.id);'
    + 'if(btn.dataset.a==="reconnect"&&s2.reconnect)s2.reconnect(btn.dataset.id)})})}'
    + 'function rLog(s){if(!s)return;var f=eFil.value.toLowerCase(),h=s.history;'
    + 'var d=h.length!==_ll||f!==_lf||sel!==_ls;if(!d)return;_ll=h.length;_lf=f;_ls=sel;'
    + 'var rows=h.filter(function(e){'
    + 'if(sel&&e.clientId!==sel)return false;if(!f)return true;'
    + 'var ds=JSON.stringify(e.detail||"").toLowerCase();'
    + 'return e.clientId.toLowerCase().includes(f)||e.event.toLowerCase().includes(f)||ds.includes(f)});'
    + 'eLCnt.textContent=rows.length+(rows.length!==h.length?"/"+h.length:"")+" events";'
    + 'var atBot=eLB.scrollHeight-eLB.scrollTop<=eLB.clientHeight+40;'
    + 'eLB.innerHTML=rows.map(function(e){var m=em(e.event,e.detail);var ie=(e.event==="tool_result"&&e.detail&&e.detail.isError);'
    + 'var k=e.ts+"|"+e.clientId+"|"+e.event;var isX=!!_ek[k];var hd=!!e.detail;'
    + 'var xb=isX&&hd?"<div class=\\"log-expand\\"><pre>"+pj(e.detail)+"</pre></div>":"";'
    + 'return"<div class=\\"log-row"+(ie?" is-error":"")+(isX?" expanded":"")+"\\" data-k=\\""+esc(k)+"\\">"'
    + '+"<div class=\\"log-ts\\">"+ft(e.ts)+"</div>"'
    + '+"<div class=\\"log-client\\" title=\\""+esc(e.clientId)+"\\">"+esc(e.clientId)+"</div>"'
    + '+"<div><span class=\\"ev-badge "+m.cls+"\\">"+m.label+"</span></div>"'
    + '+"<div class=\\"log-detail\\">"+fd(e.event,e.detail)+"</div>"'
    + '+"<div class=\\"log-chevron\\">"+(hd?isX?"&#9660;":"&#9654;":"")+"</div>"'
    + '+xb+"</div>"}).join("");'
    + 'eLB.querySelectorAll(".log-row[data-k]").forEach(function(r){r.addEventListener("click",function(){var k=r.dataset.k;if(_ek[k])delete _ek[k];else _ek[k]=1;_ll=-1;rLog(getS())})});'
    + 'if(eCA.checked&&(atBot||_ll<=10))eLB.scrollTop=eLB.scrollHeight}'
    + 'setInterval(render,500);render()})()'
    + '<\/script></body></html>';

  // ── Open / focus the dashboard popup ────────────────────────────────
  var _win = null;

  function openDashboard() {
    if (_win && !_win.closed) {
      _win.focus();
      console.log(TAG, 'Dashboard already open — focused');
      return { opened: false, refocused: true };
    }
    _win = window.open('', POPUP_NAME, WIN_OPTS);
    if (!_win) {
      console.warn(TAG, 'Popup blocked — allow popups for this page');
      return { opened: false, error: 'popup blocked' };
    }
    _win.document.open();
    _win.document.write(DASHBOARD_HTML);
    _win.document.close();
    console.log(TAG, 'Broker telemetry dashboard opened');
    return { opened: true };
  }

  // ── Register MCP tool ────────────────────────────────────────────────
  var clientId = (window.PodBayIdentity && window.PodBayIdentity.clientId) || 'broker-dashboard';
  var _bridge = window.PodBayBridge ? window.PodBayBridge(clientId) : null;

  if (_bridge) {
    _bridge.addTool(
      'open_broker_dashboard',
      function () { return openDashboard(); },
      'Open the PodBay Broker Telemetry dashboard — shows all BrokerClient instances, connection status, tool registry, and live event history',
      {}
    );
    // Connect bridge if not already connected
    if (!_bridge.client) _bridge.connect();
    console.log(TAG, 'Registered open_broker_dashboard tool on', clientId);
  } else {
    console.warn(TAG, 'PodBayBridge not available — MCP tool not registered. openDashboard() still works directly.');
  }

  // ── Keyboard shortcut: Alt+B ────────────────────────────────────────
  document.addEventListener('keydown', function (e) {
    if (e.altKey && (e.key === 'b' || e.key === 'B')) {
      e.preventDefault();
      openDashboard();
    }
  });

  // ── Expose globally for direct eval access ───────────────────────────
  window.__podBayBrokerDashboard = { open: openDashboard };

})();
