const axios = require('axios');
const xml2js = require('xml2js');
const Notice = require('../models/Notice');

const BASE = 'https://apis.data.go.kr/1230000/ad/BidPublicInfoService';

const ENDPOINTS = [
  { path: '/getBidPblancListInfoThng', type: '물품' },
  { path: '/getBidPblancListInfoServc', type: '용역' },
  { path: '/getBidPblancListInfoCnstwk', type: '공사' },
  { path: '/getBidPblancListInfoFrgcpt', type: '외자' },
];

function formatBudget(won) {
  if (!won || won <= 0) return '';
  const n = Number(won);
  if (Number.isNaN(n) || n <= 0) return '';
  if (n >= 100000000) {
    const eok = Math.floor(n / 100000000);
    const man = Math.floor((n % 100000000) / 10000);
    return man > 0 ? `${eok}억 ${man.toLocaleString()}만원` : `${eok}억원`;
  }
  if (n >= 10000) return `${Math.floor(n / 10000).toLocaleString()}만원`;
  return `${n.toLocaleString()}원`;
}

function buildG2bUrl(bidNtceNo, bidNtceOrd) {
  if (!bidNtceNo) return '';
  return `https://www.g2b.go.kr:8101/ep/tbid/tbidFwd.do?bidNtceNo=${encodeURIComponent(bidNtceNo)}&bidNtceOrd=${encodeURIComponent(bidNtceOrd || '00')}`;
}

function parseDate(str) {
  if (!str) return null;
  str = String(str).trim();
  if (!str) return null;

  if (str.includes('-') || str.includes('/')) {
    const d = new Date(str);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  if (str.length >= 12) {
    const y = str.slice(0, 4);
    const m = str.slice(4, 6);
    const d = str.slice(6, 8);
    const h = str.slice(8, 10);
    const mi = str.slice(10, 12);
    const s = str.slice(12, 14) || '00';
    const parsed = new Date(`${y}-${m}-${d}T${h}:${mi}:${s}+09:00`);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  return null;
}

function normalizeItems(body) {
  const rawItems = body?.response?.body?.items;
  if (!rawItems) return [];

  if (Array.isArray(rawItems)) return rawItems;
  if (Array.isArray(rawItems.item)) return rawItems.item;
  if (rawItems.item) return [rawItems.item];
  return [rawItems];
}

async function fetchEndpointPage(endpoint, inqryBgnDt, inqryEndDt, pageNo = 1) {
  const apiKey = process.env.G2B_API_KEY;
  if (!apiKey) throw new Error('G2B_API_KEY 환경변수가 설정되지 않았습니다.');

  const url = `${BASE}${endpoint.path}`;
  const params = {
    serviceKey: decodeURIComponent(apiKey),
    pageNo,
    numOfRows: 100,
    inqryDiv: 1,
    inqryBgnDt,
    inqryEndDt,
    type: 'json'
  };

  const resp = await axios.get(url, {
    params,
    timeout: 30000,
    headers: { Accept: 'application/json, text/xml, application/xml' }
  });

  let body = resp.data;
  if (typeof body === 'string' && body.trim().startsWith('<')) {
    body = await xml2js.parseStringPromise(body, { explicitArray: false });
  }

  const resultCode = body?.response?.header?.resultCode;
  const resultMsg = body?.response?.header?.resultMsg;
  if (resultCode && String(resultCode) !== '00') {
    throw new Error(`${endpoint.type} API 오류 (${resultCode} ${resultMsg || ''})`.trim());
  }

  const totalCount = Number(body?.response?.body?.totalCount || 0);
  const items = normalizeItems(body);
  return { items, totalCount };
}

async function fetchEndpointAll(endpoint, inqryBgnDt, inqryEndDt) {
  const first = await fetchEndpointPage(endpoint, inqryBgnDt, inqryEndDt, 1);
  const allItems = [...first.items];
  const totalPages = Math.max(1, Math.ceil(first.totalCount / 100));

  for (let page = 2; page <= totalPages; page++) {
    const next = await fetchEndpointPage(endpoint, inqryBgnDt, inqryEndDt, page);
    allItems.push(...next.items);
    await new Promise(r => setTimeout(r, 150));
  }

  return allItems;
}

function mapItem(item, noticeType) {
  const bidNtceNo = item.bidNtceNo || '';
  const bidNtceOrd = item.bidNtceOrd || '00';
  const budget = Number(item.asignBdgtAmt || item.presmptPrce || 0);
  const estimated = Number(item.presmptPrce || 0);
  const detailUrl = item.bidNtceUrl || buildG2bUrl(bidNtceNo, bidNtceOrd);

  return {
    bid_ntce_no: bidNtceNo,
    bid_ntce_ord: bidNtceOrd,
    source_system: 'g2b_api',
    title: item.bidNtceNm || '(제목 없음)',
    notice_type: noticeType,
    bid_method: item.bidMethdNm || '',
    contract_method: item.cntrctMthdNm || '',
    issuing_org: item.ntceInsttNm || '',
    demanding_org: item.dminsttNm || '',
    budget,
    estimated_price: estimated,
    budget_formatted: formatBudget(budget || estimated),
    published_at: parseDate(item.bidNtceDt),
    closing_at: parseDate(item.bidClseDt),
    opening_at: parseDate(item.opengDt),
    detail_url: detailUrl,
    raw_data: item,
    collected_at: new Date()
  };
}

async function saveNotice(doc) {
  const where = {
    bid_ntce_no: doc.bid_ntce_no,
    bid_ntce_ord: doc.bid_ntce_ord,
    source_system: doc.source_system
  };

  const existing = await Notice.findOne({ where });
  if (!existing) {
    await Notice.create(doc);
    return 'created';
  }

  await existing.update(doc);
  return 'updated';
}

function formatDt(d) {
  return d.getUTCFullYear().toString() +
    String(d.getUTCMonth() + 1).padStart(2, '0') +
    String(d.getUTCDate()).padStart(2, '0') +
    String(d.getUTCHours()).padStart(2, '0') +
    String(d.getUTCMinutes()).padStart(2, '0');
}

async function crawl(options = {}) {
  const now = new Date();
  const kstOffset = 9 * 60 * 60 * 1000;

  let bgnDt;
  let endDt;

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

  let totalNew = 0;
  let totalUpdated = 0;
  let totalError = 0;

  for (const ep of ENDPOINTS) {
    try {
      const items = await fetchEndpointAll(ep, bgnDt, endDt);
      if (!items.length) {
        console.log(`  [${ep.type}] 신규 공고 없음`);
        continue;
      }

      console.log(`  [${ep.type}] ${items.length}건 수신`);

      for (const item of items) {
        try {
          const doc = mapItem(item, ep.type);
          const result = await saveNotice(doc);
          if (result === 'created') totalNew++;
          else totalUpdated++;
        } catch (dbErr) {
          console.error(`  [${ep.type}] DB 저장 에러:`, dbErr.message);
          totalError++;
        }
      }
    } catch (err) {
      console.error(`  [${ep.type}] 크롤링 에러:`, err.message);
      totalError++;
    }

    await new Promise(r => setTimeout(r, 300));
  }

  const summary = `[G2B 크롤러] 완료 — 신규: ${totalNew}, 갱신: ${totalUpdated}, 에러: ${totalError}`;
  console.log(summary);
  return { new: totalNew, updated: totalUpdated, errors: totalError };
}

module.exports = { crawl };