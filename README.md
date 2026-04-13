# pikl

OpenAI 키 하나로 테스트할 수 있는 최소 웹 채팅 예제입니다.

## 키 위치

다음 둘 중 하나에 `OPENAI_API_KEY`가 있으면 됩니다.

- `pikl/.env`
- `../project/.env`

다른 키는 읽지 않습니다.

## 실행

```bash
npm start
```

브라우저에서 `http://localhost:3000` 으로 접속하면 됩니다.

## 기능

- `/` : 간단한 채팅 화면
- `/api/chat` : OpenAI 응답 요청
- `/health` : 서버 상태 확인

## Railway 배포

Railway에 올릴 때는 `OPENAI_API_KEY`를 Railway Variables에 직접 넣는 방식이 가장 안전합니다.
