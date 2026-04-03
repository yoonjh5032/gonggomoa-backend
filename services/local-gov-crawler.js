const axios = require('axios');
const https = require('https');
const crypto = require('crypto');
const { URL } = require('url');

const Notice = require('../models/Notice');
const sourceMap = require('../collectors/local-gov/sources');

const SOURCE_SYSTEM = 'local_gov';

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
  Connection: 'keep-alive',
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cleanText(str) {
  return decodeHtml(String(str || ''))
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/p>/gi, ' ')
    .replace(/<\/div>/gi, ' ')
    .replace(/<\/li>/gi, ' ')
    .replace(/<\/tr>/gi, ' ')
    .replace(/<\/td>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
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
    .replace(/&#x2F;/gi, '/')
    .replace(/&#40;/gi, '(')
    .replace(/&#41;/gi, ')');
}

function sha1(value) {
  return crypto.createHash('sha1').update(String(value || '')).digest('hex');
}

function absoluteUrl(url, baseUrl) {
  if (!url) return '';
  const raw = decodeHtml(url).trim();
  if (!raw) return '';

  try {
    return new URL(raw, baseUrl).toString();
  } catch (_) {
    return '';
  }
}

function getSourceList() {
  return Array.isArray(sourceMap.sources) ? sourceMap.sources : [];
}

function getDefaultOptions() {
  return sourceMap.defaults || {};
}

async function fetchHtml(url, referer = '') {
  const res = await axios.get(url, {
    headers: {
      ...REQUEST_HEADERS,
      ...(referer ? { Referer: referer } : {}),
    },
    timeout: Number(getDefaultOptions().parser_timeout_ms || 20000),
    responseType: 'text',
    httpsAgent: HTTPS_AGENT,
    maxRedirects: 5,
    validateStatus: (status) => status >= 200 && status < 400,
  });

  return res.data;
}

function buildPagedUrl(listUrl, pageParam, pageNo) {
  if (!listUrl) return '';
  if (!pageParam || pageNo <= 1) return listUrl;

  try {
    const url = new URL(listUrl);
    url.searchParams.set(pageParam, String(pageNo));
    return url.toString();
  } catch (_) {
    return listUrl;
  }
}

function extractTitle(html) {
  const h1 =
    html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) ||
    html.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i) ||
    html.match(/<strong[^>]*class="[^"]*title[^"]*"[^>]*>([\s\S]*?)<\/strong>/i) ||
    html.match(/<div[^>]*class="[^"]*title[^"]*"[^>]*>([\s\S]*?)<\/div>/i);

  if (h1) {
    const v = cleanText(h1[1]);
    if (v) return v;
  }

  const og = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i);
  if (og) {
    const v = cleanText(og[1]);
    if (v) return v;
  }

  const titleTag = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (titleTag) {
    return cleanText(titleTag[1]);
  }

  return '';
}

function extractBodyText(html) {
  return cleanText(html);
}

function extractAnchors(html, baseUrl) {
  const items = [];
  const seen = new Set();
  const anchorRegex = /<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi;

  let m;
  while ((m = anchorRegex.exec(html)) !== null) {
    const href = absoluteUrl(m[1], baseUrl);
    const text = cleanText(m[2]);

    if (!href) continue;
    if (seen.has(href)) continue;
    seen.add(href);

    items.push({ href, text });
  }

  return items;
}

function extractListLinksGeneric(html, source) {
  const baseUrl = source.list_url || source.detail_hint?.entry_url || '';
  const links = extractAnchors(html, baseUrl);
  const itemPattern = source.detail_hint?.item_link_pattern || null;

  return links.filter((item) => {
    if (!item.href) return false;
    if (itemPattern && !itemPattern.test(item.href)) return false;
    return true;
  });
}

function extractCandidateLinksFromList(html, source) {
  switch (source.parser_type) {
    case 'gwanak_bbsnew_list':
    case 'egov_gosi_list':
    case 'seocho_ex_bbs_list':
    case 'yongsan_health_bbs_list':
      return extractListLinksGeneric(html, source);
    default:
      return extractListLinksGeneric(html, source);
  }
}

function getSeedDetailLinks(source) {
  const detailHint = source.detail_hint || {};
  const urls = Array.isArray(detailHint.seed_detail_urls) ? detailHint.seed_detail_urls : [];
  return urls
    .map((v) => absoluteUrl(v, detailHint.entry_url || source.list_url || ''))
    .filter(Boolean);
}

function getSeedAttachmentLinks(source) {
  const detailHint = source.detail_hint || {};
  const urls = Array.isArray(detailHint.seed_attachment_urls) ? detailHint.seed_attachment_urls : [];
  return urls
    .map((v) => absoluteUrl(v, detailHint.entry_url || source.list_url || ''))
    .filter(Boolean);
}

function shouldUseSeedOnlyParser(source) {
  return [
    'seed_detail_and_attachment',
    'seed_detail_notice',
    'jungnang_portal_bbs_seed',
    'legacy_detail_seed',
  ].includes(source.parser_type);
}

async function collectCandidateLinks(source, options = {}) {
  const maxPages = Number(options.maxPages || 3);
  const requestDelayMs = Number(getDefaultOptions().request_delay_ms || 250);

  const collected = [];
  const seen = new Set();

  const push = (url) => {
    if (!url || seen.has(url)) return;
    seen.add(url);
    collected.push(url);
  };

  // seed-only 파서는 상세 시드만 사용
  if (shouldUseSeedOnlyParser(source)) {
    getSeedDetailLinks(source).forEach(push);
    return collected;
  }

  // list_url이 있으면 목록 탐색
  if (source.list_url) {
    const pageParam = source.detail_hint?.page_param || null;

    for (let page = 1; page <= maxPages; page += 1) {
      const pagedUrl = buildPagedUrl(source.list_url, pageParam, page);

      try {
        const html = await fetchHtml(pagedUrl, source.detail_hint?.entry_url || source.list_url);
        const links = extractCandidateLinksFromList(html, source);

        if (!links.length) {
          if (page === 1) {
            // 1페이지에 링크가 하나도 없으면 seed fallback
            getSeedDetailLinks(source).forEach(push);
          }
          break;
        }

        links.forEach((item) => push(item.href));

        if (requestDelayMs > 0) {
          await sleep(requestDelayMs);
        }
      } catch (err) {
        console.error(`[LOCAL GOV] 목록 요청 실패 — ${source.key} page=${page}`, err.message);
        if (page === 1) {
          getSeedDetailLinks(source).forEach(push);
        }
        break;
      }
    }
  } else {
    getSeedDetailLinks(source).forEach(push);
  }

  return collected;
}

function extractFieldValue(html, labels = []) {
  for (const label of labels) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    const thTd = new RegExp(
      `<th[^>]*>\\s*${escaped}\\s*<\\/th>\\s*<td[^>]*>([\\s\\S]*?)<\\/td>`,
      'i'
    );
    const dtDd = new RegExp(
      `<dt[^>]*>\\s*${escaped}\\s*<\\/dt>\\s*<dd[^>]*>([\\s\\S]*?)<\\/dd>`,
      'i'
    );
    const inline = new RegExp(`${escaped}\\s*[:：]\\s*([^\\n<]{1,200})`, 'i');

    const m1 = html.match(thTd);
    if (m1) {
      const v = cleanText(m1[1]);
      if (v) return v;
    }

    const m2 = html.match(dtDd);
    if (m2) {
      const v = cleanText(m2[1]);
      if (v) return v;
    }

    const m3 = cleanText(html).match(inline);
    if (m3) {
      const v = cleanText(m3[1]);
      if (v) return v;
    }
  }

  return '';
}

function parseDateTime(text) {
  const raw = cleanText(text);
  if (!raw) return null;

  const m = raw.match(
    /(\d{4})[.\-/]\s*(\d{1,2})[.\-/]\s*(\d{1,2})(?:\s*\(?[가-힣]*\)?)?(?:\s+|.*?)(?:(오전|오후)\s*)?(\d{1,2})?(?::(\d{2}))?(?::(\d{2}))?/
  );

  if (!m) {
    const d = raw.match(/(\d{4})[.\-/](\d{1,2})[.\-/](\d{1,2})/);
    if (!d) return null;
    const [, y, mo, day] = d;
    return new Date(
      `${y}-${String(mo).padStart(2, '0')}-${String(day).padStart(2, '0')}T00:00:00+09:00`
    );
  }

  const [, y, mo, day, meridiem, hh, mm, ss] = m;
  let hour = hh ? Number(hh) : 0;
  const minute = mm ? Number(mm) : 0;
  const second = ss ? Number(ss) : 0;

  if (meridiem === '오후' && hour < 12) hour += 12;
  if (meridiem === '오전' && hour === 12) hour = 0;

  return new Date(
    `${y}-${String(mo).padStart(2, '0')}-${String(day).padStart(2, '0')}T${String(hour).padStart(
      2,
      '0'
    )}:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}+09:00`
  );
}

function extractPublishedAt(html) {
  const raw = extractFieldValue(html, ['등록일', '작성일', '게시일', '공고일', '공고일자']);
  return parseDateTime(raw);
}

function extractClosingAt(html) {
  const labelHit = extractFieldValue(html, [
    '마감일시',
    '접수마감',
    '제출기한',
    '접수기간',
    '신청기간',
    '공고기간',
    '접수마감일시',
    '모집기간',
  ]);

  if (labelHit) return parseDateTime(labelHit);

  const body = cleanText(html);

  const periodMatch = body.match(
    /(접수기간|신청기간|공고기간|모집기간)\s*[:：]?\s*(\d{4}[.\-/]\d{1,2}[.\-/]\d{1,2}[^~～]{0,30})\s*[~～]\s*(\d{4}[.\-/]\d{1,2}[.\-/]\d{1,2}[^ ]{0,30})/i
  );
  if (periodMatch) {
    return parseDateTime(periodMatch[3]);
  }

  const deadlineMatch = body.match(
    /(제출기한|마감일시|접수마감|마감)\s*[:：]?\s*(\d{4}[.\-/]\d{1,2}[.\-/]\d{1,2}[^ ]{0,30})/i
  );
  if (deadlineMatch) {
    return parseDateTime(deadlineMatch[2]);
  }

  return null;
}

function extractAttachments(html, baseUrl) {
  const anchors = extractAnchors(html, baseUrl);

  return anchors
    .filter((a) => {
      if (!a.href) return false;
      if (/\.(pdf|hwp|hwpx|doc|docx|xls|xlsx|zip)$/i.test(a.href)) return true;
      if (/download|fileDown|getFile|downloadBbsFile|FileDown/i.test(a.href)) return true;
      if (/(첨부|붙임|공고문|제안요청서|과업지시서|제안서)/i.test(a.text)) return true;
      return false;
    })
    .map((a) => ({
      name: a.text || '첨부파일',
      url: a.href,
    }));
}

function inferNoticeType(title, bodyText = '') {
  const text = `${title} ${bodyText}`;

  if (/평가위원/.test(text)) return '평가위원 모집';
  if (/위탁운영기관|수탁기관/.test(text)) return '위탁운영기관 모집';
  if (/입찰공고|입찰/.test(text)) return '입찰공고';
  if (/용역/.test(text)) return '용역공고';
  if (/사업자 모집/.test(text)) return '사업자 모집';
  if (/제안서/.test(text)) return '제안서 모집';
  return '일반공고';
}

function extractStableId(detailUrl, source) {
  const hint = source.detail_hint || {};

  if (hint.id_pattern instanceof RegExp) {
    const m = detailUrl.match(hint.id_pattern);
    if (m && m[1]) return `${source.key}-${m[1]}`;
  }

  const url = detailUrl || '';
  const qsPatterns = [
    /[?&]nttId=(\d+)/i,
    /[?&]nttNo=(\d+)/i,
    /[?&]bcIdx=(\d+)/i,
    /[?&]idx=(\d+)/i,
    /[?&]sdmBoardSeq=(\d+)/i,
    /[?&]id=(\d+)/i,
  ];

  for (const re of qsPatterns) {
    const m = url.match(re);
    if (m && m[1]) return `${source.key}-${m[1]}`;
  }

  return `${source.key}-${sha1(url).slice(0, 24)}`;
}

function isActiveNotice(closingAt) {
  if (!closingAt) return true;
  return closingAt.getTime() >= Date.now();
}

function shouldKeepNotice(source, title, bodyText) {
  const defaults = getDefaultOptions();
  const includeRegex = source.include_regex || defaults.include_regex;
  const excludeRegex = source.exclude_regex || defaults.exclude_regex;

  const titleText = cleanText(title);
  const body = cleanText(bodyText);

  if (excludeRegex && (excludeRegex.test(titleText) || excludeRegex.test(body))) {
    return false;
  }

  if (includeRegex && includeRegex.test(titleText)) {
    return true;
  }

  if (defaults.body_fallback_filter && includeRegex && includeRegex.test(body)) {
    return true;
  }

  return false;
}

function parseDetailGeneric(html, detailUrl, source) {
  const title = extractTitle(html);
  const bodyText = extractBodyText(html);
  const publishedAt = extractPublishedAt(html);
  const closingAt = extractClosingAt(html);
  const attachments = extractAttachments(html, detailUrl);

  const issuingOrg =
    extractFieldValue(html, ['담당부서', '부서', '공고기관', '발주부서']) ||
    `${source.district_name}청`;

  const manager =
    extractFieldValue(html, ['담당자', '작성자']) || '';

  const phone =
    extractFieldValue(html, ['전화번호', '연락처']) || '';

  const noticeType = inferNoticeType(title, bodyText);

  return {
    title,
    bodyText,
    publishedAt,
    closingAt,
    attachments,
    issuingOrg,
    manager,
    phone,
    noticeType,
  };
}

function parseDetailByType(html, detailUrl, source) {
  switch (source.parser_type) {
    case 'gwanak_bbsnew_list':
    case 'egov_gosi_list':
    case 'seed_detail_and_attachment':
    case 'seed_detail_notice':
    case 'seocho_ex_bbs_list':
    case 'yongsan_health_bbs_list':
    case 'jungnang_portal_bbs_seed':
    case 'legacy_detail_seed':
    default:
      return parseDetailGeneric(html, detailUrl, source);
  }
}

function buildNoticeDoc(source, detailUrl, parsed) {
  const stableId = extractStableId(detailUrl, source);

  return {
    bid_ntce_no: stableId,
    bid_ntce_ord: '00',
    source_system: SOURCE_SYSTEM,
    title: parsed.title || '(제목 없음)',
    notice_type: parsed.noticeType || '',
    bid_method: '',
    contract_method: '',
    issuing_org: parsed.issuingOrg || `${source.district_name}청`,
    demanding_org: parsed.issuingOrg || `${source.district_name}청`,
    budget: 0,
    estimated_price: 0,
    budget_formatted: '',
    published_at: parsed.publishedAt || null,
    closing_at: parsed.closingAt || null,
    opening_at: null,
    detail_url: detailUrl,
    raw_data: {
      district_key: source.key,
      district_name: source.district_name,
      parser_type: source.parser_type,
      manager: parsed.manager || '',
      phone: parsed.phone || '',
      body_excerpt: String(parsed.bodyText || '').slice(0, 5000),
      attachments: parsed.attachments || [],
      seed_attachment_urls: getSeedAttachmentLinks(source),
      source_notes: source.notes || '',
    },
    collected_at: new Date(),
  };
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

async function crawlSource(source, options = {}) {
  const defaults = getDefaultOptions();

  if (!source.enabled) {
    return {
      key: source.key,
      skipped: true,
      reason: 'disabled',
      parsed: 0,
      kept: 0,
      savedNew: 0,
      savedUpdated: 0,
      errors: 0,
    };
  }

  const candidateLinks = await collectCandidateLinks(source, options);
  const requestDelayMs = Number(defaults.request_delay_ms || 250);

  let parsed = 0;
  let kept = 0;
  let savedNew = 0;
  let savedUpdated = 0;
  let errors = 0;

  const seen = new Set();

  for (const detailUrl of candidateLinks) {
    if (!detailUrl || seen.has(detailUrl)) continue;
    seen.add(detailUrl);

    try {
      const html = await fetchHtml(detailUrl, source.list_url || source.detail_hint?.entry_url || '');
      const parsedDetail = parseDetailByType(html, detailUrl, source);
      parsed += 1;

      if (!parsedDetail.title && !parsedDetail.bodyText) {
        continue;
      }

      if (!shouldKeepNotice(source, parsedDetail.title, parsedDetail.bodyText)) {
        continue;
      }

      if (defaults.active_post_only && !isActiveNotice(parsedDetail.closingAt)) {
        continue;
      }

      const doc = buildNoticeDoc(source, detailUrl, parsedDetail);
      const result = await saveNotice(doc);

      kept += 1;
      if (result === 'new') savedNew += 1;
      else savedUpdated += 1;
    } catch (err) {
      errors += 1;
      console.error(`[LOCAL GOV] 상세 파싱 실패 — ${source.key} ${detailUrl}`, err.message);
    }

    if (requestDelayMs > 0) {
      await sleep(requestDelayMs);
    }
  }

  return {
    key: source.key,
    district_name: source.district_name,
    skipped: false,
    parsed,
    kept,
    savedNew,
    savedUpdated,
    errors,
  };
}

async function crawl(options = {}) {
  const sources = getSourceList().filter((s) => s.enabled !== false);

  const onlyKeys = Array.isArray(options.keys) && options.keys.length
    ? new Set(options.keys.map((v) => String(v).trim()))
    : null;

  const targetSources = onlyKeys
    ? sources.filter((s) => onlyKeys.has(s.key))
    : sources;

  console.log(
    `[LOCAL GOV] 수집 시작 — 대상 ${targetSources.length}개 구청 (${targetSources.map((s) => s.key).join(', ')})`
  );

  const results = [];
  let parsed = 0;
  let kept = 0;
  let savedNew = 0;
  let savedUpdated = 0;
  let errors = 0;

  for (const source of targetSources) {
    try {
      const r = await crawlSource(source, options);
      results.push(r);

      parsed += r.parsed || 0;
      kept += r.kept || 0;
      savedNew += r.savedNew || 0;
      savedUpdated += r.savedUpdated || 0;
      errors += r.errors || 0;

      console.log(
        `[LOCAL GOV] ${source.district_name} 완료 — parsed=${r.parsed} kept=${r.kept} new=${r.savedNew} updated=${r.savedUpdated} errors=${r.errors}`
      );
    } catch (err) {
      errors += 1;
      console.error(`[LOCAL GOV] 소스 처리 실패 — ${source.key}`, err.message);
      results.push({
        key: source.key,
        district_name: source.district_name,
        skipped: false,
        parsed: 0,
        kept: 0,
        savedNew: 0,
        savedUpdated: 0,
        errors: 1,
      });
    }
  }

  console.log(
    `[LOCAL GOV] 완료 — parsed=${parsed}, kept=${kept}, new=${savedNew}, updated=${savedUpdated}, errors=${errors}`
  );

  return {
    parsed,
    kept,
    newCount: savedNew,
    updatedCount: savedUpdated,
    errorCount: errors,
    results,
  };
}

module.exports = {
  crawl,
  crawlSource,
};
