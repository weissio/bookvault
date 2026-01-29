-- rating_10_scale_fix2: convert legacy 1..5 ratings to 2..10 (idempotent-ish)
UPDATE "LibraryEntry"
SET "rating" = "rating" * 2
WHERE "rating" IS NOT NULL
  AND "rating" BETWEEN 1 AND 5;
