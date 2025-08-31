/*
  Warnings:

  - You are about to drop the column `name` on the `Metric` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[email]` on the table `AdminUser` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `type` to the `Metric` table without a default value. This is not possible if the table is not empty.

*/
-- DropIndex
DROP INDEX "public"."AdminUser_tenantId_email_key";

-- AlterTable
ALTER TABLE "public"."Metric" DROP COLUMN "name",
ADD COLUMN     "type" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "public"."Usage" ADD COLUMN     "breakdown" JSONB;

-- CreateIndex
CREATE UNIQUE INDEX "AdminUser_email_key" ON "public"."AdminUser"("email");
