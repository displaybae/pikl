/* 픽클(Pikl) 관리자 대시보드 — 시각 개발용 모의 데이터.
 * 실제 API 응답 스키마(GET /api/admin/*)와 1:1로 맞춰져 있음.
 * USE_MOCK=false 로 바꾸면 이 파일은 무시되고 실제 fetch()가 사용됨.
 * (오늘 = 2026-07-10 기준으로 값들을 구성)
 */
const MOCK = {
  /* GET /api/admin/overview */
  overview: {
    totalUsers: 214,
    newToday: 9,
    dau: 47,
    wau: 132,
    mau: 208,
    totalGenerations: 6821,
    totalFailures: 512,
    failRate: 0.075,          // 7.5%
    totalSpendUsd: 284.63,
    spendTodayUsd: 12.87,
    // 가입 주차별 코호트. retention[0] = 가입 주(=1.0), 이후 주차별 재방문율.
    // 최근 코호트일수록 관측 주차가 짧아 열이 비어감(null 미포함, 길이로 표현).
    retentionCohorts: [
      { cohortWeek: '2026-05-11', size: 18, retention: [1.0, 0.56, 0.44, 0.39, 0.33, 0.33, 0.28, 0.28, 0.22] },
      { cohortWeek: '2026-05-18', size: 24, retention: [1.0, 0.63, 0.50, 0.42, 0.38, 0.33, 0.29, 0.25] },
      { cohortWeek: '2026-05-25', size: 21, retention: [1.0, 0.57, 0.48, 0.43, 0.38, 0.33, 0.29] },
      { cohortWeek: '2026-06-01', size: 27, retention: [1.0, 0.67, 0.52, 0.44, 0.37, 0.30] },
      { cohortWeek: '2026-06-08', size: 33, retention: [1.0, 0.70, 0.55, 0.42, 0.36] },
      { cohortWeek: '2026-06-15', size: 29, retention: [1.0, 0.62, 0.48, 0.41] },
      { cohortWeek: '2026-06-22', size: 31, retention: [1.0, 0.68, 0.52] },
      { cohortWeek: '2026-06-29', size: 26, retention: [1.0, 0.73] },
      { cohortWeek: '2026-07-06', size: 25, retention: [1.0] },
    ],
  },

  /* GET /api/admin/users */
  users: [
    { nickname: '민트초코',   generations: 214, fails: 11, retries: 19, totalSpendUsd: 24.83, firstSeen: '2026-05-12T09:14:00+09:00', lastSeen: '2026-07-10T08:41:00+09:00', daysActive: 41 },
    { nickname: '옷장요정',   generations: 168, fails: 7,  retries: 12, totalSpendUsd: 19.44, firstSeen: '2026-05-19T20:02:00+09:00', lastSeen: '2026-07-10T11:23:00+09:00', daysActive: 37 },
    { nickname: '핏최적화',   generations: 142, fails: 22, retries: 31, totalSpendUsd: 17.02, firstSeen: '2026-05-25T13:40:00+09:00', lastSeen: '2026-07-09T22:10:00+09:00', daysActive: 33 },
    { nickname: 'seoyeon_k', generations: 121, fails: 5,  retries: 9,  totalSpendUsd: 13.98, firstSeen: '2026-06-01T10:11:00+09:00', lastSeen: '2026-07-10T07:52:00+09:00', daysActive: 29 },
    { nickname: '데일리룩',   generations: 97,  fails: 8,  retries: 14, totalSpendUsd: 11.20, firstSeen: '2026-06-02T18:30:00+09:00', lastSeen: '2026-07-08T19:44:00+09:00', daysActive: 24 },
    { nickname: 'jihoon',    generations: 88,  fails: 3,  retries: 6,  totalSpendUsd: 10.11, firstSeen: '2026-06-08T09:00:00+09:00', lastSeen: '2026-07-10T09:30:00+09:00', daysActive: 22 },
    { nickname: '코디대장',   generations: 76,  fails: 19, retries: 28, totalSpendUsd: 9.34,  firstSeen: '2026-06-09T14:22:00+09:00', lastSeen: '2026-07-07T13:05:00+09:00', daysActive: 18 },
    { nickname: 'yuna.p',    generations: 64,  fails: 4,  retries: 5,  totalSpendUsd: 7.42,  firstSeen: '2026-06-11T21:15:00+09:00', lastSeen: '2026-07-09T20:00:00+09:00', daysActive: 16 },
    { nickname: '봄여름가을', generations: 51,  fails: 6,  retries: 8,  totalSpendUsd: 6.03,  firstSeen: '2026-06-15T11:47:00+09:00', lastSeen: '2026-07-10T10:12:00+09:00', daysActive: 14 },
    { nickname: 'minji__',   generations: 44,  fails: 2,  retries: 3,  totalSpendUsd: 5.18,  firstSeen: '2026-06-16T08:33:00+09:00', lastSeen: '2026-07-05T16:40:00+09:00', daysActive: 12 },
    { nickname: '패션테러',   generations: 39,  fails: 12, retries: 17, totalSpendUsd: 4.71,  firstSeen: '2026-06-18T19:20:00+09:00', lastSeen: '2026-07-08T21:33:00+09:00', daysActive: 11 },
    { nickname: 'hana_lee',  generations: 33,  fails: 1,  retries: 2,  totalSpendUsd: 3.88,  firstSeen: '2026-06-20T10:05:00+09:00', lastSeen: '2026-07-10T06:15:00+09:00', daysActive: 9 },
    { nickname: '스타일러',   generations: 28,  fails: 5,  retries: 7,  totalSpendUsd: 3.30,  firstSeen: '2026-06-22T13:12:00+09:00', lastSeen: '2026-07-06T18:22:00+09:00', daysActive: 8 },
    { nickname: 'doyoon',    generations: 19,  fails: 0,  retries: 1,  totalSpendUsd: 2.24,  firstSeen: '2026-06-24T09:41:00+09:00', lastSeen: '2026-07-09T12:00:00+09:00', daysActive: 6 },
    { nickname: '옷사고싶다', generations: 15,  fails: 3,  retries: 4,  totalSpendUsd: 1.79,  firstSeen: '2026-06-27T22:08:00+09:00', lastSeen: '2026-07-03T14:30:00+09:00', daysActive: 5 },
    { nickname: 'chaewon',   generations: 12,  fails: 1,  retries: 1,  totalSpendUsd: 1.42,  firstSeen: '2026-06-29T11:00:00+09:00', lastSeen: '2026-07-10T09:05:00+09:00', daysActive: 4 },
    { nickname: '뉴비999',    generations: 8,   fails: 2,  retries: 3,  totalSpendUsd: 0.96,  firstSeen: '2026-07-01T17:55:00+09:00', lastSeen: '2026-07-04T20:11:00+09:00', daysActive: 3 },
    { nickname: 'test_user', generations: 5,   fails: 4,  retries: 6,  totalSpendUsd: 0.61,  firstSeen: '2026-07-03T10:20:00+09:00', lastSeen: '2026-07-03T10:44:00+09:00', daysActive: 1 },
    { nickname: '구경만',     generations: 2,   fails: 0,  retries: 0,  totalSpendUsd: 0.24,  firstSeen: '2026-07-06T15:00:00+09:00', lastSeen: '2026-07-06T15:07:00+09:00', daysActive: 1 },
    { nickname: 'first_try', generations: 1,   fails: 1,  retries: 2,  totalSpendUsd: 0.12,  firstSeen: '2026-07-10T13:22:00+09:00', lastSeen: '2026-07-10T13:24:00+09:00', daysActive: 1 },
  ],

  /* GET /api/admin/feedback */
  feedback: [
    { nickname: '민트초코',   message: '입히기 결과가 진짜 자연스러워요! 근데 가끔 소매 부분이 뭉개져서 재시도하게 돼요.', createdAt: '2026-07-10T10:32:00+09:00' },
    { nickname: 'first_try', message: '첫 생성이 실패로 떠서 좀 당황했어요. 뭐가 문제인지 안내가 있으면 좋겠어요.', createdAt: '2026-07-10T13:25:00+09:00' },
    { nickname: '데일리룩',   message: '옷장에 사진 많이 넣으니까 스크롤이 느려지네요. 폴더 기능 있으면 좋겠습니다.', createdAt: '2026-07-09T19:50:00+09:00' },
    { nickname: 'jihoon',    message: '미술관 감성 UI 너무 예뻐요. 부티크 버전 슬라이더도 재밌음 ㅎㅎ', createdAt: '2026-07-08T21:14:00+09:00' },
    { nickname: '코디대장',   message: '전신샷 말고 상반신만 입혀보는 옵션도 필요해요. 지금은 다리까지 나와야 잘 돼요.', createdAt: '2026-07-07T14:02:00+09:00' },
    { nickname: '봄여름가을', message: '색 보정이 원본이랑 조금 달라져요. 톤 유지 옵션 부탁드려요!', createdAt: '2026-07-06T09:41:00+09:00' },
    { nickname: 'yuna.p',    message: '결제 없이 하루 몇 장까지 되는지 헷갈려요. 남은 크레딧 표시해주세요.', createdAt: '2026-07-05T22:30:00+09:00' },
    { nickname: '옷장요정',   message: '매일 아침 코디 추천으로 쓰고 있어요. 진짜 실용적이에요 👏', createdAt: '2026-07-04T08:12:00+09:00' },
  ],
};

// consumer 앱과 동일하게 전역 노출 (모듈 번들러 없이 스크립트 태그로 로드)
window.MOCK = MOCK;
