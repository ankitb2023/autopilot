-- CreateTable
CREATE TABLE "naukri_sessions" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "cookies" JSONB NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "naukri_sessions_pkey" PRIMARY KEY ("id")
);

