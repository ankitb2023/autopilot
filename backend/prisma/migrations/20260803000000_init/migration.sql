-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "ExecutionStatus" AS ENUM ('RUNNING', 'SUCCESS', 'FAILED', 'TIMEOUT');

-- CreateEnum
CREATE TYPE "TriggerSource" AS ENUM ('API', 'CRON', 'MANUAL');

-- CreateTable
CREATE TABLE "execution_history" (
    "id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "status" "ExecutionStatus" NOT NULL,
    "trigger" "TriggerSource" NOT NULL DEFAULT 'API',
    "message" TEXT,
    "errorCode" TEXT,
    "durationMs" INTEGER,
    "details" JSONB,
    "startedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMPTZ(3),

    CONSTRAINT "execution_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "automation_locks" (
    "key" TEXT NOT NULL,
    "executionId" UUID NOT NULL,
    "trigger" "TriggerSource" NOT NULL DEFAULT 'API',
    "acquiredAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "automation_locks_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE INDEX "execution_history_startedAt_idx" ON "execution_history"("startedAt" DESC);

-- CreateIndex
CREATE INDEX "execution_history_provider_startedAt_idx" ON "execution_history"("provider", "startedAt" DESC);

