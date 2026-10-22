import { Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiExcludeController } from '@nestjs/swagger';
import {
  ReconciliationService,
  type ReconcileSummary,
} from '../payments/reconciliation/reconciliation.service';
import { OutboundDispatcher } from '../payments/outbound/outbound-dispatcher.service';
import { InternalOnly } from './internal-only.decorator';

/**
 * Routes the platform calls on itself (BN-TASK-016). Mounted outside the API
 * prefix (`/internal/…`, like `/health`) and left out of the public OpenAPI
 * document: no tenant or integrator ever calls them.
 */
@ApiExcludeController()
@Controller('internal')
export class InternalController {
  constructor(
    private readonly reconciliation: ReconciliationService,
    private readonly dispatcher: OutboundDispatcher,
    private readonly config: ConfigService,
  ) {}

  /**
   * One reconciliation pass and one outbound dispatch cycle, on demand.
   *
   * Production and staging scale to zero with CPU throttling, so the in-process
   * timers only run while requests arrive. Cloud Scheduler calls this every 15 min
   * in staging (scripts/gcp/scheduler-internal-tick.sh) with an OIDC ID token of a
   * dedicated service account; production has no scheduler by owner decision
   * (docs/RUNBOOK-PAYMENTS.md §1.2). Exempt from the throttlers.
   *
   * @returns What the pass and the cycle did.
   */
  @Post('tick')
  @HttpCode(HttpStatus.OK)
  @InternalOnly()
  async tick(): Promise<{
    reconcile: ReconcileSummary;
    dispatch: { enabled: boolean; attempted: number };
  }> {
    const reconcile = await this.reconciliation.runOnce();
    // Deliveries switched off stay off: a tick must not override OUTBOUND_WEBHOOK_ENABLED.
    const enabled = this.config.getOrThrow<boolean>('outboundWebhooks.enabled');
    const attempted = enabled ? await this.dispatcher.drainOnce() : 0;
    return { reconcile, dispatch: { enabled, attempted } };
  }
}
