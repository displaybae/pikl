/* ============================================================
   픽클 (Pikl) — consumer frontend
   Single-page app. Built against the API contract; falls back
   to MOCK data when the backend isn't reachable so the UI is
   fully demoable offline. Real fetch() paths drop in cleanly.
   ============================================================ */
'use strict';

/* ---------- tiny DOM helpers ---------- */
const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const el = (tag, cls, html) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;
  return n;
};
const esc = s => String(s ?? '').replace(/[&<>"]/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* ============================================================
   STATE
   ============================================================ */
const state = {
  token: null,
  nickname: null,
  isAdmin: false,
  wardrobe: [],          // [{file, ref, url}] — GARMENTS only
  models: [],            // [{file, ref, url}] — saved person/full photos
  tab: 'closet',
  closetSeg: 'garments', // 'garments' | 'models' — which closet view is showing
  // add flow
  addImage: null,        // dataURL of uploaded person
  detected: [],          // [{category,name,description, status}]
  // try-on flow
  personImage: null,     // dataURL (upload) OR storage ref (picked saved model)
  personRef: null,       // storage ref when the person came from a saved model
  picks: [],             // filenames selected (max 4)
  // help chat
  chat: {
    messages: [],        // [{role:'user'|'assistant', content}]
    busy: false,         // awaiting a /api/chat reply
    greeted: false,      // greeting + chips rendered once
  },
};

const LS = {
  token: 'pikl_token',
  nick:  'pikl_nick',
  admin: 'pikl_admin',
  onbDone: n => `pikl_onb_done_${n}`,
  tourDone: n => `pikl_tour_done_${n}`,
};

/* ============================================================
   API LAYER
   Every call adds Authorization: Bearer <token>. If a request
   fails at the network level (backend not up yet), we fall back
   to MOCK so the UI stays alive. Server errors (4xx/5xx with
   JSON) are surfaced normally.
   ============================================================ */
const USE_MOCK_FALLBACK = false; // integrated build hits the real API (flip true for offline demo)
let MOCK_ACTIVE = false; // flips true once we detect no backend

async function api(path, { method = 'GET', body = null } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (state.token) headers['Authorization'] = 'Bearer ' + state.token;
  let res;
  try {
    res = await fetch(path, {
      method,
      headers,
      body: body ? JSON.stringify(body) : null,
    });
  } catch (netErr) {
    // network-level failure → backend not reachable
    if (USE_MOCK_FALLBACK) {
      if (!MOCK_ACTIVE) { MOCK_ACTIVE = true; toast('데모 모드로 실행 중 (백엔드 미연결)', 'warn'); }
      return mock(path, method, body);
    }
    throw netErr;
  }
  // 404/501/502/503 on an /api/ route means the endpoint isn't wired up yet
  // (backend still being built) → fall back to mock so the UI stays demoable.
  if (USE_MOCK_FALLBACK && path.startsWith('/api/') && [404, 501, 502, 503].includes(res.status)) {
    if (!MOCK_ACTIVE) { MOCK_ACTIVE = true; toast('데모 모드로 실행 중 (백엔드 미연결)', 'warn'); }
    return mock(path, method, body);
  }
  let data = null;
  try { data = await res.json(); } catch { /* non-json */ }
  if (!res.ok) {
    const msg = (data && (data.error || data.message)) || `요청 실패 (${res.status})`;
    throw new Error(msg);
  }
  return data ?? {};
}

/* ---------- MOCK backend (used only when fetch throws) ---------- */
const MOCK = {
  wardrobe: [], // garment filenames
  models: [],   // saved person-photo filenames
};
function mockImg(seed, w = 480, h = 640) {
  // deterministic placeholder image as a data URL (SVG) — no network needed
  const hue = (seed * 47) % 360;
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' width='${w}' height='${h}'>
      <defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'>
        <stop offset='0' stop-color='hsl(${hue},32%,90%)'/>
        <stop offset='1' stop-color='hsl(${(hue + 40) % 360},28%,80%)'/>
      </linearGradient></defs>
      <rect width='100%' height='100%' fill='url(#g)'/>
      <g fill='hsl(${hue},30%,55%)' opacity='.9'>
        <path d='M${w * .3} ${h * .28} h${w * .4} l${w * .12} ${h * .1} l-${w * .1} ${h * .08}
                 v${h * .34} h-${w * .44} v-${h * .34} l-${w * .1} -${h * .08} z'/>
      </g>
      <text x='50%' y='94%' font-family='serif' font-size='${w * .06}' fill='hsl(${hue},25%,45%)'
            text-anchor='middle'>Pikl demo</text>
    </svg>`;
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg.replace(/\s+/g, ' '));
}
// Optional demo seed: append ?__pikl_demo__=N to pre-fill the mock closet
// with N sample garments (only meaningful in mock mode; inert otherwise).
(function seedDemo() {
  const n = parseInt(new URLSearchParams(location.search).get('__pikl_demo__') || '', 10);
  if (n > 0) for (let i = 0; i < n; i++) MOCK.wardrobe.push(`demo_${i}.png`);
})();

async function mock(path, method, body) {
  await new Promise(r => setTimeout(r, 350)); // feel real
  if (path === '/api/login')
    return { token: 'mock-' + Date.now(), nickname: body.nickname, is_admin: /admin|관리/.test(body.nickname) };
  if (path === '/api/wardrobe')
    return { items: MOCK.wardrobe.map(file => ({ file, ref: file, url: wardrobeSrc(file) })) };
  if (path === '/api/scan')
    return { items: [
      { category: 'top',      name: '오버사이즈 니트', description: '차콜 그레이 크루넥 스웨터' },
      { category: 'bottom',   name: '와이드 슬랙스',   description: '아이보리 코튼 와이드 팬츠' },
      { category: 'outer',    name: '울 코트',         description: '카멜 더블브레스트 롱코트' },
      { category: 'shoes',    name: '레더 로퍼',       description: '블랙 페니 로퍼' },
    ], cost: 0.003 };
  if (path === '/api/ingest') {
    const f = `mock_${Date.now()}_${Math.floor(Math.random() * 999)}.png`;
    MOCK.wardrobe.push(f);
    return { file: f, ref: f, url: wardrobeSrc(f), extracted: true, cost: 0.02 };
  }
  if (path === '/api/save') {
    const f = `mock_${Date.now()}.png`;
    MOCK.wardrobe.push(f);
    return { file: f, ref: f, url: wardrobeSrc(f) };
  }
  if (path === '/api/save_person') {
    const f = `mockp_${Date.now()}.jpg`;
    MOCK.models.push(f);
    return { file: f, ref: f, url: wardrobeSrc(f) };
  }
  if (path === '/api/models')
    return { items: MOCK.models.map(file => ({ file, ref: file, url: wardrobeSrc(file) })) };
  if (path === '/api/delete') {
    const key = body.ref || body.file;
    MOCK.wardrobe = MOCK.wardrobe.filter(x => x !== key);
    MOCK.models = MOCK.models.filter(x => x !== key);
    return { ok: true };
  }
  if (path === '/api/generate') {
    const n = (body.images || []).length;
    const url = mockImg(Date.now(), 700, 940);
    return {
      image: url, ref: url, url,
      cost: 0.03, elapsed: 9.4,
      warning: n > 3 ? '옷이 많으면 결과가 부정확할 수 있어요.' : undefined,
    };
  }
  if (path === '/api/feedback') return { ok: true };
  return {};
}

/* resolve a wardrobe filename to a src the <img> can load.
   In mock mode we synthesize an image; otherwise same-origin URL. */
function wardrobeSrc(file) {
  if (MOCK_ACTIVE || String(file).startsWith('mock_')) {
    let seed = 0; for (const c of file) seed += c.charCodeAt(0);
    return mockImg(seed);
  }
  return '/wardrobe/' + encodeURIComponent(file);
}

/* ============================================================
   IMAGE → dataURL (resize longest side ~1024, JPEG q0.92)
   (reused from the original app)
   ============================================================ */
function fileToDataURL(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onerror = reject;
    r.onload = () => {
      const img = new Image();
      img.onerror = reject;
      img.onload = () => {
        const scale = Math.min(1, 1024 / Math.max(img.width, img.height));
        const c = document.createElement('canvas');
        c.width = Math.round(img.width * scale);
        c.height = Math.round(img.height * scale);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        resolve(c.toDataURL('image/jpeg', 0.92));
      };
      img.src = r.result;
    };
    r.readAsDataURL(file);
  });
}

/* ============================================================
   TOASTS
   ============================================================ */
function toast(msg, kind = '', ms = 3200) {
  const t = el('div', 'toast ' + kind, esc(msg));
  $('#toasts').appendChild(t);
  setTimeout(() => {
    t.classList.add('out');
    setTimeout(() => t.remove(), 320);
  }, ms);
}

/* ============================================================
   SCREEN / VIEW ROUTER
   ============================================================ */
function showScreen(id) {
  $$('.screen').forEach(s => s.classList.toggle('active', s.id === id));
  const inApp = id.startsWith('view-');
  $('#tabbar').classList.toggle('on', inApp);
  $('#fbFab').classList.toggle('on', inApp);
  $('#helpBtn').classList.toggle('on', inApp);
  window.scrollTo(0, 0);
}
function switchTab(tab) {
  state.tab = tab;
  showScreen('view-' + tab);
  $$('#tabbar .tab').forEach(t => t.classList.toggle('on', t.dataset.tab === tab));
  if (tab === 'closet') renderCloset();
  if (tab === 'tryon')  renderTryon();
}

/* ============================================================
   1) LOGIN
   ============================================================ */
$('#loginForm').addEventListener('submit', async e => {
  e.preventDefault();
  const nick = $('#nick').value.trim();
  if (!nick) { $('#nick').focus(); return; }
  const btn = $('#loginBtn');
  btn.disabled = true; btn.textContent = '들어가는 중…';
  try {
    const d = await api('/api/login', { method: 'POST', body: { nickname: nick } });
    state.token = d.token;
    state.nickname = d.nickname || nick;
    state.isAdmin = !!d.is_admin;
    localStorage.setItem(LS.token, state.token);
    localStorage.setItem(LS.nick, state.nickname);
    localStorage.setItem(LS.admin, state.isAdmin ? '1' : '');
    enterApp(true);
  } catch (err) {
    toast(err.message || '로그인에 실패했어요', 'err');
    btn.disabled = false; btn.textContent = '시작하기';
  }
});

function enterApp(fresh) {
  applyAdminEntry();
  const seen = localStorage.getItem(LS.onbDone(state.nickname));
  if (!seen) {
    startOnboarding();
  } else {
    const h = (location.hash || '').replace('#', '');
    switchTab(['closet', 'add', 'tryon'].includes(h) ? h : 'closet');
    setTimeout(() => startTour(), 500);
  }
}

/* Admin gets an extra entry point (dashboard itself built elsewhere).
   Shown as a small pill in the closet header. */
function applyAdminEntry() {
  const existing = $('#adminEntry');
  if (!state.isAdmin) { existing?.remove(); return; }
  if (existing) return;
  const head = $('#view-closet .view-head');
  const chip = el('a', 'admin-chip');
  chip.id = 'adminEntry';
  chip.style.cssText = 'display:block;margin:14px 0 0';
  chip.href = '/admin';
  chip.innerHTML = `<span style="display:inline-flex;align-items:center;gap:6px;padding:9px 16px;border-radius:980px;background:#f5f5f7;color:#6e6e73;font-size:13px;font-weight:500;text-decoration:none;border:1px solid rgba(0,0,0,.06)">관리자 대시보드</span>`;
  head.appendChild(chip);
}

/* ============================================================
   2) ONBOARDING (swipeable)
   ============================================================ */
let onbIndex = 0;
function startOnboarding() {
  onbIndex = 0;
  showScreen('onboarding');
  const track = $('#onbTrack');
  const slides = $$('.onb-slide', track);
  // dots
  const dots = $('#onbDots');
  dots.innerHTML = '';
  slides.forEach((_, i) => dots.appendChild(el('span', 'dot' + (i === 0 ? ' on' : ''))));
  track.scrollTo({ left: 0 });
  updateOnb();
}
function updateOnb() {
  const slides = $$('.onb-slide');
  $$('#onbDots .dot').forEach((d, i) => d.classList.toggle('on', i === onbIndex));
  $('#onbNext').textContent = onbIndex >= slides.length - 1 ? '시작하기' : '다음';
}
$('#onbTrack').addEventListener('scroll', () => {
  const track = $('#onbTrack');
  const i = Math.round(track.scrollLeft / track.clientWidth);
  if (i !== onbIndex) { onbIndex = i; updateOnb(); }
});
$('#onbNext').addEventListener('click', () => {
  const track = $('#onbTrack');
  const slides = $$('.onb-slide');
  if (onbIndex >= slides.length - 1) return finishOnboarding();
  onbIndex++;
  track.scrollTo({ left: onbIndex * track.clientWidth, behavior: 'smooth' });
  updateOnb();
});
$('#onbSkip').addEventListener('click', finishOnboarding);
function finishOnboarding() {
  localStorage.setItem(LS.onbDone(state.nickname), '1');
  switchTab('closet');
  setTimeout(() => startTour(), 350);
}

/* ============================================================
   TAB BAR events
   ============================================================ */
$$('#tabbar .tab').forEach(t =>
  t.addEventListener('click', () => switchTab(t.dataset.tab)));

/* ============================================================
   3) ADD flow — scan → extract → save
   ============================================================ */
$('#addZone').addEventListener('click', () => {
  if (!state.addImage) $('#fileAdd').click();
});
$('#fileAdd').addEventListener('change', async e => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  try {
    const url = await fileToDataURL(f);
    state.addImage = url;
    renderAddPreview();
    await runScan();
  } catch (err) { toast('사진을 불러오지 못했어요', 'err'); }
});

function renderAddPreview() {
  const zone = $('#addZone');
  zone.classList.add('hasimg');
  zone.innerHTML =
    `<div class="upload-preview">
       <img src="${state.addImage}" alt="업로드한 사진" />
       <button class="re" id="addRe">다른 사진</button>
       <button class="save-person" id="addSavePerson">이 사진 그대로 저장 (사람)</button>
     </div>`;
  $('#addRe').addEventListener('click', ev => {
    ev.stopPropagation();
    resetAdd();
  });
  $('#addSavePerson').addEventListener('click', async ev => {
    ev.stopPropagation();
    const b = $('#addSavePerson'); b.disabled = true; b.textContent = '저장 중…';
    try {
      // Save the FULL photo as-is to the person-photo collection (no extraction).
      await api('/api/save_person', {
        method: 'POST',
        body: { image: state.addImage, name: `사람_${Date.now()}` },
      });
      toast('내 사진에 저장했어요', 'ok');
      loadModels().catch(() => {});
      b.textContent = '저장됨 ✓';
    } catch (err) {
      b.disabled = false; b.textContent = '이 사진 그대로 저장 (사람)';
      toast(err.message || '저장에 실패했어요', 'err');
    }
  });
}
function resetAdd() {
  state.addImage = null; state.detected = [];
  const zone = $('#addZone');
  zone.classList.remove('hasimg');
  zone.innerHTML =
    `<div class="up-content">
       <div class="up-ico">
         <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
       </div>
       <h3>사진 올리기</h3>
       <p>전신 또는 상반신 사진이 가장 잘 인식돼요</p>
     </div>`;
  $('#addResult').innerHTML = '';
}

async function runScan() {
  const box = $('#addResult');
  box.innerHTML =
    `<div class="section-label">옷을 찾는 중…</div>
     <div class="detected-list">
       ${[0, 1, 2].map(() => `<div class="detect-card"><div class="dc-icon skeleton" style="border-radius:12px"></div><div class="dc-body"><div class="skeleton" style="height:12px;width:40%;border-radius:6px;margin-bottom:8px"></div><div class="skeleton" style="height:14px;width:70%;border-radius:6px"></div></div></div>`).join('')}
     </div>`;
  try {
    const d = await api('/api/scan', { method: 'POST', body: { image: state.addImage } });
    // Backend degrades gracefully: 200 with {items:[], error:"analysis_unavailable"}
    // when the VLM is down — show a friendly notice, not a dev error.
    if (d.error === 'analysis_unavailable') {
      state.detected = [];
      box.innerHTML =
        `<div class="empty"><div class="emo">🛠</div><h3>지금은 자동 분해를 쓸 수 없어요</h3>
         <p>옷 자동 감지 기능이 잠시 쉬고 있어요. 잠시 후 다시 시도해주세요.</p></div>`;
      toast('지금은 자동 분해를 쓸 수 없어요', 'warn');
      return;
    }
    state.detected = (d.items || []).map(it => ({ ...it, status: 'idle' }));
    renderDetected();
  } catch (err) {
    box.innerHTML = '';
    toast(err.message || '옷을 찾지 못했어요', 'err');
  }
}

const CAT_EMOJI = {
  // backend /api/scan returns Korean categories; keep the English keys for the mock.
  '상의': '👕', '하의': '👖', '아우터': '🧥', '원피스': '👗', '신발': '👞',
  '가방': '👜', '모자': '🧢', '액세서리': '🕶',
  top: '👕', bottom: '👖', outer: '🧥', dress: '👗', shoes: '👞', bag: '👜', hat: '🧢', acc: '🕶',
};
function renderDetected() {
  const box = $('#addResult');
  if (!state.detected.length) {
    box.innerHTML = `<div class="empty"><div class="emo">🔍</div><h3>옷을 찾지 못했어요</h3><p>옷이 잘 보이는 다른 사진으로 다시 시도해보세요.</p></div>`;
    return;
  }
  const list = el('div', 'detected-list');
  state.detected.forEach((it, i) => {
    const card = el('div', 'detect-card' + (it.status === 'saved' ? ' saved' : ''));
    card.style.animationDelay = (i * 55) + 'ms';
    const emoji = CAT_EMOJI[String(it.category).toLowerCase()] || '👚';
    let btn;
    if (it.status === 'saved') btn = `<div class="dc-act done">담김 ✓</div>`;
    else if (it.status === 'busy') btn = `<div class="dc-act busy">담는 중…</div>`;
    else btn = `<button class="dc-act" data-i="${i}">담기</button>`;
    // reflect where the saved item came from (착샷 추출 vs 제품컷 그대로)
    const srcTag = it.status === 'saved' && it.extracted != null
      ? `<span class="dc-src">${it.extracted ? '착샷에서 추출' : '제품컷'}</span>` : '';
    card.innerHTML =
      `<div class="dc-icon">${emoji}</div>
       <div class="dc-body">
         <div class="dc-cat">${esc(it.category || '의류')}${srcTag}</div>
         <div class="dc-name">${esc(it.name || '이름 없는 옷')}</div>
         <div class="dc-desc">${esc(it.description || '')}</div>
       </div>${btn}`;
    list.appendChild(card);
  });
  box.innerHTML =
    `<div class="section-label">이런 옷을 찾았어요 <span class="count">${state.detected.length}</span></div>`;
  box.appendChild(list);
  $$('.dc-act[data-i]', box).forEach(b =>
    b.addEventListener('click', () => extractOne(+b.dataset.i)));
}

async function extractOne(i) {
  const it = state.detected[i];
  if (!it || it.status !== 'idle') return;
  it.status = 'busy'; renderDetected();
  const name = it.name || (it.category || 'garment');
  try {
    // Prefer the one-shot ingest endpoint (extract + save). Pass the picked item's
    // identity so the backend extracts THIS garment, not the most-prominent one.
    const d = await api('/api/ingest', {
      method: 'POST',
      body: {
        image: state.addImage,
        name,
        garment: it.category,            // Korean category from /api/scan
        description: it.description,      // per-item English description
      },
    });
    it.status = 'saved';
    it.extracted = !!d.extracted;        // reflect on the saved card (추출 vs 제품컷)
    renderDetected();
    if (d.warning) addQueued('warn', d.warning);
    addQueued('ok', name);
    // refresh the wardrobe cache AND repaint the closet if it's the active tab,
    // so a just-added item shows up immediately (not only after a tab switch).
    loadWardrobe().then(() => {
      const n = state.wardrobe.length;
      const cc = $('#closetCount');
      if (cc) cc.textContent = n ? `모아둔 옷 ${n}벌` : '모아둔 옷들을 한눈에 살펴보세요.';
      if (state.tab === 'closet') renderCloset();
    }).catch(() => {});
  } catch (err) {
    it.status = 'idle'; renderDetected();
    toast(err.message || '담기에 실패했어요', 'err');
  }
}

/* FIX 9a — collapse stacked toasts on multi-add. Instead of one toast per item,
   batch them into a single "N벌 담았어요" (+ a merged warning line if any). */
const _addQueue = { ok: 0, warn: 0, warnMsg: null, timer: null };
function addQueued(kind, payload) {
  if (kind === 'ok') _addQueue.ok += 1;
  else if (kind === 'warn') { _addQueue.warn += 1; _addQueue.warnMsg = payload; }
  clearTimeout(_addQueue.timer);
  _addQueue.timer = setTimeout(flushAddQueue, 650);
}
function flushAddQueue() {
  if (_addQueue.ok > 0) {
    toast(_addQueue.ok === 1 ? '옷장에 담았어요' : `${_addQueue.ok}벌 담았어요`, 'ok');
  }
  if (_addQueue.warn > 0) {
    const m = _addQueue.warn === 1 && _addQueue.warnMsg
      ? _addQueue.warnMsg : `일부 항목은 자동 처리에 제한이 있었어요 (${_addQueue.warn}건)`;
    toast(m, 'warn');
  }
  _addQueue.ok = 0; _addQueue.warn = 0; _addQueue.warnMsg = null; _addQueue.timer = null;
}

/* ============================================================
   4) CLOSET
   ============================================================ */
async function loadWardrobe() {
  const d = await api('/api/wardrobe');
  // Backend returns {items:[{file, ref, url}]}. `url` is directly loadable in <img>;
  // `ref` is the storage reference used for delete / try-on chaining.
  state.wardrobe = (d.items || []).map(it => ({
    file: it.file,
    ref: it.ref,
    url: it.url || wardrobeSrc(it.file),
  }));
  return state.wardrobe;
}
async function loadModels() {
  // saved person/full photos — separate collection from garments (never mixed).
  const d = await api('/api/models');
  state.models = (d.items || []).map(it => ({
    file: it.file,
    ref: it.ref,
    url: it.url || wardrobeSrc(it.file),
  }));
  return state.models;
}

/* segmented toggle in the closet header: 옷 | 내 사진 */
$$('#closetSeg .seg-btn').forEach(b =>
  b.addEventListener('click', () => {
    if (state.closetSeg === b.dataset.seg) return;
    state.closetSeg = b.dataset.seg;
    $$('#closetSeg .seg-btn').forEach(x => x.classList.toggle('on', x === b));
    renderCloset();
  }));

async function renderCloset() {
  // reflect the active segment on the toggle (in case it was set programmatically)
  $$('#closetSeg .seg-btn').forEach(x => x.classList.toggle('on', x.dataset.seg === state.closetSeg));
  if (state.closetSeg === 'models') return renderClosetModels();
  return renderClosetGarments();
}

async function renderClosetGarments() {
  const body = $('#closetBody');
  const banner = $('#closetBanner');
  // skeletons
  body.innerHTML =
    `<div class="closet-grid">${Array.from({ length: 6 }).map(() =>
      `<div class="g-card"><div class="skeleton"></div></div>`).join('')}</div>`;
  try {
    await loadWardrobe();
  } catch (err) {
    body.innerHTML = `<div class="empty"><div class="emo">⚠️</div><h3>옷장을 불러오지 못했어요</h3><p>${esc(err.message)}</p></div>`;
    banner.innerHTML = '';
    return;
  }
  $('#closetCount').textContent = state.wardrobe.length
    ? `모아둔 옷 ${state.wardrobe.length}벌` : '모아둔 옷들을 한눈에 살펴보세요.';
  if (!state.wardrobe.length) {
    body.innerHTML =
      `<div class="empty">
         <div class="emo">🧺</div>
         <h3>옷장이 비어있어요</h3>
         <p>사진을 올려 첫 옷을 추가해보세요. 입고 있는 옷을 자동으로 뽑아 담아드려요.</p>
         <button class="btn accent" id="emptyAdd">사진 올려 옷 담기</button>
       </div>`;
    $('#emptyAdd').addEventListener('click', () => switchTab('add'));
    banner.innerHTML = '';
    renderFeedbackBanner(banner);
    return;
  }
  const grid = el('div', 'closet-grid');
  state.wardrobe.forEach((g, i) => {
    const card = el('div', 'g-card');
    card.style.animationDelay = (i * 40) + 'ms';
    card.innerHTML = `<img loading="lazy" src="${g.url}" alt="옷" />`;
    card.addEventListener('click', () => openGarment(g));
    grid.appendChild(card);
  });
  body.innerHTML = '';
  body.appendChild(grid);
  renderFeedbackBanner(banner);
}

async function renderClosetModels() {
  const body = $('#closetBody');
  const banner = $('#closetBanner');
  body.innerHTML =
    `<div class="closet-grid">${Array.from({ length: 4 }).map(() =>
      `<div class="g-card"><div class="skeleton"></div></div>`).join('')}</div>`;
  try {
    await loadModels();
  } catch (err) {
    body.innerHTML = `<div class="empty"><div class="emo">⚠️</div><h3>내 사진을 불러오지 못했어요</h3><p>${esc(err.message)}</p></div>`;
    banner.innerHTML = '';
    return;
  }
  $('#closetCount').textContent = state.models.length
    ? `모아둔 사진 ${state.models.length}장` : '입혀보기에 쓸 사람 사진을 모아두세요.';
  if (!state.models.length) {
    body.innerHTML =
      `<div class="empty">
         <div class="emo">🧍</div>
         <h3>저장된 사진이 없어요</h3>
         <p>사람 사진을 담아보세요. 입혀보기에서 사진을 저장하면 여기 모여요.</p>
         <button class="btn accent" id="emptyToTryon">입혀보기로 가기</button>
       </div>`;
    $('#emptyToTryon').addEventListener('click', () => switchTab('tryon'));
    banner.innerHTML = '';
    renderFeedbackBanner(banner);
    return;
  }
  const grid = el('div', 'closet-grid');
  state.models.forEach((g, i) => {
    const card = el('div', 'g-card');
    card.style.animationDelay = (i * 40) + 'ms';
    card.innerHTML = `<img loading="lazy" src="${g.url}" alt="사람 사진" />`;
    card.addEventListener('click', () => openModel(g));
    grid.appendChild(card);
  });
  body.innerHTML = '';
  body.appendChild(grid);
  renderFeedbackBanner(banner);
}

function openGarment(g) {
  openSheet(
    `<div class="viewer-img"><img src="${g.url}" alt="옷" /></div>
     <div class="btn-row">
       <button class="btn ghost" id="vClose">닫기</button>
       <button class="btn danger" id="vDel">삭제</button>
     </div>`);
  $('#vClose').addEventListener('click', closeSheet);
  $('#vDel').addEventListener('click', async () => {
    const b = $('#vDel'); b.disabled = true; b.textContent = '삭제 중…';
    try {
      // Delete by storage ref (r2 key or local path); file name alone can't address R2.
      await api('/api/delete', { method: 'POST', body: { ref: g.ref, file: g.file } });
      closeSheet();
      toast('옷을 삭제했어요', 'ok');
      renderCloset();
    } catch (err) {
      b.disabled = false; b.textContent = '삭제';
      toast(err.message || '삭제에 실패했어요', 'err');
    }
  });
}

function openModel(g) {
  openSheet(
    `<div class="viewer-img"><img src="${g.url}" alt="사람 사진" /></div>
     <div class="btn-row">
       <button class="btn ghost" id="mUse">이 사진으로 입혀보기</button>
       <button class="btn danger" id="mDel">삭제</button>
     </div>`);
  $('#mUse').addEventListener('click', () => {
    setPersonFromModel(g);
    closeSheet();
    switchTab('tryon');
    toast('사람 사진을 골랐어요', 'ok');
  });
  $('#mDel').addEventListener('click', async () => {
    const b = $('#mDel'); b.disabled = true; b.textContent = '삭제 중…';
    try {
      await api('/api/delete', { method: 'POST', body: { ref: g.ref, file: g.file } });
      closeSheet();
      toast('사진을 삭제했어요', 'ok');
      renderCloset();
    } catch (err) {
      b.disabled = false; b.textContent = '삭제';
      toast(err.message || '삭제에 실패했어요', 'err');
    }
  });
}

/* ============================================================
   5) TRY-ON
   ============================================================ */
$('#personZone').addEventListener('click', () => {
  if (!state.personImage) $('#filePerson').click();
});
$('#personUploadBtn').addEventListener('click', () => $('#filePerson').click());
$('#personPickBtn').addEventListener('click', openPersonPicker);
$('#filePerson').addEventListener('change', async e => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  try {
    state.personImage = await fileToDataURL(f);
    state.personRef = null;               // fresh upload — not yet a saved model
    renderPersonZone();
  } catch { toast('사진을 불러오지 못했어요', 'err'); }
});

/* person `url` to render (a saved model carries a loadable ref, an upload a dataURL) */
function personDisplaySrc() {
  if (!state.personImage) return null;
  if (state.personImage.startsWith('data:')) return state.personImage;
  return state.personImage;              // saved model: url set alongside the ref
}

/* set the try-on person from a saved model (its url shows, its ref is the source) */
function setPersonFromModel(g) {
  state.personImage = g.url;
  state.personRef = g.ref;
  renderPersonZone();
}

function renderPersonZone() {
  const z = $('#personZone');
  if (!state.personImage) {
    z.classList.remove('hasimg');
    z.innerHTML =
      `<div class="ph">
         <div class="up-ico"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg></div>
         사진 올리기
       </div>`;
    return;
  }
  z.classList.add('hasimg');
  // "저장" is offered only for a FRESH upload (a dataURL that isn't already a saved model).
  const canSave = state.personImage.startsWith('data:') && !state.personRef;
  const saveBtn = canSave
    ? `<button class="save" id="personSave"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>저장</button>`
    : '';
  z.innerHTML =
    `<img src="${esc(personDisplaySrc())}" alt="사람 사진" />
     <button class="re" id="personRe">변경</button>${saveBtn}`;
  $('#personRe').addEventListener('click', ev => {
    ev.stopPropagation();
    state.personImage = null; state.personRef = null; renderPersonZone();
  });
  if (canSave) {
    $('#personSave').addEventListener('click', async ev => {
      ev.stopPropagation();
      const b = $('#personSave'); b.disabled = true;
      try {
        await api('/api/save_person', {
          method: 'POST',
          body: { image: state.personImage, name: `사람_${Date.now()}` },
        });
        toast('내 사진에 저장했어요', 'ok');
        loadModels().catch(() => {});     // refresh the models cache
        b.innerHTML = '저장됨 ✓';
      } catch (err) {
        b.disabled = false;
        toast(err.message || '저장에 실패했어요', 'err');
      }
    });
  }
}

/* picker sheet: choose a saved person photo as the try-on person */
async function openPersonPicker() {
  openSheet(
    `<h2>내 사진에서 선택</h2>
     <p class="sub">저장해둔 사람 사진을 골라 입혀보기의 사람으로 써요.</p>
     <div id="personPickGrid">
       <div class="closet-grid">${Array.from({ length: 4 }).map(() =>
         `<div class="g-card"><div class="skeleton"></div></div>`).join('')}</div>
     </div>`);
  const grid = $('#personPickGrid');
  try {
    await loadModels();
  } catch (err) {
    grid.innerHTML = `<div class="empty"><div class="emo">⚠️</div><h3>사진을 불러오지 못했어요</h3><p>${esc(err.message)}</p></div>`;
    return;
  }
  if (!state.models.length) {
    grid.innerHTML =
      `<div class="empty" style="padding:36px 20px">
         <div class="emo">🧍</div>
         <h3>저장된 사진이 없어요</h3>
         <p>사람 사진을 담아보세요. 사진을 올린 뒤 "저장"을 누르면 여기 모여요.</p>
       </div>`;
    return;
  }
  const g = el('div', 'closet-grid');
  state.models.forEach(m => {
    const card = el('div', 'g-card');
    card.innerHTML = `<img loading="lazy" src="${m.url}" alt="사람 사진" />`;
    card.addEventListener('click', () => {
      setPersonFromModel(m);
      closeSheet();
      toast('사람 사진을 골랐어요', 'ok');
    });
    g.appendChild(card);
  });
  grid.innerHTML = '';
  grid.appendChild(g);
}

async function renderTryon() {
  renderPersonZone();
  const pickBody = $('#pickBody');
  pickBody.innerHTML = `<div class="pick-strip">${Array.from({ length: 4 }).map(() =>
    `<div class="pick-thumb"><div class="skeleton" style="width:100%;height:100%"></div></div>`).join('')}</div>`;
  try { await loadWardrobe(); } catch { /* keep going */ }
  // drop picks that no longer exist
  state.picks = state.picks.filter(f => state.wardrobe.some(g => g.file === f));
  renderPickStrip();
  renderTryonCTA();
  renderFeedbackBanner($('#tryonBanner'));
}
function renderPickStrip() {
  const pickBody = $('#pickBody');
  if (!state.wardrobe.length) {
    pickBody.innerHTML =
      `<div class="empty" style="padding:32px 20px">
         <div class="emo">🧥</div>
         <p>옷장에 옷이 없어요. 먼저 옷을 추가해주세요.</p>
         <button class="btn accent" id="toAdd2" style="max-width:200px">옷 추가하러 가기</button>
       </div>`;
    $('#toAdd2').addEventListener('click', () => switchTab('add'));
    return;
  }
  const strip = el('div', 'pick-strip');
  state.wardrobe.forEach(g => {
    const idx = state.picks.indexOf(g.file);
    const thumb = el('div', 'pick-thumb' + (idx >= 0 ? ' sel' : ''));
    thumb.innerHTML = `<img src="${g.url}" alt="옷" /><span class="num">${idx + 1}</span>`;
    thumb.addEventListener('click', () => togglePick(g.file));
    strip.appendChild(thumb);
  });
  pickBody.innerHTML = '';
  pickBody.appendChild(strip);
  $('#pickCount').textContent = `${state.picks.length} / 4`;
}
function togglePick(file) {
  const i = state.picks.indexOf(file);
  if (i >= 0) state.picks.splice(i, 1);
  else {
    if (state.picks.length >= 4) {
      toast('한 번에 최대 4벌까지 입혀볼 수 있어요', 'warn');
      return;
    }
    state.picks.push(file);
  }
  renderPickStrip();
  renderTryonCTA();
}
function renderTryonCTA() {
  // remove any prior sticky CTA
  $('#tryonCTA')?.remove();
  if (!state.wardrobe.length) return;
  const ready = state.personImage && state.picks.length >= 1;
  const bar = el('div', 'sticky-cta');
  bar.id = 'tryonCTA';
  bar.innerHTML = `<button class="btn accent block" id="doTryon" ${ready ? '' : 'disabled'}>
      ${state.picks.length ? `${state.picks.length}벌 입혀보기` : '옷을 골라주세요'}
    </button>`;
  $('#view-tryon').appendChild(bar);
  $('#doTryon').addEventListener('click', doTryon);
}

async function doTryon() {
  if (!state.personImage) { toast('먼저 사람 사진을 올려주세요', 'warn'); return; }
  if (!state.picks.length) { toast('입힐 옷을 골라주세요', 'warn'); return; }
  // Wardrobe garments are passed as storage refs — the backend's resolve_img()
  // turns them back into image bytes. The person is either a freshly-uploaded
  // dataURL, or a SAVED MODEL passed by its storage ref (resolve_img handles both).
  const garmentRefs = state.picks.map(f => {
    const g = state.wardrobe.find(x => x.file === f);
    return g.ref || g.url;
  });
  const person = state.personRef || state.personImage;
  const images = [person, ...garmentRefs];

  startGen('입혀보는 중', '옷을 입히고 있어요');
  try {
    const d = await api('/api/generate', {
      method: 'POST',
      body: {
        prompt: '이 사람에게 선택한 옷을 자연스럽게 입혀줘',
        images,
        aspect: '3:4',
        analyze: state.picks.length,   // combine: analyze=garmentCount
      },
    });
    stopGen();
    if (d.warning) showTryonWarn(d.warning);
    // d.url is directly loadable; d.ref is the storage ref for chaining into /api/save.
    showTryonResult(d.url || d.image, d.ref || d.image);
  } catch (err) {
    stopGen();
    toast(err.message || '입혀보기에 실패했어요', 'err');
  }
}

function showTryonWarn(msg) {
  $('#tryonWarn').innerHTML =
    `<div class="warn-note"><span>⚠️</span><span>${esc(msg)}</span></div>`;
}
function showTryonResult(imgUrl, imgRef) {
  const box = $('#tryonResult');
  box.innerHTML =
    `<div class="section-label" style="margin-top:24px">결과</div>
     <div class="tryon-result"><img src="${esc(imgUrl)}" alt="입혀본 결과" /></div>
     <div class="btn-row" style="margin-top:16px">
       <button class="btn ghost" id="tryAgain">다시</button>
       <button class="btn accent" id="saveResult">옷장에 저장</button>
     </div>`;
  box.scrollIntoView({ behavior: 'smooth', block: 'center' });
  $('#tryAgain').addEventListener('click', () => { box.innerHTML = ''; $('#tryonWarn').innerHTML = ''; });
  $('#saveResult').addEventListener('click', async () => {
    const b = $('#saveResult'); b.disabled = true; b.textContent = '저장 중…';
    try {
      // Prefer the storage ref (resolve_img handles it); fall back to re-encoding the URL.
      const image = imgRef || await urlToDataURL(imgUrl);
      await api('/api/save', { method: 'POST', body: { image, name: `코디_${Date.now()}` } });
      toast('옷장에 저장했어요', 'ok');
      b.textContent = '저장됨 ✓';
    } catch (err) {
      b.disabled = false; b.textContent = '옷장에 저장';
      toast(err.message || '저장에 실패했어요', 'err');
    }
  });
}

/* convert a remote/url image to dataURL for re-submission/saving */
async function urlToDataURL(url) {
  if (url.startsWith('data:')) return url;
  try {
    const res = await fetch(url);
    const blob = await res.blob();
    return await new Promise((res2, rej) => {
      const fr = new FileReader();
      fr.onload = () => res2(fr.result);
      fr.onerror = rej;
      fr.readAsDataURL(blob);
    });
  } catch {
    // cross-origin / mock: just pass the url through (backend may accept refs)
    return url;
  }
}

/* ============================================================
   GENERATING OVERLAY — tasteful ~10s progress
   ============================================================ */
const GEN_STEPS = [
  '사진을 살펴보는 중…',
  '옷을 정돈하는 중…',
  '자연스럽게 입히는 중…',
  '마지막 손질 중…',
];
let genTimer = null, genStart = 0;
function startGen(title, firstStep) {
  const o = $('#genOverlay');
  $('#genTitle').textContent = title;
  $('#genStep').textContent = firstStep || GEN_STEPS[0];
  o.classList.add('on');
  genStart = Date.now();
  const CIRC = 2 * Math.PI * 35; // ~220
  const prog = $('#genProg');
  prog.style.strokeDasharray = CIRC;
  const EST = 11000; // expected ~10-11s
  clearInterval(genTimer);
  genTimer = setInterval(() => {
    const t = Date.now() - genStart;
    // ease toward 92% so it never "finishes" before the response
    const pct = Math.min(92, 92 * (1 - Math.exp(-t / (EST * .45))));
    prog.style.strokeDashoffset = CIRC * (1 - pct / 100);
    $('#genPct').textContent = Math.round(pct) + '%';
    const si = Math.min(GEN_STEPS.length - 1, Math.floor(t / (EST / GEN_STEPS.length)));
    $('#genStep').textContent = GEN_STEPS[si];
  }, 200);
}
function stopGen() {
  clearInterval(genTimer);
  const prog = $('#genProg');
  const CIRC = 2 * Math.PI * 35;
  prog.style.strokeDashoffset = 0;
  $('#genPct').textContent = '100%';
  setTimeout(() => $('#genOverlay').classList.remove('on'), 260);
}

/* ============================================================
   6) FEEDBACK — banner + fab + modal
   ============================================================ */
function renderFeedbackBanner(target) {
  if (!target) return;
  target.className = 'fb-banner';
  target.innerHTML =
    `<div class="fb-heart">🫶</div>
     <div class="fb-copy">
       <strong>픽클을 함께 만들어요</strong>
       <span>피드백을 남겨주시면 픽클 정식 배포에 큰 도움이 됩니다 🫶</span>
     </div>
     <button class="fb-go">남기기</button>`;
  target.querySelector('.fb-go').addEventListener('click', openFeedback);
  target.style.cursor = 'pointer';
  target.onclick = e => { if (e.target === target || e.target.closest('.fb-copy') || e.target.closest('.fb-heart')) openFeedback(); };
}

const fab = $('#fbFab');
fab.addEventListener('click', openFeedback);
// occasionally expand the fab label to draw the eye (warm, not spammy)
function pulseFab() {
  if (!fab.classList.contains('on')) return;
  fab.classList.add('expand');
  setTimeout(() => fab.classList.remove('expand'), 3400);
}
setInterval(pulseFab, 14000);
setTimeout(pulseFab, 2600);

function openFeedback() {
  openSheet(
    `<h2>픽클, 어떠셨어요? 🫶</h2>
     <p class="sub">솔직한 한마디가 픽클 정식 배포에 큰 힘이 됩니다.<br>좋았던 점도, 아쉬운 점도 편하게 남겨주세요.</p>
     <textarea id="fbText" placeholder="예) 옷 추출이 생각보다 정확해서 놀랐어요! 다만 …" maxlength="1000"></textarea>
     <button class="btn accent" id="fbSubmit">보내기</button>`);
  const ta = $('#fbText');
  setTimeout(() => ta.focus(), 250);
  $('#fbSubmit').addEventListener('click', async () => {
    const message = ta.value.trim();
    if (!message) { ta.focus(); toast('내용을 입력해주세요', 'warn'); return; }
    const b = $('#fbSubmit'); b.disabled = true; b.textContent = '보내는 중…';
    try {
      await api('/api/feedback', { method: 'POST', body: { message } });
      $('#sheet').innerHTML =
        `<div class="sheet-grip"></div>
         <div class="fb-thanks">
           <div class="big">💌</div>
           <h2 class="serif">고맙습니다!</h2>
           <p>소중한 의견 잘 받았어요. 더 좋은 픽클로 보답할게요.</p>
           <button class="btn accent" id="fbDone" style="margin-top:22px">닫기</button>
         </div>`;
      $('#fbDone').addEventListener('click', closeSheet);
    } catch (err) {
      b.disabled = false; b.textContent = '보내기';
      toast(err.message || '전송에 실패했어요', 'err');
    }
  });
}

/* ============================================================
   7) HELP CHAT — support-agent assistant (/api/chat)
   Keeps the running conversation in state.chat.messages and POSTs
   the FULL array each turn (the server prepends the system prompt).
   ============================================================ */
const CHAT_GREETING =
  '안녕하세요! 옷 추출·입히기·옷장 쓰다가 막히면 물어보세요. 무엇이든 도와드릴게요.';
const CHAT_SUGGESTIONS = [
  '입히기 어떻게 해요?',
  '방금 왜 실패했어요?',
  '내 옷장 보여줘',
];

function openChat() {
  $('#chatScrim').classList.add('on');
  if (!state.chat.greeted) {
    renderChatThread();      // paints greeting + suggestion chips
    state.chat.greeted = true;
  }
  setTimeout(() => { $('#chatInput').focus(); scrollChatToBottom(); }, 260);
}
function closeChat() { $('#chatScrim').classList.remove('on'); }

/* render a single message bubble (does not touch state) */
function appendChatBubble(role, content) {
  const thread = $('#chatThread');
  const wrap = el('div', 'msg ' + (role === 'user' ? 'me' : 'bot'));
  const bubble = el('div', 'bubble');
  bubble.textContent = content;   // textContent → safe, preserves \n via white-space:pre-wrap
  wrap.appendChild(bubble);
  thread.appendChild(wrap);
  scrollChatToBottom();
  return wrap;
}

/* full repaint: greeting + chips (once) + every message in state */
function renderChatThread() {
  const thread = $('#chatThread');
  thread.innerHTML = '';
  appendChatBubble('assistant', CHAT_GREETING);
  const chips = el('div', 'chat-chips');
  // local action — replays the coach-mark tour, no API call
  const replay = el('button', 'chat-chip');
  replay.type = 'button';
  replay.textContent = '📖 사용법 다시 보기';
  replay.addEventListener('click', () => { closeChat(); setTimeout(() => startTour(true), 300); });
  chips.appendChild(replay);
  CHAT_SUGGESTIONS.forEach(q => {
    const chip = el('button', 'chat-chip');
    chip.type = 'button';
    chip.textContent = q;
    chip.addEventListener('click', () => { if (!state.chat.busy) sendChat(q); });
    chips.appendChild(chip);
  });
  thread.appendChild(chips);
  state.chat.messages.forEach(m => appendChatBubble(m.role, m.content));
  scrollChatToBottom();
}

function scrollChatToBottom() {
  const thread = $('#chatThread');
  requestAnimationFrame(() => { thread.scrollTop = thread.scrollHeight; });
}

/* typing indicator (three dots) — returned node is removed on reply */
function showChatTyping() {
  const thread = $('#chatThread');
  const wrap = el('div', 'msg bot typing');
  wrap.id = 'chatTyping';
  wrap.innerHTML =
    `<div class="bubble"><span class="typing-dot"></span><span class="typing-dot"></span><span class="typing-dot"></span></div>`;
  thread.appendChild(wrap);
  scrollChatToBottom();
  return wrap;
}
function removeChatTyping() { $('#chatTyping')?.remove(); }

function setChatBusy(busy) {
  state.chat.busy = busy;
  const send = $('#chatSend');
  const input = $('#chatInput');
  input.disabled = busy;
  // send enabled only when idle AND there's text
  send.disabled = busy || !input.value.trim();
}

async function sendChat(text) {
  const msg = (text != null ? text : $('#chatInput').value).trim();
  if (!msg || state.chat.busy) return;

  // append + render the user's message, then reset the input
  state.chat.messages.push({ role: 'user', content: msg });
  appendChatBubble('user', msg);
  const input = $('#chatInput');
  input.value = '';
  input.style.height = 'auto';
  setChatBusy(true);
  showChatTyping();

  try {
    const d = await api('/api/chat', {
      method: 'POST',
      // send the FULL running conversation; server adds the system role.
      body: { messages: state.chat.messages },
    });
    removeChatTyping();
    const reply = (d && d.reply) || '죄송해요, 방금 답변을 정리하지 못했어요. 다시 한 번 물어봐 주시겠어요?';
    state.chat.messages.push({ role: 'assistant', content: reply });
    appendChatBubble('assistant', reply);
    // degraded (OpenRouter down) still carries a friendly reply — just show it.
  } catch (err) {
    removeChatTyping();
    // never surface a raw error into the thread; a gentle bubble + toast.
    const fallback = '지금은 답변을 불러오지 못했어요. 잠시 후 다시 시도해주세요.';
    appendChatBubble('assistant', fallback);
    toast('도우미 연결이 잠시 불안정해요', 'warn');
  } finally {
    setChatBusy(false);
    input.focus();
  }
}

/* wire up the entry point + panel controls */
$('#helpBtn').addEventListener('click', openChat);
$('#chatClose').addEventListener('click', closeChat);
$('#chatScrim').addEventListener('click', e => { if (e.target.id === 'chatScrim') closeChat(); });
$('#chatSend').addEventListener('click', () => sendChat());
(function initChatInput() {
  const input = $('#chatInput');
  // enable/disable send as the user types
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 120) + 'px';
    if (!state.chat.busy) $('#chatSend').disabled = !input.value.trim();
  });
  // Enter (or ⌘/Ctrl+Enter) sends; Shift+Enter makes a newline
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && (!e.shiftKey || e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      sendChat();
    }
  });
})();

/* ============================================================
   8) FEATURE TOUR — one-time coach-mark walkthrough.
   Pure client-side (no API/LLM calls). Shown once per nickname
   (localStorage), replayable from the help sheet.
   ============================================================ */
const TOUR_STEPS = [
  { tab: 'closet', target: '#tabbar', place: 'above',
    title: '세 탭이 전부예요',
    body: '옷장 · 추가 · 입혀보기. 30초면 다 둘러볼 수 있어요.' },
  { tab: 'closet', target: '#closetSeg',
    title: '옷장',
    body: '모은 옷은 "옷"에, 입혀보기에 쓸 사람 사진은 "내 사진"에 모여요. 카드를 누르면 크게 보거나 지울 수 있어요.' },
  { tab: 'add', target: '#addZone',
    title: '사진 한 장으로 옷 담기',
    body: '사진을 올리면 입고 있는 옷을 자동으로 찾아줘요. 찾은 옷 옆 "담기"를 누르면 옷장에 저장돼요.' },
  { tab: 'tryon', target: ['#personZone', '#personSrc'],
    title: '입혀보기 ① 사람 사진',
    body: '새 사진을 올리거나, 저장해둔 "내 사진"에서 골라요.' },
  { tab: 'tryon', target: '#pickBody',
    title: '입혀보기 ② 옷 고르기',
    body: '옷장에 담아둔 옷이 여기 보여요. 최대 4벌까지 골라 한 번에 입혀볼 수 있어요.' },
  { tab: 'tryon', target: '#tryonCTA',
    title: '입혀보기 ③ 실행',
    body: '사람과 옷을 고르면 아래 "입혀보기" 버튼이 켜져요. 10초 정도면 완성! 결과가 마음에 들면 옷장에 저장할 수도 있어요.' },
  { target: '#helpBtn',
    title: '막히면 언제든',
    body: '궁금한 게 생기면 도우미에게 물어보세요. 이 사용법도 여기서 다시 볼 수 있어요.' },
  { title: '준비 끝!',
    body: '사진 한 장이면 바로 시작할 수 있어요. 지금 첫 옷을 담아볼까요?',
    cta: '사진 올려 옷 담기', ctaTab: 'add' },
];

const tour = { on: false, i: 0, placed: false };

function startTour(force) {
  if (tour.on) return;
  if (!force && localStorage.getItem(LS.tourDone(state.nickname))) return;
  tour.on = true; tour.placed = false;
  document.body.classList.add('tour-lock');
  $('#tour').classList.add('on');
  showTourStep(0);
}
function endTour() {
  tour.on = false;
  document.body.classList.remove('tour-lock');
  $('#tour').classList.remove('on');
  if (state.nickname) localStorage.setItem(LS.tourDone(state.nickname), '1');
}

function showTourStep(i) {
  const s = TOUR_STEPS[i];
  tour.i = i;
  if (s.tab && state.tab !== s.tab) switchTab(s.tab);
  $('#tourNum').textContent = `${i + 1} / ${TOUR_STEPS.length}`;
  $('#tourTitle').textContent = s.title;
  $('#tourBody').textContent = s.body;
  $('#tourPrev').style.visibility = i === 0 ? 'hidden' : 'visible';
  $('#tourNext').textContent = s.cta || (i === TOUR_STEPS.length - 1 ? '시작하기' : '다음');
  // place after the tab switch paints; re-place once for late async layout
  requestAnimationFrame(() => requestAnimationFrame(() => placeTour(s)));
  setTimeout(() => { if (tour.on && tour.i === i) placeTour(s); }, 450);
}

function placeTour(s) {
  if (!tour.on) return;
  const hole = $('#tourHole'), card = $('#tourCard');
  const appRect = $('#app').getBoundingClientRect();
  const vw = window.innerWidth, vh = window.innerHeight;

  const els = (s.target ? [].concat(s.target) : []).map(sel => $(sel)).filter(Boolean);
  // bring in-flow targets on screen before measuring (fixed ones never move)
  const first = els[0];
  if (first && getComputedStyle(first).position !== 'fixed') {
    const r = first.getBoundingClientRect();
    if (r.top < 70 || r.bottom > vh - 90) first.scrollIntoView({ block: 'center' });
  }
  const rects = els.map(n => n.getBoundingClientRect()).filter(r => r.width > 1 && r.height > 1);

  // card width before reading its height
  const cw = Math.min(appRect.width - 32, 340);
  card.style.width = cw + 'px';
  const ch = card.offsetHeight;

  const firstPlace = !tour.placed;
  if (firstPlace) { hole.style.transition = 'none'; card.style.transition = 'none'; }

  let holeT, holeL, holeW, holeH;
  if (!rects.length) {
    // finale / missing target — hole collapses to a point → full dim
    holeT = vh / 2; holeL = vw / 2; holeW = 0; holeH = 0;
    hole.classList.add('none');
  } else {
    hole.classList.remove('none');
    const pad = 8;
    holeT = Math.min(...rects.map(r => r.top)) - pad;
    holeL = Math.min(...rects.map(r => r.left)) - pad;
    holeW = Math.max(...rects.map(r => r.right)) + pad - holeL;
    holeH = Math.max(...rects.map(r => r.bottom)) + pad - holeT;
  }
  hole.style.top = holeT + 'px';
  hole.style.left = holeL + 'px';
  hole.style.width = holeW + 'px';
  hole.style.height = holeH + 'px';

  // card: below the hole when there's room, above when not, centered otherwise
  const gap = 14;
  let top;
  if (!rects.length) top = (vh - ch) / 2;
  else if (s.place === 'above' || (vh - (holeT + holeH) < ch + gap + 16 && holeT > ch + gap + 16))
    top = holeT - gap - ch;
  else top = holeT + holeH + gap;
  top = Math.max(16, Math.min(top, vh - ch - 16));
  let left = rects.length ? holeL + holeW / 2 - cw / 2 : appRect.left + (appRect.width - cw) / 2;
  left = Math.max(appRect.left + 16, Math.min(left, appRect.right - cw - 16));
  card.style.top = top + 'px';
  card.style.left = left + 'px';

  if (firstPlace) {
    tour.placed = true;
    requestAnimationFrame(() => { hole.style.transition = ''; card.style.transition = ''; });
  }
}

$('#tourNext').addEventListener('click', () => {
  const s = TOUR_STEPS[tour.i];
  if (tour.i >= TOUR_STEPS.length - 1) {
    endTour();
    if (s.ctaTab) switchTab(s.ctaTab);
    return;
  }
  showTourStep(tour.i + 1);
});
$('#tourPrev').addEventListener('click', () => { if (tour.i > 0) showTourStep(tour.i - 1); });
$('#tourSkip').addEventListener('click', endTour);
// tapping the dim (or the spotlighted area) also advances
$('#tour').addEventListener('click', e => {
  if (e.target.id === 'tour' || e.target.id === 'tourHole') $('#tourNext').click();
});
window.addEventListener('resize', () => { if (tour.on) placeTour(TOUR_STEPS[tour.i]); });
window.addEventListener('keydown', e => { if (e.key === 'Escape' && tour.on) endTour(); });

/* ============================================================
   SHEET / MODAL primitives
   ============================================================ */
function openSheet(html) {
  $('#sheet').innerHTML = `<div class="sheet-grip"></div>` + html;
  $('#scrim').classList.add('on');
}
function closeSheet() { $('#scrim').classList.remove('on'); }
$('#scrim').addEventListener('click', e => { if (e.target.id === 'scrim') closeSheet(); });

/* ============================================================
   BOOT
   ============================================================ */
function boot() {
  const token = localStorage.getItem(LS.token);
  const nick = localStorage.getItem(LS.nick);
  if (token && nick) {
    state.token = token;
    state.nickname = nick;
    state.isAdmin = localStorage.getItem(LS.admin) === '1';
    enterApp(false);
  } else {
    showScreen('login');
    // surface admin entry only if a prior admin session hinted it
    if (localStorage.getItem(LS.admin) === '1') $('#adminChip').style.display = 'block';
    setTimeout(() => $('#nick').focus(), 400);
  }
}
boot();
