const axios = require('axios');
const { createHash } = require('crypto');
const Notice = require('../models/Notice');

const DESKTOP_URL = 'https://contract.seoul.go.kr/new1/views/pubBidInfo.do';
const MOBILE_URL = 'https://contract.seoul.go.kr/m/views/pubBidInfo.do';
const BASE_ORIGIN = 'https://contract.seoul.go.kr';

const REQUEST_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
  'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
};

const NOTICE_TYPES = new Set(['공사', '용역', '물품']);

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function decodeHtmlEntities(text) {
  return String(text || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

function cleanText(text) {
  return decodeHtmlEntities(text)
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\s*\|\s*/g, ' | ')
    .trim();
}

function stripTags(html) {
  return String(html || '').replace(/<[^>]+>/g, ' ');
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

function buildCandidateUrls(pageNo, recordCount, year) {
  const urls = [];

  const qs1 = new URLSearchParams({
    ps_selectForm: '1',
    ps_recordCountPerPage: String(recordCount),
    ps1_fisYear: String(year),
    ps_currentPageNo: String(pageNo)
  });

  const qs2 = new URLSearchParams({
    ps_selectForm: '1',
    ps_recordCountPerPage: String(recordCount),
    ps_currentPageNo: String(pageNo)
  });

  const qs3 = new URLSearchParams({
    ps_currentPageNo: String(pageNo)
  });

  urls.push(`${DESKTOP_URL}?${qs1.toString()}`);
  urls.push(`${DESKTOP_URL}?${qs2.toString()}`);
  urls.push(`${DESKTOP_URL}?${qs3.toString()}`);
  urls.push(`${MOBILE_URL}?${qs1.toString()}`);
  urls.push(`${MOBILE_URL}?${qs2.toString()}`);
  urls.push(pageNo === 1 ? DESKTOP_URL : `${DESKTOP_URL}?${qs3.toString()}`);

  return [...new Set(urls)];
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

function resolveMaybeUrl(value, fallbackUrl) {
  const raw = String(value || '').trim();
  if (!raw || raw === '#') return fallbackUrl;

  if (/^https?:\/\//i.test(raw)) return raw;

  if (raw.startsWith('/')) {
    return new URL(raw, BASE_ORIGIN).toString();
  }

  if (raw.toLowerCase().startsWith('javascript:')) {
    const abs = raw.match(/https?:\/\/[^'")\s]+/i);
    if (abs) return abs[0];

    const rel = raw.match(/\/[^'")\s]+\.do(?:\?[^'")\s]*)?/i);
    if (rel) return new URL(rel[0], BASE_ORIGIN).toString();

    return fallbackUrl;
  }

  return new URL(raw, BASE_ORIGIN).toString();
}

function buildTitleUrlMap(html, fallbackUrl) {
  const map = new Map();
  const re = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let match;

  while ((match = re.exec(html))) {
    const attrs = match[1] || '';
    const innerText = cleanText(stripTags(match[2] || ''));

    if (!innerText || innerText.length < 5) continue;
    if (/^(본문 바로가기|전체메뉴|더보기|\d+|서울계약마당)$/.test(innerText)) continue;

    let url = '';
    const hrefMatch = attrs.match(/\bhref\s*=\s*["']([^"']+)["']/i);
    const onclickMatch = attrs.match(/\bonclick\s*=\s*["']([^"']+)["']/i);

    if (hrefMatch) {
      url = resolveMaybeUrl(hrefMatch[1], fallbackUrl);
    }

    if ((!url || url === fallbackUrl) && onclickMatch) {
      const onclick = onclickMatch[1];
      const abs = onclick.match(/https?:\/\/[^'")\s]+/i);
      if (abs) {
        url = abs[0];
      } else {
        const rel = onclick.match(/\/[^'")\s]+\.do(?:\?[^'")\s]*)?/i);
        if (rel) {
          url = new URL(rel[0], BASE_ORIGIN).toString();
        }
      }
    }

    if (!url) url = fallbackUrl;

    if (!map.has(innerText)) {
      map.set(innerText, url);
    }
  }

  return map;
}

function htmlToLines(html) {
  const text = String(html || '')
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(td|th)>/gi, ' | ')
    .replace(/<\/(tr|li|ul|ol|p|div|section|article|table|thead|tbody|tfoot|h1|h2|h3|h4|h5|h6)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');

  return decodeHtmlEntities(text)
    .split('\n')
    .map(cleanText)
    .filter(Boolean);
}

function extractDates(text) {
  const flat = cleanText(text);
  const match = flat.match(
    /공고일자\s*\|\s*(\d{4}-\d{2}-\d{2}).*?입찰(?:게시|개시)일\s*\|\s*(\d{4}-\d{2}-\d{2}).*?개찰일시\s*\|\s*(\d{4}-\d{2}-\d{2})/
  );

  if (!match) return null;

  return {
    publishedDate: match[1],
    bidStartDate: match[2],
    openingDate: match[3]
  };
}

function normalizeTitle(title) {
  return cleanText(String(title || '').replace(/\(\s*\)/g, ''));
}

function parseItemsFromLines(lines, titleUrlMap, fallbackUrl) {
  const items = [];
  const dedupe = new Set();

  for (let i = 0; i < lines.length; i++) {
    const dateInfo = extractDates(
      [lines[i], lines[i + 1], lines[i + 2]].filter(Boolean).join(' | ')
    );

    if (!dateInfo) continue;

    const context = [];
    for (let j = i - 1; j >= 0 && context.length < 5; j--) {
      const line = cleanText(lines[j]);

      if (!line) continue;
      if (/^(기관명|사업명|입찰공고 관련 리스트 테이블|목록 표시 개수|총 \d+건|입찰공고|서울계약마당|전체)$/.test(line)) continue;
      if (/^공고일자/.test(line)) continue;

      context.unshift(line);

      if (NOTICE_TYPES.has(line)) break;
    }

    const typeIndex = context.findIndex(line => NOTICE_TYPES.has(line));
    if (typeIndex === -1) continue;

    const noticeType = context[typeIndex];
    const afterType = context.slice(typeIndex + 1);
    if (!afterType.length) continue;

    let orgGroup = '';
    let issuingOrg = '';
    let title = '';

    const first = afterType[0] || '';
    if (first.includes('|')) {
      const parts = first.split('|').map(cleanText).filter(Boolean);
      orgGroup = parts[0] || '';
      issuingOrg = parts[1] || '';
      title = afterType.slice(1).map(cleanText).filter(Boolean).join(' ');
    } else if (afterType.length >= 3) {
      orgGroup = cleanText(afterType[0]);
      issuingOrg = cleanText(afterType[1]);
      title = afterType.slice(2).map(cleanText).filter(Boolean).join(' ');
    } else if (afterType.length === 2) {
      issuingOrg = cleanText(afterType[0]);
      title = cleanText(afterType[1]);
    } else {
      title = cleanText(afterType[0]);
    }

    title = normalizeTitle(title);
    issuingOrg = cleanText(issuingOrg);
    orgGroup = cleanText(orgGroup);

    if (!title || title.length < 5) continue;

    const detailUrl = titleUrlMap.get(title) || fallbackUrl;
    const dedupeKey = [
      noticeType,
      orgGroup,
      issuingOrg,
      title,
      dateInfo.publishedDate,
      dateInfo.bidStartDate,
      dateInfo.openingDate
    ].join('|');

    if (dedupe.has(dedupeKey)) continue;
    dedupe.add(dedupeKey);

    items.push({
      noticeType,
      orgGroup,
      issuingOrg,
      title,
      publishedDate: dateInfo.publishedDate,
      bidStartDate: dateInfo.bidStartDate,
      openingDate: dateInfo.openingDate,
      detailUrl
    });
  }

  return items;
}

async function fetchPageItems(pageNo, recordCount, year) {
  let lastError = null;

  for (const url of buildCandidateUrls(pageNo, recordCount, year)) {
    try {
      const html = await fetchHtml(url);

      if (!html || !/입찰공고/.test(html)) continue;

      const titleUrlMap = buildTitleUrlMap(html, url);
      const lines = htmlToLines(html);
      const items = parseItemsFromLines(lines, titleUrlMap, url);

      if (items.length > 0) {
        return { url, items };
      }
    } catch (err) {
      lastError = err;
    }
  }

  if (lastError) throw lastError;
  return { url: DESKTOP_URL, items: [] };
}

function buildNoticeId(item) {
  return createHash('sha1')
    .update([
      'seoul_contract',
      item.noticeType,
      item.orgGroup,
      item.issuingOrg,
      item.title,
      item.publishedDate,
      item.bidStartDate,
      item.openingDate
    ].join('|'))
    .digest('hex')
    .slice(0, 40);
}

function mapItemToDoc(item, pageUrl) {
  return {
    bid_ntce_no: buildNoticeId(item),
    bid_ntce_ord: '00',
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
    detail_url: item.detailUrl || pageUrl || DESKTOP_URL,
    raw_data: {
      ...item,
      pageUrl
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

  const dedupeDocs = new Map();

  console.log(`[SEOUL CONTRACT] 수집 시작 — years=${years.join(',')} maxPages=${maxPages} recordCount=${recordCount}`);

  for (const year of years) {
    let emptyStreak = 0;

    for (let pageNo = 1; pageNo <= maxPages; pageNo++) {
      try {
        const { url, items } = await fetchPageItems(pageNo, recordCount, year);

        if (!items.length) {
          emptyStreak += 1;
          console.log(`[SEOUL CONTRACT] year=${year} page=${pageNo} 결과 없음`);
          if (emptyStreak >= 1) break;
          continue;
        }

        emptyStreak = 0;
        console.log(`[SEOUL CONTRACT] year=${year} page=${pageNo} ${items.length}건 파싱`);

        for (const item of items) {
          const doc = mapItemToDoc(item, url);
          const key = `${doc.bid_ntce_no}|${doc.bid_ntce_ord}|${doc.source_system}`;
          dedupeDocs.set(key, doc);
        }

        await sleep(250);
      } catch (err) {
        totalErrors += 1;
        console.error(`[SEOUL CONTRACT] year=${year} page=${pageNo} 에러:`, err.message);
      }
    }
  }

  const docs = [...dedupeDocs.values()];
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
