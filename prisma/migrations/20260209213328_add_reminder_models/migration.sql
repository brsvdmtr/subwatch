-- CreateEnum
CREATE TYPE "ReminderType" AS ENUM ('BEFORE', 'DAY_OF');

-- CreateEnum
CREATE TYPE "ReminderEventStatus" AS ENUM ('PLANNED', 'SENT', 'SKIPPED', 'FAILED');

-- CreateTable
CREATE TABLE "ReminderRule" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "type" "ReminderType" NOT NULL,
    "offsetMinutes" INTEGER NOT NULL,
    "dayOfTime" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReminderRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReminderEvent" (
    "id" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "plannedAt" TIMESTAMP(3) NOT NULL,
    "type" "ReminderType" NOT NULL,
    "status" "ReminderEventStatus" NOT NULL DEFAULT 'PLANNED',
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),

    CONSTRAINT "ReminderEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ReminderRule_spaceId_idx" ON "ReminderRule"("spaceId");

-- CreateIndex
CREATE UNIQUE INDEX "ReminderRule_spaceId_type_key" ON "ReminderRule"("spaceId", "type");

-- CreateIndex
CREATE INDEX "ReminderEvent_status_plannedAt_idx" ON "ReminderEvent"("status", "plannedAt");

-- CreateIndex
CREATE INDEX "ReminderEvent_subscriptionId_idx" ON "ReminderEvent"("subscriptionId");

-- CreateIndex
CREATE UNIQUE INDEX "ReminderEvent_subscriptionId_plannedAt_type_key" ON "ReminderEvent"("subscriptionId", "plannedAt", "type");

-- AddForeignKey
ALTER TABLE "ReminderRule" ADD CONSTRAINT "ReminderRule_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "Space"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReminderEvent" ADD CONSTRAINT "ReminderEvent_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "Subscription"("id") ON DELETE CASCADE ON UPDATE CASCADE;
