/*
  Warnings:

  - A unique constraint covering the columns `[userId,isbn]` on the table `LibraryEntry` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateIndex
CREATE UNIQUE INDEX "LibraryEntry_userId_isbn_key" ON "LibraryEntry"("userId", "isbn");
