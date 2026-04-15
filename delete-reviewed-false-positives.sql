USE gonggomoa;
SELECT DATABASE() AS current_db;

SELECT id, source_system, title, published_at
FROM notices
WHERE source_system = 'seoul_board'
  AND id IN (135074, 135088, 135083, 135084, 135085, 135072, 135071)
ORDER BY id DESC;

START TRANSACTION;

DELETE FROM notices
WHERE source_system = 'seoul_board'
  AND id IN (135074, 135088, 135083, 135084, 135085, 135072, 135071);

SELECT ROW_COUNT() AS deleted_rows;

COMMIT;

SELECT id, source_system, title
FROM notices
WHERE source_system = 'seoul_board'
  AND id IN (135074, 135088, 135083, 135084, 135085, 135072, 135071);
