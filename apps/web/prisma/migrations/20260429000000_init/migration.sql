-- CreateEnum
CREATE TYPE "Platform" AS ENUM ('TOKOPEDIA', 'SHOPEE');

-- CreateEnum
CREATE TYPE "AccountStatus" AS ENUM ('NOT_LOGGED_IN', 'LOGGED_IN', 'SESSION_EXPIRED', 'ERROR');

-- CreateEnum
CREATE TYPE "RunPass" AS ENUM ('PAID', 'SHIPPED', 'LOGIN');

-- CreateEnum
CREATE TYPE "RunStatus" AS ENUM ('PENDING', 'RUNNING', 'SUCCESS', 'FAILED', 'CANCELED');

-- CreateEnum
CREATE TYPE "TriggerType" AS ENUM ('SCHEDULED', 'MANUAL');

-- CreateEnum
CREATE TYPE "LifecycleState" AS ENUM ('NEW', 'INGESTED', 'SHIPPED_CONFIRMED', 'SHIPPED_BUT_OPERATOR_MOVED', 'SYNC_FAILED');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Account" (
    "id" TEXT NOT NULL,
    "platform" "Platform" NOT NULL,
    "name" TEXT NOT NULL,
    "status" "AccountStatus" NOT NULL DEFAULT 'NOT_LOGGED_IN',
    "lastLoginAt" TIMESTAMP(3),
    "cronEnabled" BOOLEAN NOT NULL DEFAULT true,
    "cronScheduleDibayar" TEXT NOT NULL DEFAULT '0 10 * * 1-5',
    "cronScheduleDikirim" TEXT NOT NULL DEFAULT '0 14 * * 1-5',
    "invenflowKanbanId" TEXT NOT NULL,
    "invenflowKanbanName" TEXT NOT NULL,
    "columnOnPaid" TEXT NOT NULL,
    "columnOnShipped" TEXT NOT NULL,
    "invenflowAuthTokenRef" TEXT NOT NULL,
    "paidUrlOverride" TEXT,
    "shippedUrlOverride" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ServiceToken" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "tokenEnc" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "invenflowUrl" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ServiceToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Run" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "pass" "RunPass" NOT NULL,
    "status" "RunStatus" NOT NULL DEFAULT 'PENDING',
    "triggeredBy" "TriggerType" NOT NULL DEFAULT 'SCHEDULED',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "errorMessage" TEXT,
    "modelUsed" TEXT,
    "orderCount" INTEGER NOT NULL DEFAULT 0,
    "newOrderCount" INTEGER NOT NULL DEFAULT 0,
    "transitionCount" INTEGER NOT NULL DEFAULT 0,
    "failedSyncs" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "Run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Order" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "invoiceNumber" TEXT NOT NULL,
    "orderDate" TIMESTAMP(3) NOT NULL,
    "sellerName" TEXT,
    "totalAmount" DECIMAL(15,2) NOT NULL,
    "shippingFee" DECIMAL(15,2),
    "discount" DECIMAL(15,2),
    "rawData" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderLineItem" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "lineItemId" TEXT NOT NULL,
    "marketplaceProductName" TEXT NOT NULL,
    "marketplaceProductUrl" TEXT,
    "quantity" INTEGER NOT NULL,
    "unitPrice" DECIMAL(15,2) NOT NULL,
    "subtotal" DECIMAL(15,2) NOT NULL,
    "invenflowProductId" TEXT,
    "needsSkuMapping" BOOLEAN NOT NULL DEFAULT false,
    "lifecycleState" "LifecycleState" NOT NULL DEFAULT 'NEW',
    "lastSyncError" TEXT,
    "syncRetryCount" INTEGER NOT NULL DEFAULT 0,
    "ingestedAt" TIMESTAMP(3),
    "shippedAt" TIMESTAMP(3),

    CONSTRAINT "OrderLineItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiSettings" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "apiKey" TEXT NOT NULL,
    "baseUrl" TEXT,
    "temperature" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "maxRetries" INTEGER NOT NULL DEFAULT 3,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Setting" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "isSecret" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Setting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "action" TEXT NOT NULL,
    "entity" TEXT,
    "entityId" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "Run_accountId_startedAt_idx" ON "Run"("accountId", "startedAt");

-- CreateIndex
CREATE INDEX "Run_status_idx" ON "Run"("status");

-- CreateIndex
CREATE INDEX "Order_invoiceNumber_idx" ON "Order"("invoiceNumber");

-- CreateIndex
CREATE UNIQUE INDEX "Order_accountId_invoiceNumber_key" ON "Order"("accountId", "invoiceNumber");

-- CreateIndex
CREATE INDEX "OrderLineItem_invenflowProductId_idx" ON "OrderLineItem"("invenflowProductId");

-- CreateIndex
CREATE INDEX "OrderLineItem_lifecycleState_idx" ON "OrderLineItem"("lifecycleState");

-- CreateIndex
CREATE UNIQUE INDEX "OrderLineItem_orderId_lineItemId_key" ON "OrderLineItem"("orderId", "lineItemId");

-- CreateIndex
CREATE UNIQUE INDEX "Setting_key_key" ON "Setting"("key");

-- CreateIndex
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_entity_entityId_idx" ON "AuditLog"("entity", "entityId");

-- AddForeignKey
ALTER TABLE "Run" ADD CONSTRAINT "Run_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_runId_fkey" FOREIGN KEY ("runId") REFERENCES "Run"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderLineItem" ADD CONSTRAINT "OrderLineItem_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

