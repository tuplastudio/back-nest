import { Module } from '@nestjs/common';
import { ApiKeysController } from './api-keys.controller';
import { ApiKeyService } from './api-key.service';
import { AuditLogService } from '../audit/audit-log.service';
import { TenantRoleGuard } from '../common/decorators/tenant-role.decorator';

/**
 * Per-tenant API key issuance and lifecycle.
 *
 * Key metadata lives in the control plane rather than in the tenant schema, so a
 * suspended or purged tenant's keys can still be revoked without opening a
 * connection to a schema that may be gone.
 */
@Module({
  controllers: [ApiKeysController],
  providers: [ApiKeyService, AuditLogService, TenantRoleGuard],
  exports: [ApiKeyService, AuditLogService],
})
export class ApiKeysModule {}
