const axios = require('axios');
const Notice = require('../models/Notice');

const DESKTOP_URL = 'https://contract.seoul.go.kr/new1/views/pubBidInfo.do';
const MOBILE_URL = 'https://contract.seoul.go.kr/m/views/pubBidInfo.do';

const REQUEST_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
  'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
};

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function cleanText(value) {
  return String(value || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/<[^>]+>/g, ' ')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseKstDate(dateStr, endOfDay = false) {
  const value = String(dateStr || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  return new Date(`${value}T${endOfDay ? '23:59:59' : '00:00:00'}+09:00`);
}

function getKstNow() {
  return new Date(Date.now() + 9 * 60 * 60 * 1000);
}

function getTargetYears() {
  const nowKst = getKstNow();
  const year = nowKst.getUTCFullYear();
  const month = nowKst.getUTCMonth() + 1;

  if (month === 1) {
    return [year, year - 1];
  }
  return [year];
}

function buildPageUrl(baseUrl, pageNo, recordCount, year) {
  const qs = new URLSearchParams({
    ps_selectForm: '1',
    ps_recordCountPerPage: String(recordCount),
    ps1_fisYear: String(year),
    ps_currentPageNo: String(pageNo)
  });

  return `${baseUrl}?${qs.toString()}`;
}

async function fetchHtml(url) {
  const resp = await axios.get(url, {
    timeout: 30000,
    responseType: 'text',
    headers: REQUEST_HEADERS,
    validateStatus: status => status >= 200 && status < 400
  });

  return String(resp.data || '');
}

async function fetchPageHtml(pageNo, recordCount, year) {
  const urls = [
    buildPageUrl(DESKTOP_URL, pageNo, recordCount, year),
    buildPageUrl(MOBILE_URL, pageNo, recordCount, year)
  ];

  let lastError = null;

  for (const url of urls) {
    try {
      const html = await fetchHtml(url);

      if (
        html &&
        html.includes('입찰공고') &&
        html.includes('bidPopup_getBidInfoDtlUrl') &&
        html.includes('공고일자')
      ) {
        return { url, html };
      }
    } catch (err) {
      lastError = err;
    }
  }

  if (lastError) throw lastError;
  return { url: urls[0], html: '' };
}

/*
  실제 HTML 반복 구조 예:
  <tr><td class="settxt"> ... <div class="sticker_red">용역</div> ... 투자출연기관 | 서울교통공사 </td></tr>
  <tr><td class="setst"><a onclick="javascript:bidPopup_getBidInfoDtlUrl('5','R26BK01437002','000','2'); ..."><b>제목</b></a></td></tr>
  <tr><td class="daily">공고일자 | 2026-04-02</td><td ...>입찰게시일 | 2026-04-27</td><td ...>개찰일시 | 2026-04-29</td></tr>
*/
function parseItemsFromHtml(html, pageUrl) {
  const items = [];
  const seen = new Set();

  const rowPattern =
    /<tr>\s*<td[^>]*class=["'][^"']*settxt[^"']*["'][^>]*>[\s\S]*?<div[^>]*class=["'][^"']*sticker_[^"']*["'][^>]*>\s*([^<]+?)\s*<\/div>[\s\S]*?-->\s*([^|<]+?)\s*\|\s*([^<]+?)\s*<\/td>\s*<\/tr>\s*<tr>\s*<td[^>]*class=["'][^"']*setst[^"']*["'][^>]*>[\s\S]*?<a[^>]*onclick=["'][^"']*bidPopup_getBidInfoDtlUrl\(\s*'([^']*)'\s*,\s*'([^']*)'\s*,\s*'([^']*)'\s*,\s*'([^']*)'\s*\)[^"']*["'][^>]*>[\s\S]*?<b>([\s\S]*?)<\/b>[\s\S]*?<\/a>[\s\S]*?<\/td>\s*<\/tr>\s*<tr>[\s\S]*?공고일자\s*\|\s*([0-9]{4}-[0-9]{2}-[0-9]{2})[\s\S]*?입찰(?:게시|개시)일\s*\|\s*([0-9]{4}-[0-9]{2}-[0-9]{2})[\s\S]*?개찰일시\s*\|\s*([0-9]{4}-[0-9]{2}-[0-9]{2})[\s\S]*?<\/tr>/gi;

  let match;
  while ((match = rowPattern.exec(html)) !== null) {
    const noticeType = cleanText(match[1]);
    const orgGroup = cleanText(match[2]);
    const issuingOrg = cleanText(match[3]);

    const popupKind = cleanText(match[4]);
    const bidNtceNo = cleanText(match[5]);
    const bidNtceOrd = cleanText(match[6] || '000');
    const popupMode = cleanText(match[7]);

    const title = cleanText(match[8]).replace(/\(\s*\)/g, '').trim();
    const publishedDate = cleanText(match[9]);
    const bidStartDate = cleanText(match[10]);
    const openingDate = cleanText(match[11]);

    if (!bidNtceNo || !title) continue;

    const dedupeKey = `seoul_contract|${bidNtceNo}|${bidNtceOrd}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    items.push({
      bid_ntce_no: bidNtceNo,
      bid_ntce_ord: bidNtceOrd,
      noticeType,
      orgGroup,
      issuingOrg,
      title,
      publishedDate,
      bidStartDate,
      openingDate,
      popupKind,
      popupMode,
      detailUrl: pageUrl
    });
  }

  return items;
}

function mapItemToDoc(item) {
  return {
    bid_ntce_no: item.bid_ntce_no,
    bid_ntce_ord: item.bid_ntce_ord || '000',
    source_system: 'seoul_contract',
    title: item.title || '(제목 없음)',
    notice_type: item.noticeType || '',
    bid_method: '',
    contract_method: item.orgGroup || '',
    issuing_org: item.issuingOrg || '',
    demanding_org: '',
    budget: 0,
    estimated_price: 0,
    budget_formatted: '',
    published_at: parseKstDate(item.publishedDate, false),
    closing_at: parseKstDate(item.openingDate, true),
    opening_at: parseKstDate(item.bidStartDate, false),
    detail_url: item.detailUrl || DESKTOP_URL,
    raw_data: {
      notice_type: item.noticeType,
      org_group: item.orgGroup,
      issuing_org: item.issuingOrg,
      title: item.title,
      published_date: item.publishedDate,
      bid_start_date: item.bidStartDate,
      opening_date: item.openingDate,
      popup_kind: item.popupKind,
      popup_mode: item.popupMode,
      source_page: item.detailUrl || DESKTOP_URL
    },
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

async function crawl(options = {}) {
  const minuteMode = options.minuteMode !== false;
  const recordCount = Math.max(parseInt(process.env.SEOUL_CONTRACT_RECORD_COUNT || '50', 10), 10);
  const maxPages = Math.max(
    parseInt(
      options.maxPages ||
      (minuteMode
        ? process.env.SEOUL_CONTRACT_PAGES_MINUTE || '2'
        : process.env.SEOUL_CONTRACT_PAGES_FULL || '8'),
      10
    ),
    1
  );

  const years = Array.isArray(options.years) && options.years.length
    ? options.years
    : getTargetYears();

  let totalNew = 0;
  let totalUpdated = 0;
  let totalErrors = 0;
  let totalParsed = 0;

  const merged = new Map();
  const pageFingerprints = new Set();

  console.log(`[SEOUL CONTRACT] 수집 시작 — years=${years.join(',')} maxPages=${maxPages} recordCount=${recordCount}`);

  for (const year of years) {
    for (let pageNo = 1; pageNo <= maxPages; pageNo++) {
      try {
        const { url, html } = await fetchPageHtml(pageNo, recordCount, year);

        if (!html) {
          console.log(`[SEOUL CONTRACT] year=${year} page=${pageNo} HTML 없음`);
          break;
        }

        const items = parseItemsFromHtml(html, url);

        if (!items.length) {
          console.log(`[SEOUL CONTRACT] year=${year} page=${pageNo} 결과 없음`);
          break;
        }

        const fingerprint = items
          .slice(0, 5)
          .map(v => `${v.bid_ntce_no}:${v.bid_ntce_ord}`)
          .join('|');

        if (pageFingerprints.has(fingerprint)) {
          console.log(`[SEOUL CONTRACT] year=${year} page=${pageNo} 중복 페이지 감지, 중단`);
          break;
        }
        pageFingerprints.add(fingerprint);

        console.log(`[SEOUL CONTRACT] year=${year} page=${pageNo} ${items.length}건 파싱`);

        for (const item of items) {
          const doc = mapItemToDoc(item);
          const key = `${doc.bid_ntce_no}|${doc.bid_ntce_ord}|${doc.source_system}`;
          merged.set(key, doc);
        }

        await sleep(250);
      } catch (err) {
        totalErrors += 1;
        console.error(`[SEOUL CONTRACT] year=${year} page=${pageNo} 에러:`, err.message);
      }
    }
  }

  const docs = [...merged.values()];
  totalParsed = docs.length;

  for (const doc of docs) {
    try {
      const result = await saveNotice(doc);
      if (result === 'created') totalNew += 1;
      else totalUpdated += 1;
    } catch (err) {
      totalErrors += 1;
      console.error('[SEOUL CONTRACT] DB 저장 에러:', err.message);
    }
  }

  console.log(`[SEOUL CONTRACT] 완료 — 파싱 ${totalParsed}, 신규 ${totalNew}, 갱신 ${totalUpdated}, 에러 ${totalErrors}`);

  return {
    new: totalNew,
    updated: totalUpdated,
    errors: totalErrors,
    parsed: totalParsed
  };
}

module.exports = { crawl };
