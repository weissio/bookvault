/*
  Warnings:

  - You are about to drop the `Book` table. If the table is not empty, all the data it contains will be lost.
  - The primary key for the `LibraryEntry` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - You are about to drop the column `bookId` on the `LibraryEntry` table. All the data in the column will be lost.
  - You are about to drop the column `updatedAt` on the `LibraryEntry` table. All the data in the column will be lost.
  - You are about to alter the column `id` on the `LibraryEntry` table. The data in that column could be lost. The data in that column will be cast from `String` to `Int`.
  - Added the required column `authors` to the `LibraryEntry` table without a default value. This is not possible if the table is not empty.
  - Added the required column `isbn` to the `LibraryEntry` table without a default value. This is not possible if the table is not empty.
  - Added the required column `title` to the `LibraryEntry` table without a default value. This is not possible if the table is not empty.
  - Added the required column `userId` to the `LibraryEntry` table without a default value. This is not possible if the table is not empty.

*/
-- DropIndex
DROP INDEX "Book_isbn_key";

-- DropTable
PRAGMA foreign_keys=off;
DROP TABLE "Book";
PRAGMA foreign_keys=on;

-- CreateTable
CREATE TABLE "User" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "email" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" INTEGER NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_LibraryEntry" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "userId" INTEGER NOT NULL,
    "isbn" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "authors" TEXT NOT NULL,
    "coverUrl" TEXT,
    "status" TEXT NOT NULL DEFAULT 'unread',
    "rating" INTEGER,
    "notes" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "LibraryEntry_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_LibraryEntry" ("createdAt", "id", "notes", "rating", "status") SELECT "createdAt", "id", "notes", "rating", "status" FROM "LibraryEntry";
DROP TABLE "LibraryEntry";
ALTER TABLE "new_LibraryEntry" RENAME TO "LibraryEntry";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");
