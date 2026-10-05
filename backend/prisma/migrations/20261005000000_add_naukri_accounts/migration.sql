-- DropIndex
DROP INDEX "naukri_tokens_expiresAt_idx";

-- AlterTable
ALTER TABLE "naukri_tokens" ADD COLUMN     "accountId" TEXT NOT NULL DEFAULT 'default';

-- CreateIndex
CREATE INDEX "naukri_tokens_accountId_expiresAt_idx" ON "naukri_tokens"("accountId", "expiresAt" DESC);

