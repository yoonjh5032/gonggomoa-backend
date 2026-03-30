/* models/Notice.js — 공고 스키마 */
const mongoose = require('mongoose');

const noticeSchema = new mongoose.Schema({
  /* ── 식별 ── */
  bid_ntce_no:    { type: String, required: true },              // 입찰공고번호
  bid_ntce_ord:   { type: String, default: '00' },               // 입찰공고차수
  source_system:  {
    type: String,
    enum: ['g2b_api', 'seoul_board', 'seoul_contract', 'nonghyup', 'local_gov'],
    required: true
  },

  /* ── 기본 정보 ── */
  title:          { type: String, required: true, index: true },  // 공고명
  notice_type:    { type: String, default: '' },                  // 공사/용역/물품/외자
  bid_method:     { type: String, default: '' },                  // 입찰방식
  contract_method:{ type: String, default: '' },                  // 계약방법

  /* ── 기관 ── */
  issuing_org:    { type: String, default: '' },                  // 공고기관
  demanding_org:  { type: String, default: '' },                  // 수요기관

  /* ── 금액 ── */
  budget:         { type: Number, default: 0 },                   // 배정예산(원)
  estimated_price:{ type: Number, default: 0 },                   // 추정가격(원)
  budget_formatted: { type: String, default: '' },                // "1억 2,000만원" 형식

  /* ── 일시 ── */
  published_at:   { type: Date },                                 // 공고일시
  closing_at:     { type: Date, index: true },                    // 마감일시
  opening_at:     { type: Date },                                 // 개찰일시

  /* ── 링크 ── */
  detail_url:     { type: String, default: '' },                  // 나라장터 원본 URL ★
  
  /* ── 메타 ── */
  raw_data:       { type: mongoose.Schema.Types.Mixed },          // 원본 API 응답 전체
  collected_at:   { type: Date, default: Date.now },              // 수집 시점
  updatedAt:      { type: Date, default: Date.now }
});

// 복합 인덱스: 공고번호+차수+출처 → 중복 방지
noticeSchema.index(
  { bid_ntce_no: 1, bid_ntce_ord: 1, source_system: 1 },
  { unique: true }
);

// 텍스트 인덱스: 검색용
noticeSchema.index({ title: 'text', issuing_org: 'text', demanding_org: 'text' });

// 마감일 + 소스 인덱스
noticeSchema.index({ closing_at: -1, source_system: 1 });
noticeSchema.index({ published_at: -1 });

module.exports = mongoose.model('Notice', noticeSchema);
