/* =====================================================================
   КОД АНТВЕРПЕНА — движок
   Один файл на все роли: ТВ-экран, телефон-пульт, соло-режим.
   Синхронизация: MQTT (публичные брокеры) + BroadcastChannel (вкладки).
   ===================================================================== */
'use strict';

/* ---------------- утилиты ---------------- */
const $ = (sel, root) => (root || document).querySelector(sel);
const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const ROOM_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const genRoom = () => Array.from({length:5}, () => ROOM_CHARS[Math.floor(Math.random()*ROOM_CHARS.length)]).join('');
const hashStr = s => { let h = 1779033703; for (let i=0;i<s.length;i++){ h = Math.imul(h ^ s.charCodeAt(i), 3432918353); h = h<<13 | h>>>19; } return h>>>0; };
const mulberry32 = a => () => { a|=0; a = a+0x6D2B79F5|0; let t = Math.imul(a ^ a>>>15, 1|a); t = t + Math.imul(t ^ t>>>7, 61|t) ^ t; return ((t ^ t>>>14)>>>0)/4294967296; };
const shuffledBy = (arr, seed) => { const r = mulberry32(seed); const a = arr.slice(); for (let i=a.length-1;i>0;i--){ const j = Math.floor(r()*(i+1)); const tmp=a[i]; a[i]=a[j]; a[j]=tmp; } return a; };
const fmtTime = ms => { const s = Math.max(0, Math.floor(ms/1000)); return String(Math.floor(s/60)).padStart(2,'0') + ':' + String(s%60).padStart(2,'0'); };

const params = new URLSearchParams(location.search);
const MODE = params.get('mode') || null;            // 'tv' | 'phone' | 'solo'
let ROOM = (params.get('room') || '').toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,5);

/* ---------------- состояние ---------------- */
const freshState = () => ({
  v: 1, ts: Date.now(),
  startedAt: null,
  act: 0,
  step: 'intro',            // intro|brief|leads|lead:<id>|quiz:<i>|outro|finale|result|epi:<i>|done
  opened: {},
  answers: {},
  hints: {},
  score: 0,
  bet: null, chosenVer: null, resolved: false,
  routeShown: false,
  epiIdx: 0
});
let S = null;
let role = null;

function commit(next){
  next.v = (S ? S.v : 0) + 1;
  next.ts = Date.now();
  S = next;
  Sync.publish();
  renderAll();
}

const Actions = {
  start(){ if (S && S.step === 'intro') commit(Object.assign({}, S, {startedAt: Date.now(), step:'brief', act:0})); },
  goto(step){ if (S) commit(Object.assign({}, S, {step})); },
  openLead(leadId){
    if (!S) return;
    const act = CASE.acts[S.act];
    const lead = act.leads.find(l => l.id === leadId); if (!lead) return;
    const opened = Object.assign({}, S.opened); opened[leadId] = true;
    commit(Object.assign({}, S, {opened, step:'lead:'+leadId, routeShown: S.routeShown || lead.id === 'l-route'}));
  },
  backToLeads(){ Actions.goto('leads'); },
  useHint(qid){
    const lvl = Math.min(3, (S.hints[qid] || 0) + 1);
    const hints = Object.assign({}, S.hints); hints[qid] = lvl;
    commit(Object.assign({}, S, {hints}));
  },
  submit(qid, picked){
    if (S.answers[qid]) return;
    const g = gradeQuestion(qid, picked, S.hints[qid] || 0);
    const rec = Object.assign({hints: S.hints[qid]||0, pts: g.pts, ok: g.ok}, picked);
    const answers = Object.assign({}, S.answers); answers[qid] = rec;
    commit(Object.assign({}, S, {answers, score: S.score + g.pts}));
  },
  nextQuiz(){
    const act = CASE.acts[S.act];
    const idx = quizIndexFromStep();
    if (idx < act.quiz.length - 1) Actions.goto('quiz:'+(idx+1));
    else Actions.goto('outro');
  },
  nextAct(){
    if (S.act < CASE.acts.length - 1) commit(Object.assign({}, S, {act: S.act+1, step:'brief'}));
    else Actions.goto('finale');
  },
  setVer(i){ if (S && !S.resolved) commit(Object.assign({}, S, {chosenVer:i})); },
  setBet(n){ if (S && !S.resolved) commit(Object.assign({}, S, {bet:n})); },
  resolveBet(){
    if (!S || S.resolved || S.chosenVer == null || S.bet == null) return;
    const win = S.chosenVer === CASE.finale.correctIdx;
    const delta = win ? S.bet*2 : -S.bet;
    commit(Object.assign({}, S, {resolved:true, score: Math.max(0, S.score + delta), step:'result'}));
  },
  nextEpi(){
    const i = parseInt(String(S.step).split(':')[1],10) || 0;
    if (i < CASE.epilogue.length - 1) Actions.goto('epi:'+(i+1));
    else Actions.goto('done');
  },
  restart(){
    if (UI.resetPicks) UI.resetPicks();
    commit(freshState());
  }
};

function quizIndexFromStep(){ return parseInt(String(S.step).split(':')[1],10) || 0; }

function gradeQuestion(qid, picked, hintLvl){
  let q = null;
  for (const a of CASE.acts) { const f = a.quiz.find(x=>x.id===qid); if (f) q = f; }
  if (!q) return {pts:0, ok:false};
  const factor = [1, 0.6, 0.3, 0][Math.min(3, hintLvl)];
  let c = 0;
  if (q.kind === 'single'){
    c = picked.i === q.correct ? 1 : 0;
  } else if (q.kind === 'multi'){
    const p = picked.set || [];
    let good = 0, bad = 0;
    p.forEach(i => { if (q.correct.indexOf(i) >= 0) good++; else bad++; });
    c = Math.max(0, good - bad*0.5) / q.correct.length;
  } else if (q.kind === 'order'){
    const arr = picked.order || [];
    let good = 0;
    q.order.forEach(function(_, k){ if (arr[k] === k) good++; });
    c = good / q.order.length;
  } else if (q.kind === 'match'){
    const sel = picked.pairs || {};
    let good = 0;
    q.pairs.forEach(function(_, k){ if (sel[k] === k) good++; });
    c = good / q.pairs.length;
  }
  return {pts: Math.round((q.pts || 10) * factor * c), ok: c >= 0.999};
}

function findLead(lid){
  for (const a of CASE.acts) { const l = a.leads.find(x=>x.id===lid); if (l) return l; }
  return null;
}

/* точки, доступные игроку сейчас: часть улик открывается только после
   осмотра других (l.req = id точки-условия) — цепочки следов */
function visibleLeads(act){
  return act.leads.filter(function(l){ return !l.req || !!S.opened[l.req]; });
}
function hiddenLeadsLeft(act){
  return act.leads.length - visibleLeads(act).length;
}

/* ---------------- синхронизация ---------------- */
const Sync = (() => {
  const BROKERS = ['wss://broker.emqx.io:8084/mqtt','wss://broker.hivemq.com:8884/mqtt','wss://mqtt.eclipseprojects.io:443/mqtt','wss://test.mosquitto.org:8081/mqtt'];
  let client = null, topic = '', hiTopic = '', bc = null;
  let connected = false, brokerName = 'локально', attempt = 0;
  let lastHello = 0; /* когда пульт последний раз «окликнул» (для индикатора на ТВ) */

  function setNet(){
    const cls = connected ? 'ok' : 'wait';
    const txt = connected ? ('синхронизация: ' + brokerName + ' · комната ' + ROOM) : 'синхронизация: подключение…';
    const el = $('#tv-net'); if (el) { el.className = 'tv-net ' + cls; el.title = txt; }
    const ph = $('#ph-net'); if (ph) { ph.className = 'ph-net ' + cls; ph.title = txt; }
    const roomEl = $('#tv-room'); if (roomEl) roomEl.textContent = 'КОМНАТА ' + ROOM;
    const phRoom = $('#ph-room'); if (phRoom) phRoom.textContent = ROOM;
  }

  function adopt(msg){
    if (!msg || typeof msg.v !== 'number') return;
    if (!S || msg.v > S.v || (msg.v === S.v && msg.ts > S.ts)) { S = msg; renderAll(); }
    else if (S && msg.v < S.v) publishNow();
  }

  function onMsg(txt){
    let msg = null;
    try { msg = JSON.parse(txt); } catch(e){ return; }
    if (msg && msg.t === 'hi'){ lastHello = Date.now(); return; } /* приветствие пульта, не состояние */
    adopt(msg);
  }

  function tryBroker(i){
    const my = ++attempt;
    if (i >= BROKERS.length){ setNet(); return; }
    try {
      client = mqtt.connect(BROKERS[i], {clientId:'koda-'+genRoom()+Math.floor(Math.random()*999), keepalive:30, reconnectPeriod:0, connectTimeout:6000, clean:true});
      client.on('connect', function(){
        if (my !== attempt) { try { client.end(true); } catch(e){} return; }
        connected = true;
        brokerName = 'MQTT';
        setNet();
        client.subscribe(topic, {qos:1});
        if (hiTopic) client.subscribe(hiTopic, {qos:0});
        publishNow();
      });
      client.on('message', function(_t, payload){ if (my === attempt) onMsg(payload.toString()); });
      client.on('error', function(){ /* wait for close/timeout */ });
      client.on('close', function(){
        if (my !== attempt) return;
        if (connected){ connected = false; setNet(); setTimeout(function(){ tryBroker(0); }, 3000); }
      });
      setTimeout(function(){
        if (my === attempt && !connected){ try { client.end(true); } catch(e){} tryBroker(i+1); }
      }, 5000);
    } catch(e){ tryBroker(i+1); }
  }

  function connect(){
    if (bc) try { bc.close(); } catch(e){}
    try {
      bc = new BroadcastChannel('koda-' + ROOM);
      bc.onmessage = function(ev){ onMsg(JSON.stringify(ev.data)); };
    } catch(e){ bc = null; } /* старые Tizen без BroadcastChannel — работаем только через MQTT */
    topic = 'koda-v1-' + ROOM;
    hiTopic = 'koda-hi-' + ROOM;
    tryBroker(0);
    setInterval(publishHello, 3000);
  }

  /* телефон каждые 3 с «окликается», ТВ видит: пульт подключён */
  function publishHello(){
    if (!connected || role !== 'phone') return;
    try { client.publish(hiTopic, JSON.stringify({t:'hi', role:'phone', ts:Date.now()}), {qos:0}); } catch(e){}
  }

  function publishNow(){
    if (!S) return;
    const txt = JSON.stringify(S);
    if (bc) { try { bc.postMessage(S); } catch(e){} }
    if (client && connected) { try { client.publish(topic, txt, {qos:1, retain:true}); } catch(e){} }
  }

  let debounceT = null;
  function publish(){ clearTimeout(debounceT); debounceT = setTimeout(publishNow, 120); }

  return {connect, publish, setNet, isMqtt: function(){ return connected; },
    broker: function(){ return brokerName; },
    helloAge: function(){ return lastHello ? (Date.now() - lastHello) : Infinity; }};
})();

/* ---------------- карты (Leaflet) ---------------- */
const Maps = (() => {
  let tvMap = null, tvMarkers = {}, tvRoute = null;
  let phMap = null, phMarkers = {}, phRoute = null;

  function markerIcon(opened){
    const cls = 'mk' + (opened ? ' mk-open' : '');
    return L.divIcon({className:'mk-wrap', html:'<div class="'+cls+'"></div>', iconSize:[18,18], iconAnchor:[9,9]});
  }

  function locHasOpened(locId){
    return Object.keys(S.opened).some(function(lid){ const l = findLead(lid); return l && l.loc === locId; });
  }

  const ESRI_DARK = 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}';
  const ESRI_REF  = 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}';

  function darkLayers(map){
    L.tileLayer(ESRI_DARK, {maxZoom:17, attribution:'Esri, HERE, Garmin'}).addTo(map);
    L.tileLayer(ESRI_REF, {maxZoom:17}).addTo(map);
  }

  function buildTV(el){
    tvMap = L.map(el, {zoomControl:false});
    darkLayers(tvMap);
    tvMap.setView(CASE.map.center, CASE.map.zoom);
    Object.keys(CASE.map.locations).forEach(function(id){
      const loc = CASE.map.locations[id];
      const m = L.marker([loc.lat, loc.lng], {icon: markerIcon(false)}).addTo(tvMap);
      m.bindTooltip('<b>'+esc(loc.name)+'</b>', {direction:'top', offset:[0,-10], className:'tv-tip'});
      m.on('click', function(){
        const cap = $('#tv-map-caption');
        if (cap){ cap.innerHTML = '<h4>'+esc(loc.name)+'</h4><p>'+esc(loc.note)+'</p>'; cap.classList.remove('hidden'); }
        if (S){
          const act = CASE.acts[S.act];
          const leads = visibleLeads(act).filter(function(l){ return l.loc === id; });
          const target = leads.find(function(l){ return !S.opened[l.id]; }) || leads[0];
          if (target && role !== 'tv') Actions.openLead(target.id);
        }
      });
      tvMarkers[id] = m;
    });
  }

  function hideCaption(){ const c = $('#tv-map-caption'); if (c) c.classList.add('hidden'); }

  function updateTV(){
    if (!tvMap || !S) return;
    Object.keys(CASE.map.locations).forEach(function(id){
      const m = tvMarkers[id]; if (!m) return;
      m.setIcon(markerIcon(locHasOpened(id)));
    });
    if (S.routeShown && !tvRoute){
      tvRoute = L.polyline(CASE.map.route.points, {color:'#d9a441', weight:3, dashArray:'8 8', opacity:.85}).addTo(tvMap);
      tvRoute.bindTooltip(CASE.map.route.name);
    }
  }

  function flyTV(locId){
    if (!tvMap || !S) return;
    const loc = CASE.map.locations[locId]; if (!loc) return;
    if (!tvMap._container || !tvMap._container.offsetWidth) return;
    const z = locId === 'turin' ? 5 : (locId === 'vancamp' ? 12 : 16);
    try { tvMap.flyTo([loc.lat, loc.lng], z, {duration:1.2}); } catch(e){}
  }

  function buildPhone(el){
    phMap = L.map(el, {});
    darkLayers(phMap);
    phMap.setView(CASE.map.center, 14);
    Object.keys(CASE.map.locations).forEach(function(id){
      const loc = CASE.map.locations[id];
      const m = L.marker([loc.lat, loc.lng], {icon: markerIcon(false)}).addTo(phMap);
      m.bindPopup('<b>'+esc(loc.name)+'</b><br><span style="font-size:12px">'+esc(loc.note)+'</span>');
      m.on('click', function(){
        if (!S) return;
        const act = CASE.acts[S.act];
        const leads = visibleLeads(act).filter(function(l){ return l.loc === id; });
        const target = leads.find(function(l){ return !S.opened[l.id]; }) || leads[0];
        if (target){ Actions.openLead(target.id); UI.phoneTab('flow'); }
      });
      phMarkers[id] = m;
    });
    updatePhone();
  }

  function updatePhone(){
    if (!phMap || !S) return;
    Object.keys(CASE.map.locations).forEach(function(id){
      const m = phMarkers[id]; if (!m) return;
      m.setIcon(markerIcon(locHasOpened(id)));
    });
    if (S.routeShown && !phRoute){
      phRoute = L.polyline(CASE.map.route.points, {color:'#d9a441', weight:3, dashArray:'8 8', opacity:.85}).addTo(phMap);
    }
  }

  return {
    buildTV, updateTV, flyTV, hideCaption, buildPhone, updatePhone,
    tvInvalidate: function(){ if (tvMap) setTimeout(function(){ tvMap.invalidateSize(); }, 50); },
    phInvalidate: function(){ if (phMap) setTimeout(function(){ phMap.invalidateSize(); }, 50); },
    phReady: function(){ return !!phMap; }
  };
})();

/* ---------------- ТВ-рендер ---------------- */
const TV = (() => {

  function stepParts(){
    const act = CASE.acts[S.act] || CASE.acts[0];
    const t = String(S.step);
    if (t === 'intro') return {view:'intro'};
    if (t === 'brief') return {view:'brief', act};
    if (t === 'leads') return {view:'leads', act};
    if (t.indexOf('lead:') === 0) return {view:'lead', act, leadId:t.slice(5)};
    if (t.indexOf('quiz:') === 0) return {view:'quiz', act, qi:parseInt(t.split(':')[1],10)||0};
    if (t === 'outro') return {view:'outro', act};
    if (t === 'finale') return {view:'finale'};
    if (t === 'result') return {view:'result'};
    if (t.indexOf('epi:') === 0) return {view:'epi', ei:parseInt(t.split(':')[1],10)||0};
    if (t === 'done') return {view:'done'};
    return {view:'intro'};
  }

  function render(stage){
    const layer = $('#tv-map-layer');
    const viewEl = $('#tv-view');
    if (viewEl) viewEl.classList.toggle('passthrough', false);
    if (!S){
      if (role === 'tv' || role === 'solo'){ renderJoin($('#tv-view')); }
      else if ($('#tv-view')) $('#tv-view').innerHTML = '';
      return;
    }
    const p = stepParts();
    const showMap = (p.view === 'leads');
    if (layer) layer.style.display = showMap ? 'block' : 'none';
    if (showMap){
      Maps.updateTV(); Maps.tvInvalidate(); Maps.hideCaption();
      if (viewEl) viewEl.classList.toggle('passthrough', true);
      renderLeads($('#tv-view'), p.act);
    }
    else if (p.view === 'intro') renderIntroCard($('#tv-view'));
    else if (p.view === 'brief') renderDoc($('#tv-view'), 'БРИФИНГ АКТА '+(S.act+1)+' ИЗ '+CASE.acts.length, p.act.brief);
    else if (p.view === 'lead'){
      const lead = findLead(p.leadId);
      const ev = lead && CASE.evidence[lead.ev];
      if (lead && ev){
        if (lead.loc) Maps.flyTV(lead.loc);
        renderEvidence($('#tv-view'), ev, lead);
      } else $('#tv-view').innerHTML = '';
    }
    else if (p.view === 'quiz') renderQuiz($('#tv-view'), p.act.quiz[p.qi], p.qi, p.act);
    else if (p.view === 'outro') renderCard($('#tv-view'), 'АКТ '+(S.act+1)+' ЗАВЕРШЁН', p.act.outro, 'дальше — на телефоне');
    else if (p.view === 'finale') renderFinale($('#tv-view'));
    else if (p.view === 'result') renderResult($('#tv-view'));
    else if (p.view === 'epi') renderEpi($('#tv-view'), CASE.epilogue[p.ei], p.ei);
    else if (p.view === 'done') renderDone($('#tv-view'));
    else renderIntroCard($('#tv-view'));
  }

  function renderJoin(stage){
    const url = location.origin + location.pathname + '?mode=phone&room=' + ROOM;
    stage.innerHTML =
      '<div class="join-wrap">' +
        '<div class="stamp">'+esc(CASE.meta.caseNo)+'</div>' +
        '<h1 class="join-title">КОД АНТВЕРПЕНА</h1>' +
        '<div class="join-sub">'+esc(CASE.meta.tagline)+'</div>' +
        '<div class="join-grid">' +
          '<div><div class="tag" style="margin-bottom:8px">КОД КОМНАТЫ</div>' +
          '<div class="join-code">'+esc(ROOM)+'</div>' +
          '<div class="join-hint">управление — один телефон · игроки — все вместе</div>' +
          '<div class="sync-line" id="tv-sync">проверка связи…</div></div>' +
          '<div class="join-qr" id="join-qr"></div>' +
        '</div>' +
        '<div class="join-wait"><span class="pulse"></span>отсканируйте QR телефоном — и начинайте</div>' +
      '</div>';
    try { new QRCode($('#join-qr'), {text:url, width:190, height:190, colorDark:'#191204', colorLight:'#efe6d4'}); } catch(e){}
    updateSyncLine();
  }

  function renderIntroCard(stage){
    const url = location.origin + location.pathname + '?mode=phone&room=' + ROOM;
    stage.innerHTML =
      '<div class="actcard">' +
        '<div class="stamp">'+esc(CASE.meta.caseNo)+'</div>' +
        '<h2>Ограбление века</h2>' +
        '<div class="act-sub">АНТВЕРПЕН · 15–17 ФЕВРАЛЯ 2003</div>' +
        '<div class="act-desc">Более $100 млн из хранилища с десятью слоями защиты. Ни одной тревоги. Ни одного свидетеля.<br>Вы — группа по алмазам. Улики, карта и версия — у вас в руках.</div>' +
        '<div class="act-meta">игра 2–3 часа · вводная и управление — на телефоне</div>' +
        '<div class="join-grid" style="margin-top:10px">' +
          '<div><div class="tag" style="margin-bottom:6px">КОД КОМНАТЫ</div>' +
          '<div class="join-code" style="font-size:44px">'+esc(ROOM)+'</div>' +
          '<div class="join-hint">подключите телефон-пульт</div>' +
          '<div class="sync-line" id="tv-sync">проверка связи…</div></div>' +
          '<div class="join-qr" id="join-qr"></div>' +
        '</div>' +
      '</div>';
    try { new QRCode($('#join-qr'), {text:url, width:150, height:150, colorDark:'#191204', colorLight:'#efe6d4'}); } catch(e){}
    updateSyncLine();
  }

  function renderDoc(stage, tag, doc){
    stage.innerHTML = '<div class="doc-tv"><h3>'+esc(tag)+'</h3><h2>'+esc(doc.title)+'</h2>'+doc.html+'</div>';
  }

  function renderLeads(stage, act){
    const leads = visibleLeads(act);
    const items = leads.map(function(l,i){
      const open = !!S.opened[l.id];
      return '<div class="lead-card '+(open?'open':'')+'"><div class="num">'+String(i+1).padStart(2,'0')+'</div>' +
        '<div><div class="t">'+esc(l.name)+'</div><div class="s">'+esc(l.sub)+'</div></div>' +
        '<div style="margin-left:auto" class="'+(open?'tick':'')+'">'+(open?'осмотрено':'')+'</div></div>';
    }).join('');
    const allOpen = leads.every(function(l){ return !!S.opened[l.id]; });
    const hiddenLeft = hiddenLeadsLeft(act);
    const tip = allOpen ? 'все точки осмотрены — вопросы ждут на телефоне'
      : (hiddenLeft ? 'осмотр открывает новые точки — проверьте список' : 'выберите точку на телефоне или щёлкните маркер');
    stage.innerHTML = '<div class="leads-tv">' +
      '<h3>ОСМОТР · АКТ '+(S.act+1)+' — '+esc(act.title.toUpperCase())+'</h3>' +
      '<div class="leads-list" style="grid-template-columns:1fr">'+items+'</div>' +
      '<div class="tag">'+tip+'</div>' +
    '</div>';
  }

  function renderEvidence(stage, ev, lead){
    let inner = '';
    if (ev.type === 'photo'){
      inner = '<div class="evi-photo"><div class="frame"><div class="tape"></div><img src="'+esc(ev.img)+'" alt="'+esc(ev.title)+'"></div>' +
        '<div class="cap"><b>'+esc(ev.title)+'.</b> '+ev.cap+'</div></div>';
    } else if (ev.type === 'scheme'){
      inner = '<div class="evi-scheme"><div class="frame"><img src="'+esc(ev.img)+'" alt="'+esc(ev.title)+'"></div>' +
        '<div class="cap" style="font-family:var(--mono);color:var(--muted);font-size:16px">'+ev.cap+'</div></div>';
    } else {
      inner = '<div class="evi-doc"><div class="doc-tv"><h3>УЛИКА · '+esc(lead.name.toUpperCase())+'</h3><h2>'+esc(ev.title)+'</h2>'+(ev.html||'')+'</div></div>';
    }
    stage.innerHTML = inner;
  }

  function renderQuiz(stage, q, qi, act){
    const ans = S.answers[q.id];
    const hintLvl = S.hints[q.id] || 0;
    const optsHtml = renderOptsTV(q, ans);
    const verdictHtml = ans ? verdictTV(q, ans) : '';
    const hintHtml = hintLvl ? '<div class="hint-mark">использованы подсказки: '+hintLvl+' / 3'+(ans ? ' · очки: '+ans.pts : '')+'</div>' : '';
    stage.innerHTML = '<div class="quiz-tv">' +
      '<div class="quiz-q"><span class="qtag">'+esc(q.tag)+' · АКТ '+(S.act+1)+' «'+esc(act.title)+'»</span>'+esc(q.text)+'</div>' +
      '<div class="quiz-opts">'+optsHtml+'</div>' + hintHtml + verdictHtml + '</div>';
  }

  function renderOptsTV(q, ans){
    if (q.kind === 'single'){
      return q.opts.map(function(o,i){
        let cls = 'quiz-opt';
        if (ans){ if (i === q.correct) cls += ' right'; else if (i === ans.i) cls += ' wrong'; }
        return '<div class="'+cls+'"><span class="key">'+String.fromCharCode(65+i)+'.</span> '+esc(o)+'</div>';
      }).join('');
    }
    if (q.kind === 'multi'){
      return q.opts.map(function(o,i){
        let cls = 'quiz-opt';
        if (ans){ cls += (q.correct.indexOf(i) >= 0) ? ' right' : (((ans.set||[]).indexOf(i) >= 0) ? ' wrong' : ''); }
        return '<div class="'+cls+'"><span class="key">'+String.fromCharCode(65+i)+'.</span> '+esc(o)+'</div>';
      }).join('');
    }
    if (q.kind === 'order'){
      const seed = hashStr(q.id);
      const shuffled = shuffledBy(q.order.map(function(t,i){ return {t:t, i:i}; }), seed);
      const seq = ans ? ans.order : shuffled.map(function(x){ return x.i; });
      return seq.map(function(origIdx, pos){
        let cls = 'quiz-opt';
        if (ans) cls += origIdx === pos ? ' right' : ' wrong';
        return '<div class="'+cls+'"><span class="key">'+(pos+1)+'.</span> '+esc(q.order[origIdx])+'</div>';
      }).join('');
    }
    if (q.kind === 'match'){
      const seed = hashStr(q.id+'r');
      const sel = ans ? ans.pairs : {};
      return q.pairs.map(function(p,k){
        const chosen = sel[k];
        const chosenText = (chosen != null) ? q.pairs[chosen][1] : '—';
        let cls = 'quiz-opt';
        if (ans) cls += chosen === k ? ' right' : ' wrong';
        return '<div class="'+cls+'"><span class="key">'+esc(p[0])+'</span> → '+esc(chosenText)+'</div>';
      }).join('');
    }
    return '';
  }

  function verdictTV(q, ans){
    const good = ans.ok;
    return '<div class="quiz-verdict '+(good?'good':'bad')+'">' +
      '<span class="ver-head">'+(good?'ВЕРНО':'НЕВЕРНО')+' · +'+ans.pts+' очк.</span>' +
      esc(q.why) + '</div>';
  }

  function renderCard(stage, title, text, foot){
    stage.innerHTML = '<div class="actcard"><h2>'+esc(title)+'</h2><div class="act-desc">'+esc(text)+'</div>' +
      '<div class="act-meta">'+esc(foot||'')+'</div>' +
      '<div class="tv-score" style="font-size:22px">'+S.score+' очк.</div></div>';
  }

  function renderFinale(stage){
    const f = CASE.finale;
    const cards = f.versions.map(function(v,i){
      let cls = 'ver-card', mark = '';
      if (S.chosenVer === i){ cls += ' chosen'; mark = '<span class="mark pick">ВАШ ВЫБОР</span>'; }
      if (S.resolved && i === f.correctIdx){ cls += ' correct'; mark = '<span class="mark truth">ИСТИНА ПО ДЕЛУ</span>'; }
      return '<div class="'+cls+'"><h4>'+String(i+1).padStart(2,'0')+' · '+esc(v.name)+'</h4><p>'+esc(v.desc)+'</p>'+mark+'</div>';
    }).join('');
    const betRow = (!S.resolved && S.chosenVer != null) ? '<div class="bet-bar">ставка: ' +
      f.betOpts.map(function(n){ return '<button class="btn mini '+(S.bet===n?'':'ghost')+'" data-bet="'+n+'">'+n+'</button>'; }).join('') +
      '<button class="btn mini" data-resolve="1" '+(S.bet==null?'disabled':'')+'>ПОДТВЕРДИТЬ</button></div>' : '';
    stage.innerHTML = '<div style="height:100%;display:flex;flex-direction:column;gap:14px;min-height:0">' +
      '<div class="tag">ФИНАЛ · ВЫБОР ВЕРСИИ И СТАВКА · '+S.score+' очк. в банке</div>' +
      '<div style="color:var(--ink2);font-size:min(2.3vw,19px);line-height:1.45">'+esc(f.intro)+'</div>' +
      '<div class="vers-grid">'+cards+'</div>' + betRow + '</div>';
    $$('#tv-view [data-bet]').forEach(function(b){ b.addEventListener('click', function(){ Actions.setBet(parseInt(b.dataset.bet,10)); }); });
    $$('#tv-view [data-resolve]').forEach(function(b){ b.addEventListener('click', function(){ Actions.resolveBet(); }); });
  }

  function renderResult(stage){
    const f = CASE.finale;
    const win = S.chosenVer === f.correctIdx;
    const delta = win ? S.bet*2 : -S.bet;
    stage.innerHTML = '<div class="rankcard">' +
      '<div class="stamp">'+(win ? 'ВЕРСИЯ ПОДТВЕРЖДЕНА' : 'ВЕРСИЯ НЕ ПОДТВЕРДИЛАСЬ')+'</div>' +
      '<div class="rank" style="font-size:40px;margin-top:14px">'+(win?'+':'−')+Math.abs(delta)+' очк.</div>' +
      '<div class="line">'+(win ? 'Истина по делу: «'+esc(f.versions[f.correctIdx].name)+'». Ставка удвоена.' : 'Истина по делу: «'+esc(f.versions[f.correctIdx].name)+'». Ставка сгорела.')+'</div>' +
      '<div class="stats"><span>ИТОГ: '+S.score+' ОЧК.</span></div>' +
      '<div style="margin-top:16px"><button class="btn" data-epi="1">ЭПИЛОГ</button></div></div>';
    $$('#tv-view [data-epi]').forEach(function(b){ b.addEventListener('click', function(){ Actions.goto('epi:0'); }); });
  }

  function renderEpi(stage, e, i){
    stage.innerHTML = '<div class="epli">' +
      '<div class="tag">ЭПИЛОГ · '+(i+1)+' / '+CASE.epilogue.length+'</div>' +
      '<h2>'+esc(e.title)+'</h2><p>'+e.html+'</p><div class="facts">'+esc(e.facts)+'</div>' +
      '<div><button class="btn" data-next="1">'+(i < CASE.epilogue.length-1 ? 'ДАЛЬШЕ' : 'ИТОГИ ИГРЫ')+'</button></div></div>';
    $$('#tv-view [data-next]').forEach(function(b){ b.addEventListener('click', function(){ Actions.nextEpi(); }); });
  }

  function renderDone(stage){
    const maxScore = CASE.acts.reduce(function(s,a){ return s + a.quiz.reduce(function(x,q){ return x+(q.pts||10); },0); }, 0);
    const pct = S.score / maxScore;
    const rank = CASE.meta.ranks.find(function(r){ return pct >= r[0]; }) || CASE.meta.ranks[CASE.meta.ranks.length-1];
    const hints = Object.keys(S.hints || {}).reduce(function(a,k){ return a + S.hints[k]; }, 0);
    stage.innerHTML = '<div class="rankcard" style="margin-top:4vh">' +
      '<div class="stamp">'+esc(CASE.meta.caseNo)+' · ЗАКРЫТО</div>' +
      '<div class="rank">'+esc(rank[1])+'</div>' +
      '<div class="line">'+esc(rank[2])+'</div>' +
      '<div class="stats"><span>'+S.score+' ОЧК.</span><span>ПОДСКАЗКИ: '+hints+'</span><span>ВРЕМЯ: '+fmtTime(Date.now() - (S.startedAt||Date.now()))+'</span></div>' +
      '<div style="color:var(--muted);font-size:15px;margin-top:18px;max-width:560px">Спасибо за игру. Полное дело и источники — на телефоне в разделе «Меню».</div>' +
      '<div class="rowbtns" style="justify-content:center;margin-top:24px">' +
      '<button class="btn" data-restart="1">ПЕРЕИГРАТЬ ЭТО ДЕЛО</button>' +
      '<button class="btn ghost" disabled title="в разработке">НОВОЕ ДЕЛО · В РАЗРАБОТКЕ</button></div></div>';
    $$('#tv-view [data-restart]').forEach(function(b){ b.addEventListener('click', function(){ Actions.restart(); }); });
  }

  function footer(){
    const f = $('#tv-footer');
    if (!S){ f.innerHTML = ''; return; }
    const p = stepParts();
    const prompts = {
      intro:'дайте команде прочитать вводную · управление на телефоне',
      brief:'обсудите вводную · затем открывайте точки на карте',
      leads:'обсудите, какие точки осмотреть первыми',
      lead:'читайте улику вслух · что она меняет в версии команды?',
      quiz:'обсудите командой · подсказки на телефоне, очки общие',
      outro:'итог акта · дальше — следующий акт',
      finale:'самое важное решение дела: выберите версию и ставьте очки',
      result:'разбор финала · затем эпилог',
      epi:'эпилог · реальные судьбы людей и камней',
      done:'финал игры · обсудите, что бы вы сделали на месте Нотарбартоло'
    };
    f.innerHTML = '<b>▸</b> ' + esc(prompts[p.view] || '');
  }

  function header(){
    if (!S) return;
    const act = CASE.acts[S.act];
    $('#tv-act').textContent = act ? ('АКТ '+(S.act+1)+' · '+act.title) : CASE.meta.tagline;
    $('#tv-score').innerHTML = S.score + ' <span>очк.</span>';
  }

  return {render, footer, header};
})();

/* ---------------- контроллер (телефон и шторка) ---------------- */
const UI = (() => {
  let tab = 'flow';
  let phMapBuilt = false;
  const uiPicks = {}, uiMulti = {}, uiOrder = {}, uiPairs = {};

  function phoneTab(t){
    tab = t;
    $$('#ph-tabs .ph-tab').forEach(function(b){ b.classList.toggle('active', b.dataset.tab === t); });
    renderPhoneStage();
  }

  function renderPhoneStage(){
    const stage = $('#phone-stage');
    if (!stage) return;
    if (!S){
      stage.innerHTML = '<div class="ph-card"><h3>Подключение</h3><p>Ожидание состояния игры… Если код не введён — введите его в «Меню».</p></div>';
      return;
    }
    if (tab === 'flow') renderFlow(stage);
    else if (tab === 'case') renderCase(stage);
    else if (tab === 'evidence') renderEvidenceList(stage);
    else if (tab === 'map') renderMapTab(stage);
    else if (tab === 'menu') renderMenu(stage);
  }

  function renderFlow(stage){
    const act = CASE.acts[S.act];
    const t = String(S.step);
    if (t === 'intro'){ renderIntroPhone(stage); return; }
    if (t === 'brief'){
      stage.innerHTML = '<div class="ph-card ph-doc"><h3>БРИФИНГ · АКТ '+(S.act+1)+'</h3><h2>'+esc(act.brief.title)+'</h2>'+act.brief.html +
        '<div class="rowbtns"><button class="btn" data-go="leads">К ОСМОТРУ ('+visibleLeads(act).length+' точек)</button></div></div>';
      bindGo(stage); return;
    }
    if (t === 'leads'){ renderLeadsPhone(stage, act); return; }
    if (t.indexOf('lead:') === 0){
      const lead = findLead(t.slice(5));
      const ev = lead && CASE.evidence[lead.ev];
      if (!ev){ Actions.backToLeads(); return; }
      stage.innerHTML = '<div class="ph-card ph-doc"><h3>УЛИКА</h3><h2>'+esc(ev.title)+'</h2>' +
        (ev.type !== 'doc' ? '<img class="photo" src="'+esc(ev.img)+'" alt="">' : '') +
        (ev.type !== 'doc' ? '<div class="cap">'+ev.cap+'</div>' : '') +
        (ev.type === 'doc' ? (ev.html||'') : '') +
        '<div class="rowbtns"><button class="btn ghost" data-go="leads">← К СПИСКУ ТОЧЕК</button>' +
        (allLeadsOpen(act) ? '<button class="btn" data-go="quiz:0">К ВОПРОСАМ</button>' : '') + '</div></div>';
      bindGo(stage); return;
    }
    if (t.indexOf('quiz:') === 0){ renderQuizPhone(stage, act); return; }
    if (t === 'outro'){
      const nxt = S.act < CASE.acts.length-1;
      stage.innerHTML = '<div class="ph-card"><h3>АКТ '+(S.act+1)+' ЗАВЕРШЁН</h3><p>'+esc(act.outro)+'</p>' +
        '<p class="cap">очки: '+S.score+'</p>' +
        '<div class="rowbtns"><button class="btn" data-go="'+(nxt?'nextact':'finale')+'">'+(nxt?'СЛЕДУЮЩИЙ АКТ':'ФИНАЛ: ВЫБОР ВЕРСИИ')+'</button></div></div>';
      bindGo(stage); return;
    }
    if (t === 'finale'){ renderFinalePhone(stage); return; }
    if (t === 'result'){
      const f = CASE.finale; const win = S.chosenVer === f.correctIdx;
      stage.innerHTML = '<div class="ph-card"><h3>Разбор финала</h3>' +
        '<p>'+(win ? 'Ставка сыграла — удвоена (+'+(S.bet*2)+' очк.).' : 'Ставка сгорела (−'+S.bet+' очк.).')+'</p>' +
        '<p><b>Истина по делу: «'+esc(f.versions[f.correctIdx].name)+'»</b> — профессиональная банда извне, два года подготовки. К этому же выводу пришли детективы Пейс и Де Брюйкер.</p>' +
        '<p class="cap">очки: '+S.score+'</p>' +
        '<div class="rowbtns"><button class="btn" data-go="epi">ЭПИЛОГ</button></div></div>';
      bindGo(stage); return;
    }
    if (t.indexOf('epi:') === 0){
      const i = parseInt(t.split(':')[1],10)||0; const e = CASE.epilogue[i];
      stage.innerHTML = '<div class="ph-card ph-doc"><h3>ЭПИЛОГ '+(i+1)+'/'+CASE.epilogue.length+'</h3><h2>'+esc(e.title)+'</h2>'+e.html +
        '<div class="cap">'+esc(e.facts)+'</div>' +
        '<div class="rowbtns"><button class="btn" data-go="'+(i<CASE.epilogue.length-1 ? 'epi:'+(i+1) : 'done')+'">'+(i<CASE.epilogue.length-1?'ДАЛЬШЕ':'ИТОГИ')+'</button></div></div>';
      bindGo(stage); return;
    }
    if (t === 'done'){ renderDonePhone(stage); return; }
    renderIntroPhone(stage);
  }

  function renderIntroPhone(stage){
    stage.innerHTML = '<div class="ph-card ph-doc">' +
      '<h3>'+esc(CASE.meta.caseNo)+'</h3>' +
      '<h2>Как играть</h2>' +
      '<p>Вы — <b>коллективный детектив</b>: один телефон на всю команду. Читайте вводные и улики вслух, обсуждайте, решайте вместе.</p>' +
      '<p>Экран ТВ показывает карту, фото и документы на весь экран. Телефон — «досье следователя»: ход, улики, ответы.</p>' +
      '<ul style="margin:.5em 0 .8em 1.1em;color:var(--ink2);font-size:14.5px;line-height:1.6">' +
      '<li>в каждом акте — свободный осмотр точек на карте;</li>' +
      '<li>когда всё осмотрено — открываются вопросы акта;</li>' +
      '<li>застряли — «Наводка»: три уровня подсказок;</li>' +
      '<li>финал — выбор версии случившегося и ставка очков.</li></ul>' +
      '<p class="cap">продолжительность: 2–3 часа · игроков: 2–8 · всё основано на реальном деле. Комната: <b>'+esc(ROOM)+'</b></p>' +
      '<div class="sync-line" id="ph-sync">проверка связи…</div>' +
      '<div class="rowbtns"><button class="btn" data-start="1">НАЧАТЬ РАССЛЕДОВАНИЕ</button></div></div>';
    const b = stage.querySelector('[data-start]');
    if (b) b.addEventListener('click', function(){ Actions.start(); });
    updateSyncLine();
  }

  function renderDonePhone(stage){
    const maxScore = CASE.acts.reduce(function(s,a){ return s + a.quiz.reduce(function(x,q){ return x+(q.pts||10); },0); }, 0);
    const pct = S.score / maxScore;
    const rank = CASE.meta.ranks.find(function(r){ return pct >= r[0]; }) || CASE.meta.ranks[CASE.meta.ranks.length-1];
    stage.innerHTML = '<div class="ph-card"><h3>ИТОГИ</h3>' +
      '<p style="font-size:20px;color:var(--amber)">'+esc(rank[1])+'</p>' +
      '<p>'+esc(rank[2])+'</p>' +
      '<p class="cap">очки: '+S.score+' из '+maxScore+' возможных за расследование</p>' +
      '<div class="rowbtns"><button class="btn" data-restart="1">ПЕРЕИГРАТЬ ЭТО ДЕЛО</button>' +
      '<button class="btn ghost" disabled>НОВОЕ ДЕЛО · В РАЗРАБОТКЕ</button></div></div>' + renderSources();
    const r = stage.querySelector('[data-restart]');
    if (r) r.addEventListener('click', function(){ Actions.restart(); });
  }

  function allLeadsOpen(act){ return visibleLeads(act).every(function(l){ return !!S.opened[l.id]; }); }

  function renderLeadsPhone(stage, act){
    const leads = visibleLeads(act);
    const items = leads.map(function(l,i){
      return '<div class="lead-item '+(S.opened[l.id]?'open':'')+'" tabindex="0" data-lead="'+esc(l.id)+'">' +
        '<span class="num">'+String(i+1).padStart(2,'0')+'</span>' +
        '<span>'+esc(l.name)+'<span class="cap" style="margin:0"> · '+esc(l.sub)+'</span></span>' +
        '<span class="go">'+(S.opened[l.id]?'↻':'▸')+'</span></div>';
    }).join('');
    const quizBtn = allLeadsOpen(act)
      ? '<div class="rowbtns"><button class="btn" data-go="quiz:0">ВОПРОСЫ АКТА ('+act.quiz.length+')</button></div>'
      : '<p class="cap">'+(hiddenLeadsLeft(act) ? 'осмотр открывает новые точки — продолжайте осмотр' : 'осмотрите все точки — вопросы откроются автоматически')+'</p>';
    stage.innerHTML = '<div class="ph-card"><h3>ОСМОТР · АКТ '+(S.act+1)+'</h3>'+items+quizBtn+'</div>';
    $$('[data-lead]', stage).forEach(function(el){ el.addEventListener('click', function(){ Actions.openLead(el.dataset.lead); }); });
    bindGo(stage);
  }

  function renderQuizPhone(stage, act){
    const q = act.quiz[quizIndexFromStep()];
    const ans = S.answers[q.id];
    const hintLvl = S.hints[q.id] || 0;
    let body = '';

    if (q.kind === 'single'){
      body = q.opts.map(function(o,i){
        let cls = 'opt';
        if (ans){ cls += (i === q.correct ? ' right' : (i === ans.i ? ' wrong' : '')); }
        else if (uiPicks[q.id] === i) cls += ' picked';
        return '<button class="'+cls+'" data-pick="'+i+'"><span class="key">'+String.fromCharCode(65+i)+'.</span>'+esc(o)+'</button>';
      }).join('');
    } else if (q.kind === 'multi'){
      const set = uiMulti[q.id] || [];
      body = q.opts.map(function(o,i){
        let cls = 'opt';
        if (ans){ cls += (q.correct.indexOf(i) >= 0 ? ' right' : (set.indexOf(i) >= 0 ? ' wrong' : '')); }
        else if (set.indexOf(i) >= 0) cls += ' picked';
        return '<button class="'+cls+'" data-mpick="'+i+'"><span class="key">'+String.fromCharCode(65+i)+'.</span>'+esc(o)+'</button>';
      }).join('');
    } else if (q.kind === 'order'){
      const seed = hashStr(q.id);
      const arr = uiOrder[q.id] || shuffledBy(q.order.map(function(_,i){ return i; }), seed);
      body = arr.map(function(origIdx, pos){
        return '<div class="opt" style="display:flex;gap:8px;align-items:center;cursor:default">' +
          '<span class="key">'+(pos+1)+'.</span><span style="flex:1">'+esc(q.order[origIdx])+'</span>' +
          (ans ? '' : '<button class="btn mini ghost" data-up="'+pos+'">↑</button><button class="btn mini ghost" data-down="'+pos+'">↓</button>') + '</div>';
      }).join('');
    } else if (q.kind === 'match'){
      const seed = hashStr(q.id+'r');
      const rights = shuffledBy(q.pairs.map(function(p,i){ return {t:p[1], i:i}; }), seed);
      const sel = ans ? ans.pairs : (uiPairs[q.id] || {});
      body = q.pairs.map(function(p,k){
        let chosen = '';
        if (ans){ const ci = sel[k]; chosen = (ci != null && q.pairs[ci]) ? esc(q.pairs[ci][1]) : '—'; }
        return '<div class="opt" style="display:block;cursor:default">' +
          '<div style="margin-bottom:6px"><span class="key">'+esc(p[0])+'</span></div>' +
          (ans ? '<div>'+chosen+'</div>' :
            '<select data-pair="'+k+'" style="width:100%;background:var(--paper3);color:var(--ink);border:1px solid var(--line2);border-radius:8px;padding:10px;font-size:14px">' +
            '<option value="-1">— выбрать —</option>' +
            rights.map(function(r){ return '<option value="'+r.i+'"'+(sel[k]===r.i?' selected':'')+'>'+esc(r.t)+'</option>'; }).join('') +
            '</select>') + '</div>';
      }).join('');
    }

    const hintsBlock = ans ? '' :
      '<div class="hintbox"><span class="hlabel">ПОДСКАЗКИ · УРОВЕНЬ '+hintLvl+'/3'+(hintLvl ? ' · максимум очков за вопрос: '+Math.round((q.pts||10)*[1,.6,.3,0][hintLvl]) : '')+'</span>' +
      '<div id="hint-text">'+(hintLvl ? esc([q.hint1,q.hint2,q.hint3][hintLvl-1]) : 'Если команда застряла — открывайте по одной. Очки не сгорают, уменьшается только награда за вопрос.')+'</div>' +
      '<div class="rowbtns" style="margin-top:10px">' +
      (hintLvl===0 ? '<button class="btn ghost mini" data-hint="1">НАВОДКА</button>' : '') +
      (hintLvl===1 ? '<button class="btn ghost mini" data-hint="2">СИЛЬНАЯ ПОДСКАЗКА</button>' : '') +
      (hintLvl===2 ? '<button class="btn ghost mini" data-hint="3">ПОКАЗАТЬ ОТВЕТ</button>' : '') +
      '</div></div>';

    const submitBlock = ans ? '' : '<div class="rowbtns"><button class="btn" data-submit="1">ОТВЕТИТЬ' +
      (q.kind === 'multi' ? ' · отмечено: ' + (uiMulti[q.id] || []).length : '') + '</button></div>';
    const verdict = ans
      ? '<div class="verdict '+(ans.ok?'good':'bad')+'"><span class="vh">'+(ans.ok?'ВЕРНО':'НЕВЕРНО')+' · +'+ans.pts+' очк.</span>'+esc(q.why)+'</div>' +
        '<div class="rowbtns"><button class="btn" data-go="nextq">ДАЛЬШЕ</button></div>'
      : '';

    stage.innerHTML = '<div class="ph-card"><h3>'+esc(q.tag)+' · АКТ '+(S.act+1)+'</h3>' +
      '<div class="ph-q">'+esc(q.text)+'</div>'+body+hintsBlock+submitBlock+verdict+'</div>';

    if (!ans){
      $$('[data-pick]', stage).forEach(function(b){ b.addEventListener('click', function(){ uiPicks[q.id] = parseInt(b.dataset.pick,10); renderPhoneStage(); }); });
      $$('[data-mpick]', stage).forEach(function(b){ b.addEventListener('click', function(){
        const set = uiMulti[q.id] = uiMulti[q.id] || [];
        const i = parseInt(b.dataset.mpick,10);
        const k = set.indexOf(i); if (k >= 0) set.splice(k,1); else set.push(i);
        renderPhoneStage();
      }); });
      $$('[data-up]', stage).forEach(function(b){ b.addEventListener('click', function(){ moveOrder(q.id, parseInt(b.dataset.up,10), -1); }); });
      $$('[data-down]', stage).forEach(function(b){ b.addEventListener('click', function(){ moveOrder(q.id, parseInt(b.dataset.down,10), +1); }); });
      $$('[data-pair]', stage).forEach(function(sel){ sel.addEventListener('change', function(){
        const k = parseInt(sel.dataset.pair,10); const v = parseInt(sel.value,10);
        const ps = uiPairs[q.id] = uiPairs[q.id] || {};
        if (v >= 0) ps[k] = v; else delete ps[k];
        renderPhoneStage();
      }); });
      $$('[data-hint]', stage).forEach(function(b){ b.addEventListener('click', function(){ Actions.useHint(q.id); }); });
      const sub = $('[data-submit]', stage);
      if (sub) sub.addEventListener('click', function(){
        if (q.kind === 'single'){ if (uiPicks[q.id] == null) return flashHint('Выберите вариант'); Actions.submit(q.id, {i: uiPicks[q.id]}); }
        else if (q.kind === 'multi'){ const set = uiMulti[q.id]||[]; if (!set.length) return flashHint('Отметьте хотя бы один пункт'); Actions.submit(q.id, {set: set}); }
        else if (q.kind === 'order'){ const arr = uiOrder[q.id]; if (!arr) return flashHint('Расставьте порядок стрелками'); Actions.submit(q.id, {order: arr}); }
        else if (q.kind === 'match'){ const ps = uiPairs[q.id]||{}; if (Object.keys(ps).length < q.pairs.length) return flashHint('Сопоставьте все пары'); Actions.submit(q.id, {pairs: ps}); }
      });
    }
    /* ДАЛЬШЕ (data-go="nextq") уже получает обработчик в bindGo —
       второй listener вызывал двойной переход и пропуск вопросов */
    bindGo(stage);
  }

  function flashHint(msg){ const el = $('#hint-text'); if (el) el.textContent = msg; }

  function moveOrder(qid, pos, dir){
    const seed = hashStr(qid);
    const q = CASE.acts[S.act].quiz.find(function(x){ return x.id === qid; });
    const arr = uiOrder[qid] || shuffledBy(q.order.map(function(_,i){ return i; }), seed);
    const j = pos + dir;
    if (j < 0 || j >= arr.length) return;
    const tmp = arr[pos]; arr[pos] = arr[j]; arr[j] = tmp;
    uiOrder[qid] = arr;
    renderPhoneStage();
  }

  function renderFinalePhone(stage){
    const f = CASE.finale;
    const cards = f.versions.map(function(v,i){
      return '<button class="opt'+(S.chosenVer===i?' picked':'')+'" data-ver="'+i+'">' +
        '<span class="key">'+String(i+1).padStart(2,'0')+'</span>'+esc(v.name)+'<br>' +
        '<span style="color:var(--muted);font-size:13px">'+esc(v.desc)+'</span></button>';
    }).join('');
    const betRow = (S.chosenVer != null && !S.resolved)
      ? '<div class="hintbox"><span class="hlabel">СТАВКА · верный выбор удваивает её, неверный — сжигает</span>' +
        '<div class="rowbtns">' + f.betOpts.map(function(n){ return '<button class="btn mini '+(S.bet===n?'':'ghost')+'" data-bet="'+n+'">'+n+' очк.</button>'; }).join('') +
        '<button class="btn mini" data-resolve="1"'+(S.bet==null?' disabled':'')+'>ПОДТВЕРДИТЬ</button></div></div>' : '';
    const after = S.resolved
      ? '<div class="verdict '+(S.chosenVer===f.correctIdx?'good':'bad')+'"><span class="vh">ИСТИНА ПО ДЕЛУ</span>' +
        '«'+esc(f.versions[f.correctIdx].name)+'». '+(S.chosenVer===f.correctIdx?'Ставка удвоена.':'Ставка сгорела.')+' Очки: '+S.score+'.</div>' +
        '<div class="rowbtns"><button class="btn" data-go="epi">ЭПИЛОГ</button></div>' : '';
    stage.innerHTML = '<div class="ph-card"><h3>ФИНАЛ · ВЫБОР ВЕРСИИ</h3><p>'+esc(f.intro)+'</p>'+cards+betRow+after+'</div>';
    $$('[data-ver]', stage).forEach(function(b){ b.addEventListener('click', function(){ Actions.setVer(parseInt(b.dataset.ver,10)); }); });
    $$('[data-bet]', stage).forEach(function(b){ b.addEventListener('click', function(){ Actions.setBet(parseInt(b.dataset.bet,10)); }); });
    const r = $('[data-resolve]', stage); if (r) r.addEventListener('click', function(){ Actions.resolveBet(); });
    /* data-go="epi" обрабатывается в bindGo — дубль удалял двойным переходом */
    bindGo(stage);
  }

  function renderCase(stage){
    const items = CASE.acts.map(function(a,i){
      const locked = i > S.act;
      return '<div class="lead-item'+(locked?'':' open')+'" data-brief="'+i+'" style="'+(locked?'opacity:.45':'')+'">' +
        '<span class="num">'+(i+1)+'</span><span>'+esc(a.title)+'<span class="cap" style="margin:0"> · '+esc(a.sub)+'</span></span>' +
        '<span class="go">'+(i===S.act?'текущий':(locked?'закрыт':'▸'))+'</span></div>';
    }).join('');
    const cur = CASE.acts[S.act];
    stage.innerHTML = '<div class="ph-card"><h3>ДЕЛО · АКТЫ</h3>'+items+'</div>' +
      '<div class="ph-card ph-doc"><h3>БРИФИНГ ТЕКУЩЕГО АКТА</h3><h2>'+esc(cur.brief.title)+'</h2>'+cur.brief.html+'</div>';
    $$('[data-brief]', stage).forEach(function(el){ el.addEventListener('click', function(){
      const i = parseInt(el.dataset.brief,10);
      if (i === S.act){ Actions.goto('brief'); phoneTab('flow'); }
    }); });
  }

  function renderEvidenceList(stage){
    const rows = [];
    CASE.acts.forEach(function(a, ai){ a.leads.forEach(function(l){ if (S.opened[l.id]) rows.push({ai:ai, l:l}); }); });
    const items = rows.map(function(r){
      return '<div class="lead-item" data-lead="'+esc(r.l.id)+'"><span class="num">▪</span>' +
        '<span>'+esc(CASE.evidence[r.l.ev].title)+'<span class="cap" style="margin:0"> · акт '+(r.ai+1)+'</span></span>' +
        '<span class="go">▸</span></div>';
    }).join('') || '<p class="cap">Улики появятся, когда вы осмотрите точки на карте.</p>';
    stage.innerHTML = '<div class="ph-card"><h3>УЛИКИ ('+rows.length+')</h3>'+items+'</div>';
    $$('[data-lead]', stage).forEach(function(el){ el.addEventListener('click', function(){
      Actions.goto('lead:'+el.dataset.lead); phoneTab('flow');
    }); });
  }

  function renderMapTab(stage){
    stage.innerHTML = '<div class="ph-card"><h3>КАРТА · АНТВЕРПЕН</h3>' +
      '<p class="cap">Жёлтые маркеры — осмотренные точки. Нажмите маркер, чтобы открыть точку текущего акта.</p></div>' +
      '<div id="ph-map" class="map-mini"></div>';
    if (!phMapBuilt && window.L){ Maps.buildPhone($('#ph-map')); phMapBuilt = true; }
    Maps.phInvalidate();
    Maps.updatePhone();
  }

  function renderMenu(stage){
    const hints = Object.keys(S.hints || {}).reduce(function(a,k){ return a + S.hints[k]; }, 0);
    stage.innerHTML =
      '<div class="menu-stats">' +
        '<div class="stat-box"><div class="v">'+S.score+'</div><div class="k">ОЧКИ</div></div>' +
        '<div class="stat-box"><div class="v">'+hints+'</div><div class="k">ПОДСКАЗОК</div></div>' +
        '<div class="stat-box"><div class="v">'+Object.keys(S.opened).length+'</div><div class="k">УЛИК ОТКРЫТО</div></div>' +
        '<div class="stat-box"><div class="v">'+(S.act+1)+'/'+CASE.acts.length+'</div><div class="k">АКТ</div></div>' +
      '</div>' +
      '<div class="ph-card"><h3>Комната</h3>' +
        '<p>Код: <span class="kbd" id="ph-room">'+esc(ROOM)+'</span> · синхронизация: '+(Sync.isMqtt()?'MQTT-брокер':'локальная')+'</p>' +
        '<div class="sync-line" id="ph-sync">проверка связи…</div>' +
        '<p class="cap">Экран ТВ: откройте ссылку игры, режим «Экран следователя», введите код '+esc(ROOM)+' или отсканируйте QR с ТВ.</p></div>' +
      '<div class="ph-card"><h3>Правила в двух словах</h3>' +
        '<p>Очки общие, подсказки не штрафуются (уменьшают награду за вопрос). Финал — выбор версии и ставка. Победа командная.</p></div>' +
      renderSources() +
      '<div class="ph-card"><h3>Опасная зона</h3>' +
        '<div class="rowbtns"><button class="btn ghost" data-restart2="1">НАЧАТЬ ЭТО ДЕЛО ЗАНОВО</button>' +
        '<button class="btn ghost" id="btn-reset">НОВАЯ ИГРА (новая комната)</button></div></div>';
    $('#btn-reset', stage).addEventListener('click', function(){
      if (confirm('Начать новую игру? Прогресс будет потерян.')){
        ROOM = genRoom();
        history.replaceState(null, '', location.pathname + '?mode=' + (MODE||'phone') + '&room=' + ROOM);
        S = freshState();
        Sync.publish();
        renderAll();
      }
    });
    const rs2 = stage.querySelector('[data-restart2]');
    if (rs2) rs2.addEventListener('click', function(){
      if (confirm('Начать это дело заново? Очки, осмотр и ответы сбросятся.')) Actions.restart();
    });
  }

  function renderSources(){
    return '<div class="ph-card"><h3>Источники дела</h3><div class="srcs">' +
      CASE.meta.sources.map(function(s){ return '· '+esc(s); }).join('<br>') +
      '</div><p class="cap">Фотографии — иллюстрации из открытых источников; схема хранилища — реконструкция по материалам дела.</p></div>';
  }

  /* --- шторка на ТВ (соло/резерв) --- */
  function renderDrawer(){
    const body = $('#drawer-body');
    if (!body) return;
    if (!S){ body.innerHTML = '<p class="cap">Ожидание состояния…</p>'; return; }
    if (S.step === 'intro'){
      body.innerHTML = '<div class="ph-card"><h3>СОЛО-РЕЖИМ</h3>' +
        '<p class="cap">Управление стрелками и Enter (пульт ТВ). Или подключите телефон по коду '+esc(ROOM)+'.</p>' +
        '<div class="rowbtns"><button class="btn mini" data-start="1">НАЧАТЬ</button></div></div>';
      const b = body.querySelector('[data-start]'); if (b) b.addEventListener('click', function(){ Actions.start(); });
      return;
    }
    const stage = document.createElement('div');
    renderFlow(stage);
    body.innerHTML = '';
    body.appendChild(stage);
  }

  function bindGo(stage){
    $$('[data-go]', stage).forEach(function(b){ b.addEventListener('click', function(){
      const g = b.dataset.go;
      if (g === 'leads') Actions.backToLeads();
      else if (g === 'nextact') Actions.nextAct();
      else if (g === 'nextq') Actions.nextQuiz();
      else Actions.goto(g);
    }); });
  }

  function resetPicks(){
    /* очистка локальных черновиков ответов при переигрывании */
    ['uiPicks','uiMulti','uiOrder','uiPairs'].forEach(function(store){
      const o = ({uiPicks:uiPicks, uiMulti:uiMulti, uiOrder:uiOrder, uiPairs:uiPairs})[store];
      Object.keys(o).forEach(function(k){ delete o[k]; });
    });
  }

  return {phoneTab, renderPhoneStage, renderDrawer, resetPicks, get tab(){ return tab; }};
})();

/* ---------------- индикатор связи «ТВ ↔ пульт» ---------------- */
function updateSyncLine(){
  const tv = $('#tv-sync');
  if (tv && (role === 'tv' || role === 'solo')){
    if (!Sync.isMqtt()){
      tv.className = 'sync-line err';
      tv.textContent = 'нет связи с брокером — телефон не сможет управлять экраном. Проверьте интернет на ТВ или включите соло-режим';
    } else if (Sync.helloAge() < 8000){
      tv.className = 'sync-line ok';
      tv.textContent = 'пульт подключён — начинайте расследование на телефоне';
    } else {
      tv.className = 'sync-line wait';
      tv.textContent = 'связь с брокером есть · ждём пульт: отсканируйте QR телефоном';
    }
  }
  const ph = $('#ph-sync');
  if (ph && role === 'phone'){
    if (Sync.isMqtt()){
      ph.className = 'sync-line ok';
      ph.textContent = 'связь: MQTT-брокер · комната ' + ROOM + ' — экран ТВ получит всё, что вы делаете';
    } else if (bcSupported()){
      ph.className = 'sync-line wait';
      ph.textContent = 'связь: только вкладки одного браузера. Для связи с ТВ нужен MQTT — проверьте интернет';
    } else {
      ph.className = 'sync-line err';
      ph.textContent = 'связь не установлена — проверьте интернет';
    }
  }
}
function bcSupported(){ try { new BroadcastChannel('koda-probe'); return true; } catch(e){ return false; } }
setInterval(updateSyncLine, 1200);

/* ---------------- общий рендер ---------------- */
let tvMapBuilt = false;
function renderAll(){
  if (S){
    TV.header();
    const act = CASE.acts[S.act];
    const phAct = $('#ph-act'); if (phAct) phAct.textContent = 'АКТ '+(S.act+1)+' · '+act.title;
    const phStep = $('#ph-step'); if (phStep) phStep.textContent = stepLabel();
  }
  TV.render($('#tv-view'));
  if (!tvMapBuilt && (role === 'tv' || role === 'solo') && window.L && $('#tv-map-layer')){ Maps.buildTV($('#tv-map-layer')); tvMapBuilt = true; }
  Maps.updateTV();
  TV.footer();
  UI.renderPhoneStage();
  UI.renderDrawer();
  updateTimer();
}

function stepLabel(){
  if (!S) return '';
  const act = CASE.acts[S.act];
  const t = String(S.step);
  if (t === 'intro') return 'вступление';
  if (t === 'brief') return 'брифинг акта '+(S.act+1);
  if (t === 'leads'){ const vis = visibleLeads(act); return 'осмотр: '+vis.filter(function(l){ return !!S.opened[l.id]; }).length+'/'+vis.length+' точек'; }
  if (t.indexOf('lead:') === 0){ const l = act.leads.find(function(x){ return x.id === t.slice(5); }); return 'улика: '+(l ? l.name : ''); }
  if (t.indexOf('quiz:') === 0) return 'вопрос '+(parseInt(t.split(':')[1],10)+1)+'/'+act.quiz.length;
  if (t === 'outro') return 'акт завершён';
  if (t === 'finale') return 'финал: версии';
  if (t === 'result') return 'разбор финала';
  if (t.indexOf('epi:') === 0) return 'эпилог';
  if (t === 'done') return 'итоги';
  return '';
}

/* ---------------- таймер ---------------- */
function updateTimer(){
  const ms = S && S.startedAt ? Date.now() - S.startedAt : 0;
  const t = fmtTime(ms);
  const el1 = $('#tv-timer'); if (el1) el1.textContent = t;
  const el2 = $('#ph-timer'); if (el2) el2.textContent = t;
}
setInterval(updateTimer, 1000);

/* ---------------- пульт ТВ: стрелки/Enter/назад ---------------- */
let focusables = [];
function collectFocusables(){
  focusables = $$('#tv-drawer button, #tv-drawer select, #tv-drawer .opt, #tv-drawer .lead-item').filter(function(el){ return el.offsetParent !== null; });
}
function toggleDrawer(){
  const d = $('#tv-drawer'); if (!d) return;
  d.classList.toggle('hidden');
  const fab = $('#drawer-fab');
  if (fab) fab.classList.toggle('hidden', !d.classList.contains('hidden'));
}
document.addEventListener('keydown', function(e){
  if (role !== 'tv' && role !== 'solo') return;
  const isBack = (e.key === 'GoBack') || (e.keyCode === 10009) || (e.key === 'BrowserBack');
  if (isBack){ e.preventDefault(); if (role === 'tv') toggleDrawer(); return; }
  if (e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'Enter' || e.key === 'ArrowLeft' || e.key === 'ArrowRight'){
    const d = $('#tv-drawer');
    if (!d || d.classList.contains('hidden')){
      if (e.key === 'Enter' && $('#drawer-fab') && !$('#drawer-fab').classList.contains('hidden')){ toggleDrawer(); }
      return;
    }
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'Enter'){
      e.preventDefault();
      collectFocusables();
      if (!focusables.length) return;
      const idx = focusables.indexOf(document.activeElement);
      if (e.key === 'Enter'){
        if (idx >= 0) document.activeElement.click(); else focusables[0].focus();
      } else {
        const step = e.key === 'ArrowDown' ? 1 : -1;
        const next = idx < 0 ? 0 : Math.max(0, Math.min(focusables.length-1, idx + step));
        focusables[next].focus();
      }
    }
  }
});

/* ---------------- загрузка ---------------- */
function boot(){
  role = MODE;
  if (!role){
    $('#role-select').classList.remove('hidden');
    $$('.role-btn').forEach(function(b){ b.addEventListener('click', function(){
      location.search = '?mode=' + b.dataset.mode + (ROOM ? '&room=' + ROOM : '');
    }); });
    return;
  }
  $('#role-select').classList.add('hidden');
  if (role === 'phone'){
    $('#phone').classList.remove('hidden');
    $$('#ph-tabs .ph-tab').forEach(function(b){ b.addEventListener('click', function(){ UI.phoneTab(b.dataset.tab); }); });
  } else {
    $('#tv').classList.remove('hidden');
    if (role === 'solo'){
      $('#tv-drawer').classList.remove('hidden');
      const fab = $('#drawer-fab'); if (fab) fab.classList.add('hidden');
      const dc = $('#drawer-close'); if (dc) dc.style.display = 'none';
    } else {
      const fab = $('#drawer-fab'); if (fab) fab.classList.remove('hidden');
    }
    const dc = $('#drawer-close'); if (dc) dc.addEventListener('click', toggleDrawer);
    const fab = $('#drawer-fab'); if (fab) fab.addEventListener('click', toggleDrawer);
  }
  if (!ROOM) ROOM = genRoom();
  history.replaceState(null, '', location.pathname + '?mode=' + role + '&room=' + ROOM);
  Sync.setNet();
  Sync.connect();
  renderAll();
  // если через 1.6 с никто не прислал состояние — начинаем как «хост»
  setTimeout(function(){
    if (!S){ S = freshState(); Sync.publish(); renderAll(); }
  }, 1600);
}
document.addEventListener('DOMContentLoaded', boot);
