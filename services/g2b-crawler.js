/* ═══════════════════════════════════════════════════════════
   services/g2b-crawler.js
   조달청 나라장터 입찰공고정보서비스 API 크롤러
   
   공공데이터포털: https://www.data.go.kr/data/15129394/openapi.do
   API 문서: https://apis.data.go.kr/1230000/BidPublicInfoService04
   
   ★ 4개 업무(물품/용역/공사/외자) 각각 별도 엔드포인트 호출
   ★ 수집된 공고에 원본 나라장터 URL 포함
═══════════════════════════════════════════════════════════ */
const axios  = require('axios');
const xml2js = require('xml2js');
const Notice = require('../models/Notice');

const BASE = 'https://apis.data.go.kr/1230000/BidPublicInfoService04';

// 업무별 엔드포인트 + 공고유형 매핑
const ENDPOINTS = [
  { path: '/getBidPblancListInfoThngBsnsDiv',    type: '물품' },
  { path: '/getBidPblancListInfoServcBsnsDiv',    type: '용역' },
  { path: '/getBidPblancListInfoCnstwkBsnsDiv',   type: '공사' },
  { path: '/getBidPblancListInfoFrgcptBsnsDiv',   type: '외자' },
];

/* ── 금액 포매팅 ── */
function formatBudget(won) {
  if (!won || won <= 0) return '';
  const n = Number(won);
  if (n >= 100000000) {
    const eok = Math.floor(n / 100000000);
    const man = Math.floor((n % 100000000) / 10000);
    return man > 0
      ? `${eok}억 ${man.toLocaleString()}만원`
      : `${eok}억원`;
  }
  if (n >= 10000) return `${Math.floor(n / 10000).toLocaleString()}만원`;
  return `${n.toLocaleString()}원`;
}

/* ── 나라장터 공고 상세 URL 생성 ── */
function buildG2bUrl(bidNtceNo, bidNtceOrd) {
  // 나라장터 입찰공고 상세 URL 패턴
  if (!bidNtceNo) return '';
  const ord = bidNtceOrd || '00';
  return `https://www.g2b.go.kr:8340/search.do?bidNtceNo=${bidNtceNo}&bidNtceOrd=${ord}`;
}

/* ── 날짜 파싱 (YYYY-MM-DD HH:mm:ss 또는 YYYYMMDDHHMMSS) ── */
function parseDate(str) {
  if (!str) return null;
  str = str.trim();
  // "2025-07-15 10:00:00" 형식
  if (str.includes('-')) return new Date(str);
  // "20250715100000" 형식
  if (str.length >= 12) {
    const y = str.slice(0,4), m = str.slice(4,6), d = str.slice(6,8);
    const h = str.slice(8,10), mi = str.slice(10,12), s = str.slice(12,14) || '00';
    return new Date(`${y}-${m}-${d}T${h}:${mi}:${s}+09:00`);
  }
  return null;
}

/* ── 단일 엔드포인트 호출 ── */
async function fetchEndpoint(endpoint, inqryBgnDt, inqryEndDt, pageNo = 1) {
  const apiKey = process.env.G2B_API_KEY;
  if (!apiKey) throw new Error('G2B_API_KEY 환경변수가 설정되지 않았습니다.');

  const url = `${BASE}${endpoint.path}`;
  const params = {
    serviceKey: decodeURIComponent(apiKey), // 공공데이터포털 키는 인코딩된 상태로 제공됨
    numOfRows: 100,
    pageNo,
    inqryDiv: 1,        // 1: 공고일 기준
    inqryBgnDt,         // YYYYMMDDHHMM (예: 202507150800)
    inqryEndDt,         // YYYYMMDDHHMM
    type: 'json'
  };

  try {
    const resp = await axios.get(url, {
      params,
      timeout: 30000,
      headers: { 'Accept': 'application/json' }
    });

    let body = resp.data;

    // XML 응답인 경우 파싱
    if (typeof body === 'string' && body.trim().startsWith('<')) {
      const parsed = await xml2js.parseStringPromise(body, { explicitArray: false });
      body = parsed;
    }

    // JSON 응답 구조: response.body.items (배열 또는 빈 문자열)
    const items = body?.response?.body?.items;
    if (!items || items === '') return [];

    // items가 배열이 아닌 경우 (단건)
    const list = Array.isArray(items) ? items : [items];
    return list;
  } catch (err) {
    // API 에러 로그 (에러 코드에 따라 다른 처리)
    if (err.response) {
      console.warn(`[G2B] ${endpoint.type} API 응답 에러 (${err.response.status}):`,
        typeof err.response.data === 'string' ? err.response.data.slice(0, 200) : err.response.data);
    } else {
      console.warn(`[G2B] ${endpoint.type} 요청 실패:`, err.message);
    }
    return [];
  }
}

/* ── 한 건의 API 아이템 → Notice 도큐먼트로 변환 ── */
function mapItem(item, noticeType) {
  const bidNtceNo  = item.bidNtceNo  || item.bidNtceNo || '';
  const bidNtceOrd = item.bidNtceOrd || item.bidNtceOrd || '00';
  const budget     = Number(item.asignBdgtAmt || item.presmptPrce || 0);
  const estimated  = Number(item.presmptPrce || 0);

  // 나라장터 원본 URL: API 응답에 bidNtceUrl 필드가 있으면 사용, 없으면 생성
  const detailUrl  = item.bidNtceUrl || buildG2bUrl(bidNtceNo, bidNtceOrd);

  return {
    bid_ntce_no:     bidNtceNo,
    bid_ntce_ord:    bidNtceOrd,
    source_system:   'g2b_api',
    title:           item.bidNtceNm || '(제목 없음)',
    notice_type:     noticeType,
    bid_method:      item.bidMethdNm      || '',
    contract_method: item.cntrctMthdNm    || '',
    issuing_org:     item.ntceInsttNm     || '',
    demanding_org:   item.dminsttNm       || '',
    budget:          budget,
    estimated_price: estimated,
    budget_formatted:formatBudget(budget || estimated),
    published_at:    parseDate(item.bidNtceDt),
    closing_at:      parseDate(item.bidClseDt),
    opening_at:      parseDate(item.opengDt),
    detail_url:      detailUrl,
    raw_data:        item,
    collected_at:    new Date()
  };
}

/* ══════════════════════════════════════════════
   메인 수집 함수 — 외부에서 호출
   minuteMode: true  → 직전 2분간 신규 공고만
               false → inqryBgnDt~inqryEndDt 전체
══════════════════════════════════════════════ */
async function crawl(options = {}) {
  const now = new Date();
  // 한국 시간(KST) 기준으로 조회 범위 산출
  const kstOffset = 9 * 60 * 60 * 1000;

  let bgnDt, endDt;

  if (options.minuteMode !== false) {
    // 매 분 호출: 직전 3분 범위 (겹침 허용 → upsert로 중복 제거)
    const endKst = new Date(now.getTime() + kstOffset);
    const bgnKst = new Date(endKst.getTime() - 3 * 60 * 1000);
    bgnDt = formatDt(bgnKst);
    endDt = formatDt(endKst);
  } else if (options.from && options.to) {
    bgnDt = options.from;
    endDt = options.to;
  } else {
    // 오늘 하루 전체
    const todayKst = new Date(now.getTime() + kstOffset);
    const y = todayKst.getUTCFullYear();
    const m = String(todayKst.getUTCMonth() + 1).padStart(2, '0');
    const d = String(todayKst.getUTCDate()).padStart(2, '0');
    bgnDt = `${y}${m}${d}0000`;
    endDt = `${y}${m}${d}2359`;
  }

  console.log(`[G2B 크롤러] 수집 범위: ${bgnDt} ~ ${endDt}`);

  let totalNew = 0, totalUpdated = 0, totalError = 0;

  for (const ep of ENDPOINTS) {
    try {
      const items = await fetchEndpoint(ep, bgnDt, endDt);
      if (!items.length) {
        console.log(`  [${ep.type}] 신규 공고 없음`);
        continue;
      }

      console.log(`  [${ep.type}] ${items.length}건 수신`);

      for (const item of items) {
        try {
          const doc = mapItem(item, ep.type);
          const result = await Notice.findOneAndUpdate(
            {
              bid_ntce_no:  doc.bid_ntce_no,
              bid_ntce_ord: doc.bid_ntce_ord,
              source_system: doc.source_system
            },
            { $set: doc },
            { upsert: true, new: true, setDefaultsOnInsert: true }
          );
          // upsert 결과: 신규 vs 기존
          if (result.collected_at.getTime() >= now.getTime() - 5000) {
            totalNew++;
          } else {
            totalUpdated++;
          }
        } catch (dbErr) {
          if (dbErr.code !== 11000) {
            console.error(`  [${ep.type}] DB 저장 에러:`, dbErr.message);
            totalError++;
          }
        }
      }

      // 페이지네이션: 100건 초과 시 추가 페이지 호출
      // (간소화: 실무에서는 totalCount 확인 후 루프)
    } catch (err) {
      console.error(`  [${ep.type}] 크롤링 에러:`, err.message);
    }

    // API 호출 간 200ms 딜레이 (Rate limit 방지)
    await new Promise(r => setTimeout(r, 200));
  }

  const summary = `[G2B 크롤러] 완료 — 신규: ${totalNew}, 갱신: ${totalUpdated}, 에러: ${totalError}`;
  console.log(summary);
  return { new: totalNew, updated: totalUpdated, errors: totalError };
}

/* ── 날짜 → YYYYMMDDHHMM ── */
function formatDt(d) {
  return d.getUTCFullYear().toString() +
    String(d.getUTCMonth() + 1).padStart(2, '0') +
    String(d.getUTCDate()).padStart(2, '0') +
    String(d.getUTCHours()).padStart(2, '0') +
    String(d.getUTCMinutes()).padStart(2, '0');
}

module.exports = { crawl };
