// collectors/local-gov/sources.js
// 서울 구청 직접 게시형 수집 소스맵 (8개 구청)
// local-gov-crawler.js v2 대응 통합본

const COMMON_INCLUDE_REGEX =
  /(입찰공고|입찰|용역|제안서|제안서\s*평가위원|평가위원(\s*\(후보자\))?|공개\s*모집|모집\s*공고|위탁운영기관\s*모집|수탁기관\s*모집|사업자\s*모집|기술제안|협상에\s*의한\s*계약)/i;

const COMMON_EXCLUDE_REGEX =
  /(평가결과|선정결과|개찰결과|낙찰자|낙찰\s*결과|우선협상대상자|우선협상대상자\s*선정|협상\s*결과|결과\s*공고|합격자|최종합격|채용공고|채용\s*재공고|기간제근로자\s*채용|임기제공무원\s*채용|행정처분|영업정지|등록취소|공시송달|반송분\s*공시송달|의견청취|청문|과태료|처분\s*사전통지)/i;

const YONGSAN_EXTRA_EXCLUDE_REGEX =
  /(금연지도원\s*모집|동행일자리|사서\s*채용|시간선택제임기제|기간제근로자|통합돌봄\s*지원사업|건강장수센터)/i;

module.exports = {
  version: '2026-04-03.local-gov-v2',
  source_group: 'seoul_gu_direct_8',
  source_system: 'local_gov',

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
      key: 'gwanak',
      district_name: '관악구',
      priority: 'A',
      confidence: 'high',
      enabled: true,
      parser_type: 'gwanak_bbsnew_list',
      list_url: 'https://www.gwanak.go.kr/site/gwanak/ex/bbsNew/List.do?typeCode=1',
      detail_hint: {
        entry_url: 'https://www.gwanak.go.kr/site/gwanak/01/10102050200002016051201.jsp',
        seed_detail_urls: [],
        seed_attachment_urls: [],
        item_link_pattern: /\/site\/gwanak\/ex\/bbs(New)?\/View\.do\?/i,
        page_param: 'page',
        board_kind: 'bbsNew',
      },
      include_regex:
        /(입찰공고|입찰|용역|제안서|제안서\s*평가위원|평가위원(\s*\(후보자\))?|공개\s*모집|모집\s*공고|수탁기관\s*모집|위탁운영기관\s*모집|사업자\s*모집|수행주체\s*모집|참여기관\s*모집)/i,
      exclude_regex: COMMON_EXCLUDE_REGEX,
      notes: '관악구는 bbsNew 리스트에서 #view형 제목 링크가 보여 onclick/data 속성 기반 상세 URL 복원 로직 사용.',
    },

    {
      key: 'gangbuk',
      district_name: '강북구',
      priority: 'A',
      confidence: 'high',
      enabled: true,
      parser_type: 'egov_gosi_list',
      list_url: 'https://www.gangbuk.go.kr:18000/portal/bbs/B0000245/list.do?menuNo=200082',
      detail_hint: {
        entry_url: 'https://www.gangbuk.go.kr:18000/portal/bbs/B0000245/list.do?menuNo=200082',
        seed_detail_urls: [],
        seed_attachment_urls: [],
        item_link_pattern: /\/portal\/bbs\/B0000245\/view\.do\?/i,
        page_param: 'pageIndex',
        board_id: 'B0000245',
        menu_no: '200082',
      },
      include_regex:
        /(입찰공고|용역|제안서|평가위원(\s*\(후보자\))?|모집\s*공고|위탁운영기관\s*모집|운영기관\s*모집|수탁기관|공개\s*모집|사업자\s*모집|안전점검\s*수행기관)/i,
      exclude_regex:
        /(평가결과|선정결과|개찰결과|낙찰자|우선협상대상자|합격자|채용공고|행정처분|영업정지|등록취소|공시송달|체납자|결산서|후원금|주민등록\s*무단전출)/i,
      notes: '강북구는 실제 상세 링크가 있는 egov형 리스트. 최근 위탁운영기관 모집공고가 확인됨.',
    },

    {
      key: 'guro',
      district_name: '구로구',
      priority: 'B',
      confidence: 'medium',
      enabled: true,
      parser_type: 'seed_detail_and_attachment',
      list_url: null,
      detail_hint: {
        entry_url: 'https://www.guro.go.kr/www/selectBbsNttGosiView.do?bbsNo=663&nttNo=49655',
        seed_detail_urls: [
          'https://www.guro.go.kr/www/selectBbsNttGosiView.do?bbsNo=663&nttNo=49655',
        ],
        seed_attachment_urls: [
          'https://eminwon.guro.go.kr/emwp/jsp/ofr/FileDown.jsp?user_file_nm=%EC%A0%9C%EC%95%88%EC%84%9C%ED%8F%89%EA%B0%80%EC%9C%84%EC%9B%90(%ED%9B%84%EB%B3%B4%EC%9E%90)%20%EA%B3%B5%EA%B0%9C%20%EB%AA%A8%EC%A7%91%20%EA%B3%B5%EA%B3%A0.pdf',
        ],
        item_link_pattern: /selectBbsNttGosiView\.do\?/i,
        page_param: 'pageIndex',
        bbs_no: '663',
      },
      include_regex:
        /(제안서|제안서\s*평가위원|평가위원(\s*\(후보자\))?|공개\s*모집|모집\s*공고|용역|입찰공고|기술제안)/i,
      exclude_regex: COMMON_EXCLUDE_REGEX,
      notes: '구로구는 상세/첨부 seed 중심으로 시작. 리스트 URL은 추후 확보 시 교체.',
    },

    {
      key: 'seodaemun',
      district_name: '서대문구',
      priority: 'A',
      confidence: 'high',
      enabled: true,
      parser_type: 'seed_detail_notice',
      list_url: null,
      detail_hint: {
        entry_url: 'https://www.sdm.go.kr/news/notice/notice.do?mode=view&sdmBoardSeq=309721',
        seed_detail_urls: [
          'https://www.sdm.go.kr/news/notice/notice.do?mode=view&sdmBoardSeq=309721',
        ],
        seed_attachment_urls: [],
        item_link_pattern: /notice\.do\?mode=view&sdmBoardSeq=\d+/i,
        id_pattern: /sdmBoardSeq=(\d+)/i,
      },
      include_regex:
        /(용역|제안서|제안서\s*평가위원|평가위원(\s*\(후보자\))?|공개\s*모집|모집\s*공고)/i,
      exclude_regex:
        /(평가결과|선정결과|개찰결과|낙찰자|우선협상대상자|결과\s*공고|합격자|채용공고)/i,
      notes: '서대문구는 대표 상세 시드 기반. 평가위원 모집 공고 본문 확인됨.',
    },

    {
      key: 'seocho',
      district_name: '서초구',
      priority: 'A',
      confidence: 'high',
      enabled: true,
      parser_type: 'seocho_ex_bbs_list',
      list_url: 'https://www.seocho.go.kr/site/seocho/ex/bbs/List.do?cbIdx=364',
      detail_hint: {
        entry_url: 'https://www.seocho.go.kr/site/seocho/ex/bbs/View.do?cbIdx=57&bcIdx=400218',
        seed_detail_urls: [
          'https://www.seocho.go.kr/site/seocho/ex/bbs/View.do?cbIdx=57&bcIdx=400218',
        ],
        seed_attachment_urls: [],
        item_link_pattern: /\/site\/seocho\/ex\/bbs\/View\.do\?/i,
        page_param: 'page',
        cb_idx_candidates: ['364', '57'],
      },
      include_regex:
        /(입찰공고|용역|제안서|제안서\s*평가위원|평가위원(\s*\(후보자\))?|공개\s*모집|모집\s*공고|협상에\s*의한\s*계약|모아타운)/i,
      exclude_regex:
        /(평가결과|선정결과|개찰결과|낙찰자|우선협상대상자|결과\s*공고|합격자|채용공고)/i,
      notes: 'cbIdx=364는 결과공개 위주이므로 list는 참고용, seed_detail_urls를 우선 활용.',
    },

    {
      key: 'yongsan',
      district_name: '용산구',
      priority: 'B',
      confidence: 'medium',
      enabled: true,
      parser_type: 'yongsan_health_bbs_list',
      list_url:
        'http://health.yongsan.go.kr/portal/bbs/B0000095/list.do?optn1=01&menuNo=200233&sdate=&edate=&searchWrd=&searchCnd=',
      detail_hint: {
        entry_url: 'http://health.yongsan.go.kr/portal/bbs/B0000095/list.do?menuNo=200233',
        seed_detail_urls: [],
        seed_attachment_urls: [],
        item_link_pattern: /\/portal\/bbs\/B0000095\/view\.do\?/i,
        page_param: 'pageIndex',
        board_id: 'B0000095',
        menu_no: '200233',
      },
      include_regex:
        /(입찰공고|용역|제안서|평가위원(\s*\(후보자\))?|공개\s*모집|모집\s*공고|사업자\s*모집|안전점검\s*수행기관|지정\s*공고)/i,
      exclude_regex: new RegExp(
        `${COMMON_EXCLUDE_REGEX.source}|${YONGSAN_EXTRA_EXCLUDE_REGEX.source}`,
        'i'
      ),
      notes: '용산구는 전체 대신 공고(optn1=01) 탭 우선. 채용성 노이즈가 많아 exclude를 강하게 적용.',
    },

    {
      key: 'jungnang',
      district_name: '중랑구',
      priority: 'A',
      confidence: 'high',
      enabled: true,
      parser_type: 'jungnang_portal_bbs_seed',
      list_url: null,
      detail_hint: {
        entry_url: 'https://www.jungnang.go.kr/portal/bbs/view/B0000117/164517.do?menuNo=200475',
        seed_detail_urls: [
          'https://www.jungnang.go.kr/portal/bbs/view/B0000117/164517.do?menuNo=200475',
        ],
        seed_attachment_urls: [],
        item_link_pattern: /\/portal\/bbs\/view\/B0000117\/\d+\.do\?/i,
        id_pattern: /\/B0000117\/(\d+)\.do/i,
        menu_no: '200475',
        board_id: 'B0000117',
      },
      include_regex:
        /(용역|제안서|제안서\s*평가위원|평가위원(\s*\(후보자\))?|공개\s*모집|모집\s*공고|숲해설|유아숲)/i,
      exclude_regex:
        /(평가결과|선정결과|개찰결과|낙찰자|우선협상대상자|결과\s*공고|합격자|채용공고)/i,
      notes: '중랑구는 대표 상세 시드 기반. 제안서 평가위원 공개 모집 공고 확인됨.',
    },

    {
      key: 'gangseo',
      district_name: '강서구',
      priority: 'B',
      confidence: 'medium',
      enabled: true,
      parser_type: 'legacy_detail_seed',
      list_url: null,
      detail_hint: {
        entry_url: 'https://www.gangseo.seoul.kr/build/bui010101/248836',
        seed_detail_urls: [
          'https://www.gangseo.seoul.kr/build/bui010101/248836',
        ],
        seed_attachment_urls: [],
        item_link_pattern: /\/build\/bui\d+\/\d+/i,
      },
      include_regex:
        /(입찰공고|입찰에\s*부치는\s*사항|용역|제안서|제안서\s*제출|가격입찰서|일반공개경쟁입찰|협상에\s*의한\s*계약)/i,
      exclude_regex:
        /(평가결과|선정결과|개찰결과|낙찰자|우선협상대상자|결과\s*공고|합격자|채용공고)/i,
      notes: '강서구는 상세 seed 기반으로 시작. 현재 운영 중인 리스트 URL 발견 시 교체 권장.',
    },
  ],
};
