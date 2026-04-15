// collectors/province-gov/sources.js
// 지방 도청 직접 게시형 수집 소스맵 (7개 도청)
// province-gov-crawler.js v1 대응 통합본
// 2026-04-15 separated rollout: 서울시·구청(local_gov)과 분리된 지방·도청 수집기

const COMMON_INCLUDE_REGEX =
  /(입찰공고|전자입찰|입찰에\s*부치는\s*사항|입찰|재입찰|재공고|정정공고|변경공고|견적제출|수의견적|가격입찰서|일반공개경쟁입찰|용역(?:\s*공고)?|제안서|제안요청서|기술제안|제안서\s*제출|협상에\s*의한\s*계약|제안서\s*평가위원|평가위원(\s*\(후보자\))?|공개\s*모집|모집\s*공고|참여기관\s*모집|사업자\s*모집|수행기관\s*모집|수행기관\s*지정\s*공고|수행주체\s*모집|수탁기관\s*모집|위탁운영기관\s*모집|운영기관\s*모집|민간위탁|안전점검\s*수행기관|지정\s*공고|지방보조금\s*지원계획\s*공고|사용허가\s*입찰공고|공유재산\s*매각\s*일반경쟁\s*입찰공고)/i;

const COMMON_EXCLUDE_REGEX =
  /(결과\s*공고|평가결과|선정결과|개찰결과|낙찰자|낙찰\s*결과|협상\s*결과|개최결과\s*공개|합격자|최종합격|채용공고|채용\s*재공고|기간제근로자\s*채용|임기제공무원\s*채용|행정처분|영업정지|등록취소|공시송달|반송분\s*공시송달|의견청취|청문|과태료|처분\s*사전통지|압류|직권말소|행정예고|회의록|심의록|속기록|녹취록|위원회\s*회의록|의회\s*회의록|간담회\s*결과|감사\s*결과|검토결과서|영향평가\s*검토결과서|결과보고서|사업결과보고서?|연구보고서|연구용역\s*결과보고서?|용역\s*결과보고서?|정책연구\s*용역자료|용역자료|연구자료|자료집|최종보고서|중간보고서|성과보고서|감사결과보고서?|업무보고|주간업무(?:계획|보고)?|월간업무(?:계획|보고)?|결산서|보고서|백서)/i;

const GYEONGGI_EXTRA_EXCLUDE_REGEX =
  /(계약현황|대가지급|계약법규|경기도청\s*언어선택|콜센터\s*031-120|발주계획현황)/i;

const GANGWON_EXTRA_EXCLUDE_REGEX =
  /(새로운\s*강원|특별\s*자치시대|도정마당|공고\/?고시\s*목록)/i;

const JEONNAM_EXTRA_EXCLUDE_REGEX =
  /(전남도보|장애인\s*고시\/?공고\s*모아보기|도정소식|공지사항)/i;

module.exports = {
  version: '2026-04-15.province-gov-v2-separated-rollout-7-except-gyeongnam-jeju',
  source_group: 'province_do_direct_7',
  source_system: 'province_gov',

  defaults: {
    enabled: true,
    active_post_only: true,
    detail_fetch: true,
    strict_keyword_gate: true,
    title_first_filter: true,
    body_fallback_filter: true,
    include_regex: COMMON_INCLUDE_REGEX,
    exclude_regex: COMMON_EXCLUDE_REGEX,
    parser_timeout_ms: 20000,
    request_delay_ms: 250,
    timezone: 'Asia/Seoul',
  },

  sources: [
    {
      key: 'gyeonggi_do',
      district_name: '경기도',
      priority: 'B',
      confidence: 'medium',
      enabled: true,
      parser_type: 'gyeonggi_board_list',
      list_url: 'https://www.gg.go.kr/bbs/board.do?bsIdx=469&menuId=1547',
      detail_hint: {
        entry_url: 'https://www.gg.go.kr/bbs/board.do?bsIdx=469&menuId=1547',
        seed_detail_urls: [],
        seed_attachment_urls: [],
        item_link_pattern: /\/bbs\/boardView\.do\?/i,
        page_param: 'page',
        bs_idx: '469',
        menu_id: '1547',
        id_pattern: /[?&]bIdx=(\d+)/i,
      },
      include_regex: COMMON_INCLUDE_REGEX,
      exclude_regex: new RegExp(
        `${COMMON_EXCLUDE_REGEX.source}|${GYEONGGI_EXTRA_EXCLUDE_REGEX.source}`,
        'i'
      ),
      notes:
        '경기도청 고시·공고 게시판. board.do 목록에서 boardView.do 상세로 이동하는 패턴을 사용하며, 공고/입찰/용역/모집 계열 제목만 우선 수집.',
    },

    {
      key: 'chungbuk_do',
      district_name: '충청북도',
      priority: 'A',
      confidence: 'high',
      enabled: true,
      parser_type: 'chungbuk_gosi_list',
      list_url: 'https://www.chungbuk.go.kr/www/selectGosiPblancList.do?key=422',
      detail_hint: {
        entry_url: 'https://www.chungbuk.go.kr/www/selectGosiPblancList.do?key=422',
        seed_detail_urls: [],
        seed_attachment_urls: [],
        item_link_pattern: /selectGosiPblancView\.do\?/i,
        page_param: 'pageIndex',
        key: '422',
        id_pattern: /[?&]no=(\d+)/i,
      },
      include_regex: COMMON_INCLUDE_REGEX,
      exclude_regex: COMMON_EXCLUDE_REGEX,
      notes:
        '충청북도청 고시/공고 목록은 selectGosiPblancList.do -> selectGosiPblancView.do 구조가 안정적이라 우선 수집 대상.',
    },

    {
      key: 'chungnam_do',
      district_name: '충청남도',
      priority: 'A',
      confidence: 'high',
      enabled: true,
      parser_type: 'chungnam_province_list',
      list_url: 'https://www.chungnam.go.kr/cnportal/province/province/list.do?menuNo=500487',
      detail_hint: {
        entry_url: 'https://www.chungnam.go.kr/cnportal/province/province/list.do?menuNo=500487',
        seed_detail_urls: [],
        seed_attachment_urls: [],
        item_link_pattern: /\/cnportal\/province\/province\/view\.do\?nttId=\d+/i,
        page_param: 'pageIndex',
        menu_no: '500487',
        id_pattern: /[?&]nttId=(\d+)/i,
      },
      include_regex: COMMON_INCLUDE_REGEX,
      exclude_regex: COMMON_EXCLUDE_REGEX,
      notes:
        '충청남도청 도 및 산하기관 고시/공고. 내부 view.do 상세를 우선 사용하고, 외부 민원 바로가기 링크는 무시한다.',
    },

    {
      key: 'jeonbuk_do',
      district_name: '전북특별자치도',
      priority: 'A',
      confidence: 'high',
      enabled: true,
      parser_type: 'jeonbuk_board_list',
      list_url:
        'https://www.jeonbuk.go.kr/board/list.jeonbuk?boardId=BBS_0000129&menuCd=DOM_000000102002005000&orderBy=REGISTER_DATE:DESC,TMP_FIELD1:DESC&paging=ok&startPage=1',
      detail_hint: {
        entry_url:
          'https://www.jeonbuk.go.kr/board/list.jeonbuk?boardId=BBS_0000129&menuCd=DOM_000000102002005000&orderBy=REGISTER_DATE:DESC,TMP_FIELD1:DESC&paging=ok&startPage=1',
        seed_detail_urls: [],
        seed_attachment_urls: [],
        item_link_pattern: /\/board\/view\.jeonbuk\?[^"' ]*boardId=BBS_0000129/i,
        page_param: 'startPage',
        board_id: 'BBS_0000129',
        id_pattern: /[?&]dataSid=(\d+)/i,
      },
      include_regex: COMMON_INCLUDE_REGEX,
      exclude_regex: COMMON_EXCLUDE_REGEX,
      notes:
        '전북특별자치도청 고시/공고 boardId=BBS_0000129 보드를 수집한다. list.jeonbuk -> view.jeonbuk -> 첨부 다운로드 구조를 따른다.',
    },

    {
      key: 'jeonnam_do',
      district_name: '전라남도',
      priority: 'A',
      confidence: 'high',
      enabled: true,
      parser_type: 'jeonnam_board_list',
      list_url:
        'https://governor.jeonnam.go.kr/J0203/boardList.do?infoReturn=&pageIndex=1&menuId=jeonnam0203000000&searchType=&searchText=&displayHeader=',
      detail_hint: {
        entry_url:
          'https://governor.jeonnam.go.kr/J0203/boardList.do?infoReturn=&pageIndex=1&menuId=jeonnam0203000000&searchType=&searchText=&displayHeader=',
        seed_detail_urls: [],
        seed_attachment_urls: [],
        item_link_pattern: /\/J0203\/boardView\.do\?seq=\d+/i,
        page_param: 'pageIndex',
        board_id: 'J0203',
        id_pattern: /[?&]seq=(\d+)/i,
      },
      include_regex: COMMON_INCLUDE_REGEX,
      exclude_regex: new RegExp(
        `${COMMON_EXCLUDE_REGEX.source}|${JEONNAM_EXTRA_EXCLUDE_REGEX.source}`,
        'i'
      ),
      notes:
        '전라남도청 J0203 고시/공고 게시판. boardList.do 목록과 boardView.do 상세가 안정적이며, 도보/공지사항 계열 잡음을 추가 제외한다.',
    },

    {
      key: 'gyeongbuk_do',
      district_name: '경상북도',
      priority: 'B',
      confidence: 'medium',
      enabled: true,
      parser_type: 'egov_gosi_list',
      list_url: 'https://www.gb.go.kr/Main/page.do?mnu_uid=6789&&BD_CODE=gosi_notice',
      detail_hint: {
        entry_url: 'https://www.gb.go.kr/Main/page.do?mnu_uid=6789&&BD_CODE=gosi_notice',
        seed_detail_urls: [],
        seed_attachment_urls: [],
        item_link_pattern: /\/Main\/page\.do\?[^"' ]*cmd=2[^"' ]*BD_CODE=gosi_notice/i,
        page_param: 'pageNo',
        mnu_uid: '6789',
        bd_code: 'gosi_notice',
        id_pattern: /[?&]B_NUM=(\d+)/i,
      },
      include_regex: COMMON_INCLUDE_REGEX,
      exclude_regex: COMMON_EXCLUDE_REGEX,
      notes:
        '경상북도청 고시/공고 목록. Main/page.do 목록에서 cmd=2 상세로 이동하며, 공고/모집/보조사업자/수탁기관 계열 제목만 우선 수집한다.',
    },

    {
      key: 'gangwon_do',
      district_name: '강원특별자치도',
      priority: 'B',
      confidence: 'medium',
      enabled: true,
      parser_type: 'gangwon_notification_list',
      list_url: 'https://state.gwd.go.kr/portal/bulletin/notification?pageIndex=1&recordCountPerPage=15&mode&firstYN=',
      detail_hint: {
        entry_url: 'https://state.gwd.go.kr/portal/bulletin/notification?pageIndex=1&recordCountPerPage=15&mode&firstYN=',
        seed_detail_urls: [],
        seed_attachment_urls: [],
        item_link_pattern: /\/portal\/bulletin\/notification\?articleSeq=\d+/i,
        page_param: 'pageIndex',
        id_pattern: /[?&]articleSeq=(\d+)/i,
      },
      include_regex: COMMON_INCLUDE_REGEX,
      exclude_regex: new RegExp(
        `${COMMON_EXCLUDE_REGEX.source}|${GANGWON_EXTRA_EXCLUDE_REGEX.source}`,
        'i'
      ),
      notes:
        '강원특별자치도청 공고/고시 목록. portal/bulletin/notification 상세 articleSeq 링크만 수집 대상으로 제한한다.',
    },
  ],
};
