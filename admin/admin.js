/* 픽클(Pikl) 관리자 대시보드 — 프론트엔드 로직
 * ─────────────────────────────────────────────
 * 데이터 소스 스위치:
 *   USE_MOCK = true  → 아래 MOCK 데이터로 렌더 (백엔드 없이 시각 개발)
 *   USE_MOCK = false → 실제 fetch()로 백엔드 /api/admin/* 호출
 * 백엔드가 붙으면 USE_MOCK만 false로 바꾸면 됨. api()가 두 경로를 모두 처리.
 */
const USE_MOCK = false;  // integrated build hits the real /api/admin/* (flip true for offline demo)

// 관리자 토큰: POST /api/login {nickname} → {token, is_admin:true} 로 발급받아
// localStorage('pikl_admin_token')에 저장돼 있다고 가정. (consumer 앱 로그인 흐름 재사용)
const TOKEN_KEY = 'pikl_admin_token';
const NICK_KEY  = 'pikl_admin_nick';
// The consumer app (served at /) logs the owner in and stores the token in
// pikl_token / pikl_nick. The dashboard is reached from that app on the same
// origin, so reuse those if a dedicated admin token wasn't set separately.
function getToken() { return localStorage.getItem(TOKEN_KEY) || localStorage.getItem('pikl_token') || ''; }
function getNick()  { return localStorage.getItem(NICK_KEY) || localStorage.getItem('pikl_nick') || (USE_MOCK ? 'owner' : ''); }

/* ============================ API 계층 ============================ */
/** 실제 백엔드 호출. 401/403이면 게이트 표시. */
async function apiReal(path) {
  const res = await fetch(path, {
    headers: { 'Authorization': 'Bearer ' + getToken() },
  });
  if (res.status === 401 || res.status === 403) {
    showGate();
    throw new Error('unauthorized');
  }
  if (!res.ok) throw new Error('http ' + res.status);
  return res.json();
}

/** 모의 응답. 실제 API 스키마와 1:1로 맞춰 둠 → USE_MOCK 끄면 그대로 대체. */
async function apiMock(path) {
  await new Promise(r => setTimeout(r, 220)); // 네트워크 지연 흉내
  if (path === '/api/admin/overview') return MOCK.overview;
  if (path === '/api/admin/users')    return MOCK.users;
  if (path === '/api/admin/feedback') return MOCK.feedback;
  throw new Error('unknown path ' + path);
}

const api = USE_MOCK ? apiMock : apiReal;

/* ============================ 유틸 ============================ */
const $ = (s, el = document) => el.querySelector(s);
const fmt = n => (n == null ? '—' : n.toLocaleString('ko-KR'));
const usd = n => '$' + (n ?? 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct = n => (n == null ? '—' : (n * 100).toFixed(0) + '%');

function daysAgo(iso) {
  const d = (Date.now() - new Date(iso).getTime()) / 86400000;
  if (d < 1)  return '오늘';
  if (d < 2)  return '어제';
  return Math.floor(d) + '일 전';
}
function fmtDateTime(iso) {
  const d = new Date(iso);
  const p = x => String(x).padStart(2, '0');
  return `${d.getFullYear()}.${p(d.getMonth()+1)}.${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function fmtDate(iso) {
  const d = new Date(iso);
  const p = x => String(x).padStart(2, '0');
  return `${d.getFullYear()}.${p(d.getMonth()+1)}.${p(d.getDate())}`;
}

/* 리텐션 셀 색상: 0 → 어두운 회색, 1 → 초록. 파랑 그라데이션 경유. */
function retentionColor(v) {
  if (v == null) return 'transparent';
  const stops = [
    [0.00, [27, 33, 48]],
    [0.25, [47, 74, 107]],
    [0.50, [61, 111, 176]],
    [0.75, [79, 159, 224]],
    [1.00, [79, 209, 139]],
  ];
  let a = stops[0], b = stops[stops.length - 1];
  for (let i = 0; i < stops.length - 1; i++) {
    if (v >= stops[i][0] && v <= stops[i + 1][0]) { a = stops[i]; b = stops[i + 1]; break; }
  }
  const t = (v - a[0]) / (b[0] - a[0] || 1);
  const c = a[1].map((ch, i) => Math.round(ch + (b[1][i] - ch) * t));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}
/* 밝은 셀은 어두운 글자, 어두운 셀은 밝은 글자. */
function cellTextColor(v) {
  return v >= 0.35 ? '#0d0f14' : 'rgba(232,234,240,.85)';
}

/* ============================ 렌더러 ============================ */
function renderOverview(o) {
  const cards = [
    { k: '총 유저',      v: fmt(o.totalUsers), sub: `오늘 신규 +${fmt(o.newToday)}`, accent: true },
    { k: 'DAU / WAU / MAU', v: `${fmt(o.dau)}<small> / ${fmt(o.wau)} / ${fmt(o.mau)}</small>`, sub: '일·주·월 활성 유저' },
    { k: '총 생성 수',   v: fmt(o.totalGenerations), sub: `실패 ${fmt(o.totalFailures)}건 포함` },
    { k: '실패율',       v: pct(o.failRate), cls: o.failRate > 0.15 ? 'bad' : o.failRate > 0.07 ? 'warn' : 'good', sub: '생성 대비 실패 비율' },
    { k: '총 소비액',    v: usd(o.totalSpendUsd), sub: '베타 기간 누적' },
    { k: '오늘 소비액',  v: usd(o.spendTodayUsd), sub: '금일 누적' },
    { k: '유저당 평균 생성', v: fmt(Math.round(o.totalGenerations / Math.max(o.totalUsers, 1))), sub: '총 생성 / 총 유저' },
    { k: '유저당 평균 소비', v: usd(o.totalSpendUsd / Math.max(o.totalUsers, 1)), sub: '총 소비 / 총 유저' },
  ];
  $('#cards').innerHTML = cards.map(c => `
    <div class="card ${c.accent ? 'accent' : ''}">
      <div class="k">${c.k}</div>
      <div class="v ${c.cls || ''}">${c.v}</div>
      <div class="sub">${c.sub}</div>
    </div>`).join('');
}

function renderCohort(cohorts) {
  const maxWeeks = Math.max(0, ...cohorts.map(c => c.retention.length));
  const head = ['<th class="rowhead">가입 주차</th>']
    .concat(Array.from({ length: maxWeeks }, (_, i) => `<th>+${i}주</th>`)).join('');

  const rows = cohorts.map(c => {
    const cells = Array.from({ length: maxWeeks }, (_, i) => {
      const v = c.retention[i];
      if (v == null) return `<td><div class="cell empty"></div></td>`;
      return `<td><div class="cell ${i === 0 ? 'wk0' : ''}"
        style="background:${retentionColor(v)};color:${cellTextColor(v)}"
        title="${c.cohortWeek} · +${i}주: ${pct(v)}">${pct(v)}</div></td>`;
    }).join('');
    return `<tr>
      <td class="rowhead">${fmtDate(c.cohortWeek)}<span class="size">${fmt(c.size)}명</span></td>
      ${cells}
    </tr>`;
  }).join('');

  $('#cohort').innerHTML = `
    <table class="cohort"><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>
    <div class="legend"><span>낮음</span><div class="bar"></div><span>높음 (재방문율)</span></div>`;
}

/* ---- User table (정렬 가능) ---- */
const COLS = [
  { key: 'nickname',      label: '닉네임',    num: false },
  { key: 'generations',   label: '생성수',    num: true },
  { key: 'fails',         label: '실패수',    num: true },
  { key: 'retries',       label: '재시도수',  num: true },
  { key: 'totalSpendUsd', label: '총 소비액', num: true },
  { key: 'firstSeen',     label: '첫 방문',   num: true, date: true },
  { key: 'lastSeen',      label: '마지막 방문', num: true, date: true },
  { key: 'daysActive',    label: '활동일수',  num: true },
];
let userState = { rows: [], sortKey: 'lastSeen', dir: -1 };

function powerLevel(u) {
  if (u.generations >= 30 && u.daysActive >= 3) return 'power';
  if (u.generations <= 1 && u.daysActive <= 1) return 'once';
  return '';
}

function renderUsers() {
  const { rows, sortKey, dir } = userState;
  const col = COLS.find(c => c.key === sortKey);
  const sorted = [...rows].sort((a, b) => {
    let av = a[sortKey], bv = b[sortKey];
    if (col.date) { av = new Date(av).getTime(); bv = new Date(bv).getTime(); }
    if (typeof av === 'string') return dir * av.localeCompare(bv, 'ko');
    return dir * (av - bv);
  });

  const thead = COLS.map(c => {
    const active = c.key === sortKey;
    const arrow = active ? `<span class="arrow">${dir < 0 ? '▼' : '▲'}</span>` : '';
    return `<th class="sortable" data-key="${c.key}">${c.label}${arrow}</th>`;
  }).join('');

  const tbody = sorted.map(u => {
    const lvl = powerLevel(u);
    const badge = lvl === 'power' ? `<span class="badge power">파워</span>`
      : lvl === 'once' ? `<span class="badge once">1회성</span>` : '';
    return `<tr>
      <td><div class="nick">${u.nickname}${badge}</div></td>
      <td>${fmt(u.generations)}</td>
      <td class="${u.fails ? 'fail' : 'zero'}">${fmt(u.fails)}</td>
      <td class="${u.retries ? '' : 'zero'}">${fmt(u.retries)}</td>
      <td class="spend">${usd(u.totalSpendUsd)}</td>
      <td class="muted">${fmtDate(u.firstSeen)}</td>
      <td>${daysAgo(u.lastSeen)}</td>
      <td>${fmt(u.daysActive)}</td>
    </tr>`;
  }).join('');

  $('#users').innerHTML = `
    <div class="tbl-scroll"><table class="users">
      <thead><tr>${thead}</tr></thead>
      <tbody>${tbody || `<tr><td colspan="8" class="muted" style="text-align:center;padding:24px">유저 없음</td></tr>`}</tbody>
    </table></div>`;

  $('#users').querySelectorAll('th.sortable').forEach(th => {
    th.addEventListener('click', () => {
      const key = th.dataset.key;
      if (userState.sortKey === key) userState.dir *= -1;
      else { userState.sortKey = key; userState.dir = COLS.find(c => c.key === key).num ? -1 : 1; }
      renderUsers();
    });
  });
}

function renderFeedback(list) {
  const sorted = [...list].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  $('#feedback').innerHTML = sorted.length ? sorted.map(f => `
    <div class="fb">
      <div class="top">
        <span class="who">${f.nickname}</span>
        <span class="when">${fmtDateTime(f.createdAt)} · ${daysAgo(f.createdAt)}</span>
      </div>
      <div class="msg">${escapeHtml(f.message)}</div>
    </div>`).join('') : `<div class="loading">아직 피드백이 없어요.</div>`;
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

/* ============================ 백엔드 ↔ 렌더러 어댑터 ============================
 * 백엔드(CONTRACT.md)는 snake_case이고 리스트를 {users}/{feedback}로 감싸며,
 * 코호트 retention은 "주차오프셋→활성유저 수" 딕셔너리다. 렌더러는 camelCase +
 * retention 비율 배열을 기대하므로 여기서 변환한다. 목업(camelCase)도 그대로 통과.
 */
function adaptOverview(o) {
  if (!o) return {};
  // already camelCase (mock)?
  if (o.totalUsers != null || o.retentionCohorts) return o;
  const cohorts = (o.cohorts || []).map(c => {
    // retention: {"0": n0, "1": n1, ...} counts → ratio array indexed by week offset
    const size = c.size || 0;
    const offsets = Object.keys(c.retention || {}).map(Number);
    const maxOff = offsets.length ? Math.max(...offsets) : 0;
    const arr = [];
    for (let i = 0; i <= maxOff; i++) {
      const cnt = c.retention?.[String(i)];
      arr[i] = (cnt == null) ? (i === 0 ? (size ? 1 : null) : null)
                             : (size ? cnt / size : 0);
    }
    return { cohortWeek: c.cohort, size, retention: arr };
  });
  return {
    totalUsers: o.total_users,
    newToday: o.new_users_today,
    dau: o.dau, wau: o.wau, mau: o.mau,
    totalGenerations: o.total_generations,
    totalFailures: o.total_failures,
    totalRetries: o.total_retries,
    failRate: o.fail_rate,
    totalSpendUsd: o.total_spend_usd,
    spendTodayUsd: o.spend_today_usd,
    retentionCohorts: cohorts,
  };
}
function adaptUsers(u) {
  const list = Array.isArray(u) ? u : (u?.users || []);
  return list.map(r => (r.totalSpendUsd != null || r.firstSeen) ? r : {
    nickname: r.nickname,
    is_admin: r.is_admin,
    generations: r.generations,
    fails: r.fails,
    retries: r.retries,
    totalSpendUsd: r.total_spend_usd,
    firstSeen: r.first_seen,
    lastSeen: r.last_seen,
    daysActive: r.days_active,
  });
}
function adaptFeedback(f) {
  const list = Array.isArray(f) ? f : (f?.feedback || []);
  return list.map(r => r.createdAt ? r : {
    nickname: r.nickname,
    message: r.message,
    createdAt: r.created_at,
  });
}

/* ============================ 게이트(권한) ============================ */
function showGate() { $('#gate').classList.add('show'); }

/* ============================ 부트/새로고침 ============================ */
async function loadAll() {
  const btn = $('#refresh');
  btn.disabled = true;
  const ico = $('#refresh .ico');
  ico.classList.add('spin');
  try {
    const [overviewRaw, usersRaw, feedbackRaw] = await Promise.all([
      api('/api/admin/overview'),
      api('/api/admin/users'),
      api('/api/admin/feedback'),
    ]);
    // Backend contract (CONTRACT.md) is snake_case and wraps lists in objects;
    // normalize into the shapes the renderers use.
    const overview = adaptOverview(overviewRaw);
    renderOverview(overview);
    renderCohort(overview.retentionCohorts);
    userState.rows = adaptUsers(usersRaw);
    renderUsers();
    renderFeedback(adaptFeedback(feedbackRaw));
    const now = new Date();
    $('#updated').textContent = '갱신됨 ' + now.toLocaleTimeString('ko-KR');
  } catch (e) {
    if (e.message !== 'unauthorized') {
      $('#updated').textContent = '불러오기 실패: ' + e.message;
    }
  } finally {
    btn.disabled = false;
    ico.classList.remove('spin');
  }
}

function init() {
  $('#adminNick').textContent = getNick() || '(미로그인)';
  $('#mockBanner').style.display = USE_MOCK ? 'flex' : 'none';
  // 실서비스에서 토큰이 없으면 바로 게이트
  if (!USE_MOCK && !getToken()) { showGate(); return; }
  $('#refresh').addEventListener('click', loadAll);
  loadAll();
}
document.addEventListener('DOMContentLoaded', init);
