/* ═══════════════════════════════════════════════════════════
   services/g2b-crawler.js
   조달청 나라장터 입찰공고정보서비스 API 크롤러 (MySQL 버전)
═══════════════════════════════════════════════════════════ */
const axios  = require('axios');
const xml2js = require('xml2js');
const Notice = require('../models/Notice');

const BASE = 'https://apis.data.go.kr/1230000/BidPublicInfoService04';

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
    return man > 0 ? `${eok}억 ${man.toLocaleString()}만원` : `${eok}억원`;
  }
  if (n >= 10000) return `${Math.floor(n / 10000).toLocaleString()}만원`;
  return `${n.toLocaleString()}원`;
}

/* ── 나라장터 공고 상세 URL ── */
function buildG2bUrl(bidNtceNo, bidNtceOrd) {
  if (!bidNtceNo) return '';
  return `https://www.g2b.go.kr:8340/search.do?bidNtceNo=${bidNtceNo}&bidNtceOrd=${bidNtceOrd || '00'}`;
}

/* ── 날짜 파싱 ── */
function parseDate(str) {
  if (!str) return null;
  str = str.trim();
  if (str.includes('-')) return new Date(str);
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
    serviceKey: decodeURIComponent(apiKey),
    numOfRows: 100,
    pageNo,
    inqryDiv: 1,
    inqryBgnDt,
    inqryEndDt,
    type: 'json'
  };

  try {
    const resp = await axios.get(url, {
      params,
      timeout: 30000,
      headers: { 'Accept': 'application/json' }
    });

    let body = resp.data;

    if (typeof body === 'string' && body.trim().startsWith('<')) {
      const parsed = await xml2js.parseStringPromise(body, { explicitArray: false });
      body = parsed;
    }

    const items = body?.response?.body?.items;
    if (!items || items === '') return [];

    const list = Array.isArray(items) ? items : [items];
    return list;
  } catch (err) {
    if (err.response) {
      console.warn(`[G2B] ${endpoint.type} API 응답 에러 (${err.response.status})`);
    } else {
      console.warn(`[G2B] ${endpoint.type} 요청 실패:`, err.message);
    }
    return [];
  }
}

/* ── API 아이템 → DB 데이터 변환 ── */
function mapItem(item, noticeType) {
  const bidNtceNo  = item.bidNtceNo  || '';
  const bidNtceOrd = item.bidNtceOrd || '00';
  const budget     = Number(item.asignBdgtAmt || item.presmptPrce || 0);
  const estimated  = Number(item.presmptPrce || 0);
  const detailUrl  = item.bidNtceUrl || buildG2bUrl(bidNtceNo, bidNtceOrd);

  return {
    bid_ntce_no:      bidNtceNo,
    bid_ntce_ord:     bidNtceOrd,
    source_system:    'g2b_api',
    title:            item.bidNtceNm || '(제목 없음)',
    notice_type:      noticeType,
    bid_method:       item.bidMethdNm      || '',
    contract_method:  item.cntrctMthdNm    || '',
    issuing_org:      item.ntceInsttNm     || '',
    demanding_org:    item.dminsttNm       || '',
    budget:           budget,
    estimated_price:  estimated,
    budget_formatted: formatBudget(budget || estimated),
    published_at:     parseDate(item.bidNtceDt),
    closing_at:       parseDate(item.bidClseDt),
    opening_at:       parseDate(item.opengDt),
    detail_url:       detailUrl,
    raw_data:         item,
    collected_at:     new Date()
  };
}

/* ══════════════════════════════════════════════
   메인 수집 함수 — Sequelize upsert 사용
══════════════════════════════════════════════ */
async function crawl(options = {}) {
  const now = new Date();
  const kstOffset = 9 * 60 * 60 * 1000;

  let bgnDt, endDt;

  if (options.minuteMode !== false) {
    const endKst = new Date(now.getTime() + kstOffset);
    const bgnKst = new Date(endKst.getTime() - 3 * 60 * 1000);
    bgnDt = formatDt(bgnKst);
    endDt = formatDt(endKst);
  } else if (options.from && options.to) {
    bgnDt = options.from;
    endDt = options.to;
  } else {
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

          // Sequelize upsert: 있으면 UPDATE, 없으면 INSERT
          const [instance, created] = await Notice.upsert(doc, {
            conflictFields: ['bid_ntce_no', 'bid_ntce_ord', 'source_system']
          });

          if (created) totalNew++;
          else totalUpdated++;
        } catch (dbErr) {
          // 중복 에러는 무시
          if (dbErr.name !== 'SequelizeUniqueConstraintError') {
            console.error(`  [${ep.type}] DB 저장 에러:`, dbErr.message);
            totalError++;
          }
        }
      }
    } catch (err) {
      console.error(`  [${ep.type}] 크롤링 에러:`, err.message);
    }

    await new Promise(r => setTimeout(r, 200));
  }

  const summary = `[G2B 크롤러] 완료 — 신규: ${totalNew}, 갱신: ${totalUpdated}, 에러: ${totalError}`;
  console.log(summary);
  return { new: totalNew, updated: totalUpdated, errors: totalError };
}

function formatDt(d) {
  return d.getUTCFullYear().toString() +
    String(d.getUTCMonth() + 1).padStart(2, '0') +
    String(d.getUTCDate()).padStart(2, '0') +
    String(d.getUTCHours()).padStart(2, '0') +
    String(d.getUTCMinutes()).padStart(2, '0');
}

module.exports = { crawl };
