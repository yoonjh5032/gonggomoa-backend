const axios = require('axios');
const https = require('https');
const Notice = require('../models/Notice');

const SOURCE_SYSTEM = 'seoul_contract';

const LIST_URL = 'https://contract.seoul.go.kr/new1/views/pubBidInfo.do';
const DETAIL_HOST = 'https://www.g2b.go.kr';

const HTTPS_AGENT = new https.Agent({
  keepAlive: true,
  maxSockets: 20,
});

const REQUEST_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
  Accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
  Referer: 'https://contract.seoul.go.kr/',
  Connection: 'keep-alive',
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nowKst() {
  return new Date(Date.now() + 9 * 60 * 60 * 1000);
}

function getKstYear() {
  return nowKst().getUTCFullYear();
}

function lpad(value, len, ch = '0') {
  return String(value ?? '').padStart(len, ch);
}

function decodeHtml(str) {
  return String(str || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&#x2F;/gi, '/');
}

function stripTags(str) {
  return decodeHtml(String(str || ''))
    .replace(/<br\\s*\\/?>/gi, ' ')
    .replace(/<\\/p>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\\s+/g, ' ')
    .trim();
}

function cleanText(str) {
  return stripTags(str).replace(/\\s+/g, ' ').trim();
}

function normalizeLabel(str) {
  return cleanText(str)
    .replace(/[\\u00A0\\s]+/g, '')
    .replace(/[：:]/g, '')
    .replace(/[()[\\]{}]/g, '')
    .replace(/\\//g, '')
    .trim();
}

function parseDateOnly(dateText) {
  const text = String(dateText || '').trim();
  if (!text) return null;

  const m = text.match(/(\\d{4})[.\\/-](\\d{1,2})[.\\/-](\\d{1,2})/);
  if (!m) return null;

  const [, y, mo, d] = m;
  return new Date(
    `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}T00:00:00+09:00`
  );
}

function parseDateTime(text) {
  const raw = cleanText(text);
  if (!raw) return null;

  const m = raw.match(
    /(\\d{4})[.\\/-]\\s*(\\d{1,2})[.\\/-]\\s*(\\d{1,2})(?:[^\\d오전오후]{0,10}|\\s+)?(?:(오전|오후)\\s*)?(\\d{1,2})?(?::(\\d{2}))?(?::(\\d{2}))?/
  );

  if (!m) {
    return parseDateOnly(raw);
  }

  const [, y, mo, d, meridiem, hh, mm, ss] = m;

  let hour = hh == null || hh === '' ? 0 : Number(hh);
  const minute = mm == null || mm === '' ? 0 : Number(mm);
  const second = ss == null || ss === '' ? 0 : Number(ss);

  if (meridiem === '오후' && hour < 12) hour += 12;
  if (meridiem === '오전' && hour === 12) hour = 0;

  return new Date(
    `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}T${String(hour).padStart(
      2,
      '0'
    )}:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}+09:00`
  );
}

function parseMoney(text) {
  const s = String(text || '');
  const num = s.replace(/[^0-9.-]/g, '');
  if (!num) return 0;
  const n = Number(num);
  return Number.isFinite(n) ? Math.round(n) : 0;
}

function formatMoney(value) {
  const num = Number(value || 0);
  if (!num) return '';
  return `${num.toLocaleString('ko-KR')}원`;
}

function extractDate(text, label) {
  const re = new RegExp(`${label}\\s*\\|\\s*(\\d{4}[.\\/-]\\d{1,2}[.\\/-]\\d{1,2})`);
  const m = String(text || '').match(re);
  return m ? m[1] : '';
}

function buildListUrl({ year, page, recordCount }) {
  const url = new URL(LIST_URL);
  url.searchParams.set('ps_selectForm', '1');
  url.searchParams.set('ps_recordCountPerPage', String(recordCount));
  url.searchParams.set('ps1_fisYear', String(year));
  url.searchParams.set('ps_currentPageNo', String(page));
  return url.toString();
}

function normalizeTaskClCd(taskCl) {
  const t = String(taskCl || '').trim();
  if (t === '5' || t === '10') return '5';
  if (t === '1' || t === '9') return t;
  if (t === '2' || t === '3' || t === '4' || t === '6' || t === '7' || t === '20') return t;
  return t || '5';
}

function buildDetailUrl(taskCl, bidNo, bidSeq) {
  const seq = lpad(String(bidSeq || '000').replace(/\\D/g, ''), 3, '0');
  return `${DETAIL_HOST}/link/PNPE027_01/single/?bidPbancNo=${encodeURIComponent(
    bidNo
  )}&bidPbancOrd=${encodeURIComponent(seq)}&pbancType=pbanc`;
}

function buildLegacyDetailUrls(taskCl, bidNo, bidSeq) {
  const taskClCd = normalizeTaskClCd(taskCl);
  const query =
    `bidno=${encodeURIComponent(bidNo)}` +
    `&bidseq=${encodeURIComponent(bidSeq)}` +
    `&releaseYn=Y&taskClCd=${encodeURIComponent(taskClCd)}`;

  return Array.from(
    new Set([
      `https://www.g2b.go.kr/ep/invitation/publish/bidInfoDtl.do?${query}`,
      `https://www.g2b.go.kr:8082/ep/invitation/publish/bidInfoDtl.do?${query}`,
      `https://www.g2b.go.kr:8081/ep/invitation/publish/bidInfoDtl.do?${query}`,
      `http://www.g2b.go.kr:8081/ep/invitation/publish/bidInfoDtl.do?${query}`,
    ])
  );
}

async function fetchHtml(url, referer = LIST_URL) {
  const res = await axios.get(url, {
    headers: {
      ...REQUEST_HEADERS,
      Referer: referer,
    },
    timeout: Number(process.env.SEOUL_CONTRACT_DETAIL_TIMEOUT_MS || 20000),
    responseType: 'text',
    httpsAgent: HTTPS_AGENT,
    maxRedirects: 5,
    validateStatus: (status) => status >= 200 && status < 400,
  });

  return res.data;
}

async function fetchPageHtml({ year, page, recordCount }) {
  const url = buildListUrl({ year, page, recordCount });
  return fetchHtml(url, 'https://contract.seoul.go.kr/');
}

function parseItemsFromHtml(html) {
  const items = [];
  const seen = new Set();

  const rowPattern =
    /<tr>\\s*<td[^>]*class=\"settxt\"[^>]*>([\\s\\S]*?)<\\/td>\\s*<\\/tr>\\s*<tr>\\s*<td[^>]*class=\"setst\"[^>]*>([\\s\\S]*?)<\\/td>\\s*<\\/tr>\\s*<tr>\\s*<td[^>]*class=\"daily[^\"]*\"[^>]*>([\\s\\S]*?)<\\/td>\\s*<td[^>]*class=\"daily[^\"]*\"[^>]*>([\\s\\S]*?)<\\/td>\\s*<td[^>]*class=\"daily[^\"]*\"[^>]*>([\\s\\S]*?)<\\/td>\\s*<\\/tr>/gi;

  let match;
  while ((match = rowPattern.exec(html)) !== null) {
    const metaHtml = match[1] || '';
    const titleHtml = match[2] || '';
    const daily1 = cleanText(match[3] || '');
    const daily2 = cleanText(match[4] || '');
    const daily3 = cleanText(match[5] || '');

    const onclickMatch = titleHtml.match(
      /bidPopup_getBidInfoDtlUrl\\(\\s*'([^']+)'\\s*,\\s*'([^']+)'\\s*,\\s*'([^']+)'\\s*,\\s*'([^']+)'\\s*\\)/i
    );
    if (!onclickMatch) continue;

    const [, taskCl, bidNo, bidSeq, popupType] = onclickMatch;

    const titleMatch = titleHtml.match(/<b[^>]*>([\\s\\S]*?)<\\/b>/i);
    const title = cleanText(titleMatch ? titleMatch[1] : titleHtml);
    if (!title || !bidNo) continue;

    const noticeTypeMatch = metaHtml.match(/sticker_[^\"]*\">([\\s\\S]*?)<\\/div>/i);
    const noticeType = cleanText(noticeTypeMatch ? noticeTypeMatch[1] : '');

    let metaText = cleanText(metaHtml);
    if (noticeType && metaText.startsWith(noticeType)) {
      metaText = metaText.slice(noticeType.length).trim();
    }

    let orgGroup = '';
    let issuingOrg = '';
    const orgMatch = metaText.match(/(.+?)\\s*\\|\\s*(.+)$/);
    if (orgMatch) {
      orgGroup = cleanText(orgMatch[1]);
      issuingOrg = cleanText(orgMatch[2]);
    } else {
      issuingOrg = metaText;
    }

    const publishedDate = extractDate(daily1, '공고일자');
    const bidStartDate = extractDate(daily2, '입찰게시일');
    const openingDate = extractDate(daily3, '개찰일시');

    const detailUrl = buildDetailUrl(taskCl, bidNo, bidSeq);
    const legacyDetailUrls = buildLegacyDetailUrls(taskCl, bidNo, bidSeq);
    const dedupeKey = `${bidNo}::${bidSeq}`;

    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    items.push({
      bidNo,
      bidSeq,
      taskCl,
      popupType,
      title,
      noticeType,
      orgGroup,
      issuingOrg,
      publishedDate,
      bidStartDate,
      openingDate,
      detailUrl,
      legacyDetailUrls,
      raw: {
        source: LIST_URL,
        meta_text: metaText,
        daily1,
        daily2,
        daily3,
      },
    });
  }

  return items;
}

function mapListItemToDoc(item) {
  const publishedAt = parseDateOnly(item.publishedDate);
  const openingAt = parseDateOnly(item.openingDate);
  const bidStartAt = parseDateOnly(item.bidStartDate);

  return {
    bid_ntce_no: item.bidNo,
    bid_ntce_ord: String(item.bidSeq || '000'),
    source_system: SOURCE_SYSTEM,
    title: item.title,
    notice_type: item.noticeType || '',
    bid_method: item.orgGroup || '',
    contract_method: '',
    issuing_org: item.issuingOrg || '',
    demanding_org: item.issuingOrg || '',
    budget: 0,
    estimated_price: 0,
    budget_formatted: '',
    published_at: publishedAt,
    closing_at: openingAt || bidStartAt || publishedAt,
    opening_at: openingAt,
    detail_url: item.detailUrl,
    raw_data: {
      ...item.raw,
      task_cl: item.taskCl,
      popup_type: item.popupType,
      bid_no: item.bidNo,
      bid_seq: String(item.bidSeq || '000'),
      detail_url: item.detailUrl,
      legacy_detail_urls: item.legacyDetailUrls,
      org_group: item.orgGroup || '',
      bid_start_date: item.bidStartDate || '',
      opening_date: item.openingDate || '',
      detail_enriched: false,
    },
    collected_at: new Date(),
  };
}

function extractFieldMap(html) {
  const map = new Map();

  const put = (label, value) => {
    const key = normalizeLabel(label);
    const val = cleanText(value);
    if (!key || !val) return;
    if (!map.has(key)) {
      map.set(key, val);
    }
  };

  const thTdPattern = /<th[^>]*>([\\s\\S]*?)<\\/th>\\s*<td[^>]*>([\\s\\S]*?)<\\/td>/gi;
  let m;
  while ((m = thTdPattern.exec(html)) !== null) {
    put(m[1], m[2]);
  }

  const dtDdPattern = /<dt[^>]*>([\\s\\S]*?)<\\/dt>\\s*<dd[^>]*>([\\s\\S]*?)<\\/dd>/gi;
  while ((m = dtDdPattern.exec(html)) !== null) {
    put(m[1], m[2]);
  }

  return map;
}

function getField(map, aliases) {
  for (const alias of aliases) {
    const key = normalizeLabel(alias);
    if (map.has(key)) return map.get(key);
  }
  return '';
}

function parseDetailHtml(html) {
  const map = extractFieldMap(html);

  const issuingOrg =
    getField(map, ['공고기관', '공고기관명', '발주기관', '발주기관명']) || '';

  const demandingOrg =
    getField(map, ['수요기관', '수요기관명', '수요기관(실수요기관)', '실수요기관']) || '';

  const bidMethod =
    getField(map, ['입찰방식', '입찰방법']) || '';

  const contractMethod =
    getField(map, ['계약방법', '계약방식']) || '';

  const bidBeginRaw =
    getField(map, ['입찰개시일시', '전자입찰개시일시', '입찰서접수개시일시']) || '';

  const closingRaw =
    getField(map, ['입찰마감일시', '전자입찰마감일시', '입찰서접수마감일시']) || '';

  const openingRaw =
    getField(map, ['개찰일시', '개찰(입찰)일시', '개찰일시(제안서 제출 마감일시)']) || '';

  const publishedRaw =
    getField(map, ['공고일시', '공고일자']) || '';

  const budgetRaw =
    getField(map, ['기초금액', '예비가격기초금액', '기초금액(부가가치세 포함)']) || '';

  const estimatedPriceRaw =
    getField(map, ['추정가격', '추정금액', '추정가격(부가세 제외)']) || '';

  const managerRaw =
    getField(map, ['공고담당자', '담당자', '계약담당자']) || '';

  const phoneRaw =
    getField(map, ['전화번호', '담당자전화번호', '공고기관담당자전화번호']) || '';

  return {
    issuingOrg,
    demandingOrg,
    bidMethod,
    contractMethod,
    bidBeginAt: parseDateTime(bidBeginRaw),
    closingAt: parseDateTime(closingRaw),
    openingAt: parseDateTime(openingRaw),
    publishedAt: parseDateTime(publishedRaw),
    budget: parseMoney(budgetRaw),
    estimatedPrice: parseMoney(estimatedPriceRaw),
    manager: managerRaw,
    phone: phoneRaw,
    fieldMap: Object.fromEntries(map.entries()),
  };
}

function hasMeaningfulDetail(detail) {
  return Boolean(
    detail &&
      (
        detail.issuingOrg ||
        detail.demandingOrg ||
        detail.bidMethod ||
        detail.contractMethod ||
        detail.closingAt ||
        detail.openingAt ||
        detail.publishedAt ||
        detail.budget ||
        detail.estimatedPrice ||
        detail.manager ||
        detail.phone
      )
  );
}

function mergeDoc(baseDoc, detail, sourceUrl) {
  const doc = {
    ...baseDoc,
    issuing_org: detail.issuingOrg || baseDoc.issuing_org,
    demanding_org: detail.demandingOrg || baseDoc.demanding_org,
    bid_method: detail.bidMethod || baseDoc.bid_method,
    contract_method: detail.contractMethod || baseDoc.contract_method,
    published_at: detail.publishedAt || baseDoc.published_at,
    closing_at: detail.closingAt || baseDoc.closing_at,
    opening_at: detail.openingAt || baseDoc.opening_at,
    budget: detail.budget || baseDoc.budget,
    estimated_price: detail.estimatedPrice || baseDoc.estimated_price,
    budget_formatted:
      detail.budget
        ? formatMoney(detail.budget)
        : detail.estimatedPrice
        ? formatMoney(detail.estimatedPrice)
        : baseDoc.budget_formatted,
    raw_data: {
      ...(baseDoc.raw_data || {}),
      detail_enriched: true,
      detail_source_url: sourceUrl,
      detail_manager: detail.manager || '',
      detail_phone: detail.phone || '',
      detail_field_map: detail.fieldMap || {},
      detail_enriched_at: new Date().toISOString(),
    },
    collected_at: new Date(),
  };

  return doc;
}

async function fetchAndParseDetail(item) {
  const candidates = [item.detailUrl, ...(item.legacyDetailUrls || [])];

  for (const url of candidates) {
    try {
      const html = await fetchHtml(url, LIST_URL);
      if (!html || html.length < 1000) continue;

      const detail = parseDetailHtml(html);
      if (hasMeaningfulDetail(detail)) {
        return {
          ok: true,
          url,
          detail,
        };
      }
    } catch (err) {
      // 다음 후보 URL로 계속 진행
    }
  }

  return {
    ok: false,
    url: '',
    detail: null,
  };
}

function shouldFetchDetail(existing, forceRefreshDetail) {
  if (forceRefreshDetail) return true;
  if (!existing) return true;

  const raw = existing.raw_data || {};
  if (!raw.detail_enriched) return true;
  if (!existing.closing_at) return true;
  if (!existing.issuing_org) return true;
  if (!existing.demanding_org) return true;
  if (!existing.budget && !existing.estimated_price) return true;

  return false;
}

async function saveNotice(doc) {
  const where = {
    bid_ntce_no: doc.bid_ntce_no,
    bid_ntce_ord: doc.bid_ntce_ord,
    source_system: doc.source_system,
  };

  const existing = await Notice.findOne({ where });

  if (!existing) {
    await Notice.create(doc);
    return 'new';
  }

  await existing.update(doc);
  return 'updated';
}

async function upsertItem(item, options = {}) {
  const baseDoc = mapListItemToDoc(item);

  const where = {
    bid_ntce_no: baseDoc.bid_ntce_no,
    bid_ntce_ord: baseDoc.bid_ntce_ord,
    source_system: baseDoc.source_system,
  };

  const existing = await Notice.findOne({ where });

  let finalDoc = baseDoc;
  const fetchDetailEnabled = options.fetchDetail !== false;
  const forceRefreshDetail = options.forceRefreshDetail === true;

  if (fetchDetailEnabled && shouldFetchDetail(existing, forceRefreshDetail)) {
    const detailResult = await fetchAndParseDetail(item);

    if (detailResult.ok) {
      finalDoc = mergeDoc(baseDoc, detailResult.detail, detailResult.url);
    } else {
      finalDoc = {
        ...baseDoc,
        raw_data: {
          ...(baseDoc.raw_data || {}),
          detail_enriched: false,
          detail_fetch_failed_at: new Date().toISOString(),
        },
      };
    }

    const delay = Number(process.env.SEOUL_CONTRACT_DETAIL_DELAY_MS || 120);
    if (delay > 0) {
      await sleep(delay);
    }
  } else if (existing) {
    finalDoc = {
      ...baseDoc,
      budget: existing.budget || baseDoc.budget,
      estimated_price: existing.estimated_price || baseDoc.estimated_price,
      budget_formatted: existing.budget_formatted || baseDoc.budget_formatted,
      issuing_org: existing.issuing_org || baseDoc.issuing_org,
      demanding_org: existing.demanding_org || baseDoc.demanding_org,
      bid_method: existing.bid_method || baseDoc.bid_method,
      contract_method: existing.contract_method || baseDoc.contract_method,
      published_at: existing.published_at || baseDoc.published_at,
      closing_at: existing.closing_at || baseDoc.closing_at,
      opening_at: existing.opening_at || baseDoc.opening_at,
      raw_data: {
        ...(existing.raw_data || {}),
        ...(baseDoc.raw_data || {}),
      },
    };
  }

  const result = await saveNotice(finalDoc);
  return result;
}

async function crawl(options = {}) {
  const minuteMode = options.minuteMode !== false;

  const years =
    Array.isArray(options.years) && options.years.length
      ? options.years.map((v) => Number(v)).filter(Boolean)
      : [Number(options.year) || getKstYear()];

  const maxPages = Number(
    options.maxPages ||
      process.env[minuteMode ? 'SEOUL_CONTRACT_PAGES_MINUTE' : 'SEOUL_CONTRACT_PAGES_FULL'] ||
      (minuteMode ? 2 : 8)
  );

  const recordCount = Number(
    options.recordCount ||
      process.env.SEOUL_CONTRACT_RECORD_COUNT ||
      50
  );

  const fetchDetail =
    options.fetchDetail !== undefined
      ? options.fetchDetail
      : process.env.SEOUL_CONTRACT_FETCH_DETAIL !== 'false';

  const forceRefreshDetail =
    options.forceRefreshDetail !== undefined
      ? options.forceRefreshDetail
      : process.env.SEOUL_CONTRACT_FORCE_DETAIL_REFRESH === 'true';

  console.log(
    `[SEOUL CONTRACT] 수집 시작 — years=${years.join(',')} maxPages=${maxPages} recordCount=${recordCount} detail=${fetchDetail ? 'on' : 'off'}`
  );

  let parsedCount = 0;
  let newCount = 0;
  let updatedCount = 0;
  let errorCount = 0;

  const globalSeen = new Set();

  for (const year of years) {
    for (let page = 1; page <= maxPages; page += 1) {
      try {
        const html = await fetchPageHtml({ year, page, recordCount });
        const items = parseItemsFromHtml(html);

        if (!items.length) {
          console.log(`[SEOUL CONTRACT] year=${year} page=${page} 결과 없음`);
          break;
        }

        console.log(`[SEOUL CONTRACT] year=${year} page=${page} ${items.length}건 파싱`);
        parsedCount += items.length;

        for (const item of items) {
          const uniq = `${item.bidNo}::${item.bidSeq}`;
          if (globalSeen.has(uniq)) continue;
          globalSeen.add(uniq);

          try {
            const result = await upsertItem(item, {
              fetchDetail,
              forceRefreshDetail,
            });

            if (result === 'new') newCount += 1;
            else updatedCount += 1;
          } catch (err) {
            errorCount += 1;
            console.error(
              `[SEOUL CONTRACT] 저장 실패 — ${item.bidNo}/${item.bidSeq} ${item.title}`,
              err.message
            );
          }
        }

        if (items.length < recordCount) break;

        await sleep(250);
      } catch (err) {
        errorCount += 1;
        console.error(`[SEOUL CONTRACT] year=${year} page=${page} 요청 실패`, err.message);
        break;
      }
    }
  }

  console.log(
    `[SEOUL CONTRACT] 완료 — 파싱 ${parsedCount}, 신규 ${newCount}, 갱신 ${updatedCount}, 에러 ${errorCount}`
  );

  return {
    parsedCount,
    newCount,
    updatedCount,
    errorCount,
  };
}

module.exports = {
  crawl,
  buildDetailUrl,
};
