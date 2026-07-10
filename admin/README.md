# 픽클(Pikl) 관리자 애널리틱스 대시보드 (프론트엔드)

베타 운영 상태를 한눈에 보는 **운영자 전용** 대시보드. 백엔드가 `/admin`에서
관리자 인증된 유저에게 정적 파일로 서빙한다.

## 파일 구성
```
admin/
├─ admin.html    진입점 (섹션 4개 + 헤더 + 권한 게이트)
├─ admin.css     다크 테마 (consumer app.py 디자인 토큰 재사용)
├─ admin.js      API 계층 · 렌더러 · 정렬 · 게이트 로직
├─ mock-data.js  시각 개발용 목업 (실제 API 스키마와 1:1)
└─ README.md
```
외부 의존성 없음(바닐라 JS + 손수 만든 SVG/CSS). CDN 차트 라이브러리 미사용 —
리텐션 히트맵/스파크는 CSS·테이블로 직접 렌더해 가볍게 유지.

## 서빙 방식
- 백엔드가 이 폴더를 정적으로 **`/admin`** 경로에 마운트한다.
  (예: `/admin` → `admin.html`, `/admin/admin.js` 등 상대 경로 그대로 로드됨)
- 관리자 인증: consumer 로그인 흐름 재사용.
  `POST /api/login {nickname}` → `{token, is_admin:true}` 로 토큰 발급 후
  프론트는 이를 `localStorage['pikl_admin_token']` (닉네임은 `pikl_admin_nick`)에서 읽는다.
- 모든 admin API 호출은 `Authorization: Bearer <admin token>` 헤더를 붙인다.
- `401`/`403` 응답 시 자동으로 **"관리자 전용"** 게이트 오버레이를 띄우고
  로그인 페이지(`/`)로 유도한다.

## 목업 ↔ 실서버 전환 (한 줄)
`admin.js` 상단:
```js
const USE_MOCK = true;   // 시각 개발: mock-data.js 사용
// const USE_MOCK = false;  // 실서버: 실제 fetch()로 /api/admin/* 호출
```
`USE_MOCK = false`로 바꾸면 `mock-data.js`는 무시되고 `apiReal()`(실 fetch)이 쓰인다.
API 계층(`api(path)`)이 두 경로를 추상화하므로 렌더러 코드는 그대로.
목업 모드일 때는 상단에 노란 배너로 명시된다.

## 히트하는 엔드포인트 (백엔드 구현 계약)
모두 `Authorization: Bearer <admin token>` 필요.

| 메서드 | 경로 | 응답 |
|---|---|---|
| GET | `/api/admin/overview` | `{totalUsers, newToday, dau, wau, mau, totalGenerations, totalFailures, failRate, totalSpendUsd, spendTodayUsd, retentionCohorts:[{cohortWeek, size, retention:[...]}]}` |
| GET | `/api/admin/users` | `[{nickname, generations, fails, retries, totalSpendUsd, firstSeen, lastSeen, daysActive}]` |
| GET | `/api/admin/feedback` | `[{nickname, message, createdAt}]` |
| POST | `/api/login` | `{token, is_admin:true}` (관리자 닉네임으로 발급) |

- `failRate`, `retention[]` 값은 **0~1 비율**(프론트에서 % 변환).
- `retention[0]`은 가입 주 자기 자신(=1.0). 최근 코호트는 관측 주차가 짧아
  배열 길이가 짧아진다(누락 열은 자동으로 빈 칸 처리).
- 날짜/시각 필드는 ISO8601 문자열.

## 섹션
1. **개요** — 총 유저 / 오늘 신규 / DAU·WAU·MAU / 총 생성 / 실패율 / 총·오늘 소비액
   (+ 유저당 평균 생성·소비 파생 카드). 실패율은 임계값에 따라 초록·노랑·빨강.
2. **리텐션** — 가입 주차별 코호트 히트맵. 행=가입 주, 열=+N주,
   셀=재방문율(색: 회색→파랑→초록 그라데이션). 운영자가 가장 오래 볼 화면이라 크게·읽기 쉽게.
3. **유저별** — 정렬 가능한 표. 열 제목 클릭으로 정렬(기본: 마지막 방문 최신순).
   파워 유저 / 1회성 유저 뱃지로 하이라이트.
4. **피드백** — 제출된 피드백 최신순 리스트.

헤더에 로그인한 관리자 닉네임 + 새로고침 버튼. 데스크톱 우선, 반응형.

## 로컬 미리보기
```bash
cd admin && python3 -m http.server 8500
# http://localhost:8500/admin.html  (USE_MOCK=true 상태로 목업 렌더)
```
> 주의: 로컬 미리보기는 목업 모드 전용. 실 인증/`/admin` 라우팅은 백엔드가 붙은 뒤 검증.
