-- CreateTable
CREATE TABLE "naukri_tokens" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "accessToken" TEXT NOT NULL,
    "issuedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "flowId" TEXT,

    CONSTRAINT "naukri_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "naukri_tokens_expiresAt_idx" ON "naukri_tokens"("expiresAt" DESC);
