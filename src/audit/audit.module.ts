import { Global, Module } from '@nestjs/common';
import { AuditLogService } from './audit-log.service';

/**
 * Append-only audit trail.
 *
 * Global because nearly every module records events, and duplicating the
 * provider per feature module would create separate instances with separate
 * loggers for no benefit.
 */
@Global()
@Module({
  providers: [AuditLogService],
  exports: [AuditLogService],
})
export class AuditModule {}
