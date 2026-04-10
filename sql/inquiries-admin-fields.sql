ALTER TABLE inquiries
  ADD COLUMN adminMemo TEXT NOT NULL DEFAULT '' AFTER status,
  ADD COLUMN processedAt DATETIME NULL DEFAULT NULL AFTER adminMemo,
  ADD COLUMN processedBy INT UNSIGNED NULL DEFAULT NULL AFTER processedAt;

CREATE INDEX idx_inquiries_processedAt ON inquiries (processedAt);
CREATE INDEX idx_inquiries_processedBy ON inquiries (processedBy);
