# 공고모아 백엔드 (gonggomoa-backend)

입찰공고 통합 검색 서비스 백엔드 API 서버

## 기술 스택
- **Runtime**: Node.js 20+
- **Framework**: Express.js
- **Database**: MongoDB (Mongoose)
- **인증**: JWT (jsonwebtoken + bcryptjs)
- **스케줄링**: node-cron
- **데이터 소스**: 조달청 나라장터 입찰공고정보서비스 API

## 빠른 시작

```bash
# 의존성 설치
npm install

# 환경변수 설정
cp .env.example .env
# .env 파일을 편집하여 실제 값 입력

# 개발 서버 시작
npm run dev
```

## 환경변수 설정

| 변수 | 설명 | 예시 |
|------|------|------|
| `PORT` | 서버 포트 | `4000` |
| `MONGODB_URI` | MongoDB 연결 URI | `mongodb://...` |
| `JWT_SECRET` | JWT 비밀키 | 랜덤 문자열 |
| `G2B_API_KEY` | 공공데이터포털 API 키 | [발급받기](https://www.data.go.kr/data/15129394/openapi.do) |
| `FRONTEND_URL` | 프론트엔드 도메인 | `https://your-domain.com` |
| `CRON_ENABLED` | 자동 수집 활성화 | `true` |

## API 엔드포인트

### 인증
| Method | Path | 설명 |
|--------|------|------|
| POST | `/api/auth/register` | 회원가입 |
| POST | `/api/auth/login` | 로그인 |
| GET | `/api/auth/me` | 내 정보 조회 (인증 필요) |
| PUT | `/api/auth/me` | 내 정보 수정 (인증 필요) |
| PUT | `/api/auth/password` | 비밀번호 변경 (인증 필요) |
| POST | `/api/auth/bookmark/:noticeId` | 즐겨찾기 토글 (인증 필요) |

### 공고
| Method | Path | 설명 |
|--------|------|------|
| GET | `/api/notices` | 공고 목록 (검색/필터) |
| GET | `/api/notices/stats` | 소스별 통계 |
| GET | `/api/notices/calendar/:year/:month` | 월별 마감일 캘린더 |
| GET | `/api/notices/:id` | 공고 상세 |

## 클라우드타입 배포

1. GitHub에 이 레포지토리 push
2. [cloudtype.io](https://cloudtype.io) 에서 새 프로젝트 생성
3. Node.js 앱으로 GitHub 연결
4. 환경변수 설정 (위 표 참고)
5. MongoDB 애드온 추가 → `MONGODB_URI`에 연결 문자열 입력
6. 배포!

## 향후 확장 계획
- [ ] 농협 입찰공고 크롤러
- [ ] 시/구청 입찰공고 크롤러
- [ ] 키워드 알림 (이메일/푸시)
- [ ] 관리자 대시보드
