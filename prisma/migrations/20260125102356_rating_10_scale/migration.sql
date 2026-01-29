UPDATE "LibraryEntry"
SET "rating" = "rating" * 2
WHERE "rating" IS NOT NULL
  AND "rating" BETWEEN 1 AND 5;
