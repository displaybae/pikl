# 픽클 (Pikl) — 소비자용 프론트엔드

사진 속 옷을 뽑아 나만의 디지털 옷장에 모으고, 다른 사진에 입혀보는 모바일-퍼스트 웹앱.
부티크 / 에디토리얼 / 미술관 감성. 한국어 UI.

## 파일 구성
```
webapp/
├── index.html                 # 단일 페이지 앱 (모든 화면 포함)
├── style.css                  # 전체 스타일 (팔레트/컴포넌트/애니메이션)
├── app.js                     # 앱 로직 (라우팅 / API / 목업 폴백)
└── assets/onboarding/
    ├── person.png             # 온보딩 예시: 원본 인물 사진
    └── garment.jpg            # 온보딩 예시: 추출된 니트(흰 배경)
```

## 서빙 방식 — same-origin 필수
프론트엔드는 **백엔드와 동일 오리진**에서 서빙된다고 가정합니다. 즉 백엔드가
`webapp/index.html`을 루트(또는 임의 경로)로 서빙하고, 아래 API/이미지 경로를
같은 오리진에서 노출하면 됩니다. 모든 `fetch()`는 상대 경로(`/api/...`, `/wardrobe/...`)를
사용하므로 CORS 설정이 필요 없습니다.

로컬에서 레이아웃만 확인하려면:
```
cd webapp && python3 -m http.server 8777
# http://localhost:8777/index.html
```
(정적 서버에는 `/api/*`가 없으므로 자동으로 **데모 모드**로 전환됩니다. 아래 참고.)

## 사용하는 엔드포인트 (백엔드가 구현)
모든 호출에 `Authorization: Bearer <token>` 헤더를 붙입니다. 토큰은
`POST /api/login` 응답을 `localStorage`(`pikl_token`)에 저장해 사용합니다.

| 메서드 | 경로 | 요청 | 응답 | 사용처 |
|---|---|---|---|---|
| POST | `/api/login` | `{nickname}` | `{token, nickname, is_admin}` | 닉네임 진입 게이트 |
| POST | `/api/scan` | `{image: dataURL}` | `{items:[{category,name,description}], cost}` | 추가 탭: 옷 자동 감지 |
| POST | `/api/ingest` | `{image: dataURL, name}` | `{file, extracted, cost}` | 감지된 옷 추출+저장(원샷) |
| POST | `/api/generate` | `{prompt, images:[dataURL...], aspect, analyze?}` | `{image, cost, elapsed, warning?, desc?}` | 입혀보기(combine, `analyze`=옷 개수) |
| POST | `/api/save` | `{image, name}` | `{file}` | 입혀본 결과를 옷장에 저장 |
| GET | `/api/wardrobe` | — | `{files:[filename,...]}` | 옷장 그리드 |
| POST | `/api/delete` | `{file}` | `{ok}` | 옷 삭제 |
| POST | `/api/feedback` | `{message}` | `{ok}` | 피드백 위젯 |
| GET | `/wardrobe/<filename>` | — | 이미지 바이너리 | 옷 이미지 `<img src>` |

> 계약서상 `/api/generate`(extract) → `/api/save` 2단계 저장 흐름도 지원 가능하지만,
> 추가 플로우에서는 더 단순한 **`/api/ingest`**(추출+저장 원샷)를 사용합니다.

## 이미지 처리
- 업로드 사진은 클라이언트에서 **긴 변 1024px 리사이즈 → JPEG q0.92 dataURL**로 변환
  (`fileToDataURL()`, 기존 앱 로직 재사용). 토큰/용량 절약.
- `/api/generate`·`/api/save` 응답의 `image`는 URL 또는 ref로 받아 `<img src>`에 그대로 사용.
- 옷장 이미지 URL은 `/wardrobe/<filename>`으로 조립.

## 화면 흐름
1. **닉네임 진입 게이트** — 로고 + 닉네임 입력 + 시작하기. `is_admin`이면 옷장 헤더에
   "🛠 관리자 대시보드" 버튼(→ `/admin`)이 추가로 노출됩니다. (대시보드 자체는 별도 에이전트 담당.)
2. **온보딩** — 닉네임별 최초 1회. 4장의 스와이프 슬라이드(실제 예시 이미지 사용).
   완료 여부는 `localStorage`(`pikl_onb_done_<nick>`)에 저장.
3. **추가** — 사진 업로드 → `/api/scan` → 감지 아이템 리스트 → 항목별 "담기"(`/api/ingest`).
4. **옷장** — `/api/wardrobe` 그리드. 탭하면 크게 보기/삭제(`/api/delete`).
   빈 상태: "옷장이 비어있어요 — 사진을 올려 첫 옷을 추가해보세요".
5. **입혀보기** — 사람 사진 + 옷 **최대 2벌**(초과 선택 시 안내 토스트) →
   `/api/generate`(`analyze`=옷 개수). `warning` 문자열은 화면에 배너로 노출. 결과 저장 가능.
6. **피드백 위젯** — 앱 내 어디서나 우하단 **플로팅 버튼(🫶)** + 옷장/입혀보기 하단 **배너**.
   탭하면 textarea 모달 → `/api/feedback` → 감사 상태.

## 상태 / UX 디테일
- **로딩**: 이미지 생성(~10초)은 원형 프로그레스 + 단계 문구의 풀스크린 오버레이(개발용 스피너 아님).
  그리드/스캔은 셔머 스켈레톤.
- **에러**: 상단 토스트(ok/err/warn 색상). 4xx/5xx JSON의 `error`/`message`를 그대로 표시.
- **빈 상태**: 옷장/입혀보기 각각 전용 empty 화면 + CTA.
- **전환**: 화면 fade-up, 카드 pop-in, 바텀시트 슬라이드업 등 부드러운 모션.

## 가정 / 목업 폴백
백엔드가 아직 없거나 특정 라우트가 미구현일 때도 UI가 살아있도록 **목업 폴백**을 내장했습니다.
- `fetch`가 **네트워크 레벨에서 실패**하거나, `/api/*` 라우트가 **404/501/502/503**을 반환하면
  자동으로 데모 모드로 전환하고 "데모 모드로 실행 중 (백엔드 미연결)" 토스트를 한 번 띄웁니다.
- 데모 모드에서는 옷장 이미지가 SVG 플레이스홀더로 합성되고, scan/ingest/generate가 목업 응답을 반환합니다.
- 실제 백엔드가 라우트를 구현하면(정상 2xx 또는 4xx JSON 에러) 목업은 개입하지 않고 실제 응답을 사용합니다.
  → **실서비스에서는 코드 변경 없이 그대로 실 API에 연결됩니다.**
- 폴백을 완전히 끄려면 `app.js`의 `USE_MOCK_FALLBACK = false`.

### 데모용 옵션 (실서비스 무해)
- `?__pikl_demo__=N` : 데모 모드에서 옷장에 샘플 옷 N개를 미리 채워 UI를 미리보기.
  (백엔드가 살아있으면 아무 효과 없음.)
- `#closet` / `#add` / `#tryon` : 로그인/온보딩 완료 상태에서 특정 탭으로 딥링크.

## 접근 범위
이 디렉터리(`webapp/`) 안에서만 동작하며, `nodeapp.py`·`static/`·`db.py` 등 기존 백엔드 파일은
건드리지 않습니다.
