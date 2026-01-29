-- rating_10_scale_fix: ensure legacy 1..5 values become 2..10
UPDATE "LibraryEntry"
SET "rating" = "rating" * 2
WHERE "rating" IS NOT NULL
  AND "rating" BETWEEN 1 AND 5;
