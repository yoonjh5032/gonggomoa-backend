-- notices 조회 성능 개선용 인덱스
-- production 에서는 sequelize.sync() 만으로 기존 테이블 인덱스가 갱신되지 않을 수 있으므로 수동 실행 권장

ALTER TABLE notices
  ADD INDEX idx_notice_visible_closing (is_hidden, closing_at),
  ADD INDEX idx_notice_source_visible_closing (source_system, is_hidden, closing_at),
  ADD INDEX idx_notice_type_visible_closing (notice_type, is_hidden, closing_at),
  ADD INDEX idx_notice_source_type_visible_closing (source_system, notice_type, is_hidden, closing_at),
  ADD INDEX idx_notice_visible_published (is_hidden, published_at),
  ADD INDEX idx_notice_source_visible_published (source_system, is_hidden, published_at),
  ADD INDEX idx_notice_type_visible_published (notice_type, is_hidden, published_at),
  ADD FULLTEXT INDEX ft_notice_search (title, issuing_org, demanding_org);

-- 이미 인덱스가 있는 경우에는 개별 실행으로 분리해서 중복 에러를 피하세요.
-- 예시:
-- CREATE INDEX idx_notice_visible_closing ON notices (is_hidden, closing_at);
-- CREATE FULLTEXT INDEX ft_notice_search ON notices (title, issuing_org, demanding_org);
