import { Logger } from '@nestjs/common';
import { PaymentSecretBox } from './payment-secret-box';
import { type PaymentConfigService } from './payment-config.service';
import { type NetpayClient } from './netpay.client';
import { type TenantPrismaService } from '../prisma/tenant-prisma.service';
import { type ControlPlanePrismaService } from '../prisma/control-plane-prisma.service';
import { logWebhookDrift } from '../common/logging/payment-log-events';
import type { TenantCheck } from './reconciliation/reconciliation.service';

/** Why a registered URL is, or is not, this deployment's. */
export type DriftReason = 'match' | 'none_registered' | 'origin' | 'path' | 'token';

/** Result of comparing the URL Netpay calls with the one it should call. */
export interface DriftComparison {
  /** `true` when Netpay notifies anything other than this deployment's URL for this tenant. */
  readonly drift: boolean;
  readonly reason: DriftReason;
}

/** What `GET /t/payments/config/webhook` answers. */
export interface DriftReport extends DriftComparison {
  /** The URL Netpay has registered, with the token segment redacted; `null` when none. */
  readonly registered: string | null;
  /** The URL it should call, with `{token}` in place of the token; `null` without PUBLIC_BASE_URL. */
  readonly expected: string | null;
  readonly checkedAt: string;
}

/** What authenticated `/health/ready` shows (`netpayWebhookDrift`). */
export interface DriftSummary {
  /** `drift` when any tenant drifts, `unknown` when none drifts but some were never checked. */
  readonly status: 'ok' | 'drift' | 'unknown';
  readonly tenantsChecked: number;
  readonly tenantsDrifted: number;
  readonly tenantsUnchecked: number;
  /** Most recent check among the tenants. */
  readonly lastCheckedAt: string | null;
}

/** Tuning and deployment facts. */
export interface DriftOptions {
  /** `PUBLIC_BASE_URL`; `null` compares the token only. */
  readonly publicBaseUrl: string | null;
  /** Global route prefix (`api/v1`). */
  readonly apiPrefix: string;
  /** How old a tenant's last check may be before reconciliation checks it again. */
  readonly checkIntervalMs: number;
  /** How long the health summary is reused. */
  readonly summaryTtlMs: number;
  readonly now?: () => number;
}

const WEBHOOK_SEGMENT = '/payments/webhook/';

/**
 * Compares the URL Netpay has registered with the one this deployment expects
 * (BN-REQ-CFG-004).
 *
 * Only the token's hash is stored, so the expected URL cannot be rebuilt; instead
 * the registered one is taken apart: its origin must be `PUBLIC_BASE_URL` (when
 * configured), its path `/<prefix>/payments/webhook/<token>`, and the hash of that
 * token the tenant's current `webhookTokenHash`.
 *
 * @param registered URL Netpay answers with, or `null`.
 * @param publicBaseUrl This deployment's origin, or `null`.
 * @param apiPrefix Global route prefix.
 * @param tokenHash The tenant's current token hash.
 * @returns Drift and reason.
 */
export function compareWebhookUrl(
  registered: string | null,
  publicBaseUrl: string | null,
  apiPrefix: string,
  tokenHash: string,
): DriftComparison {
  if (registered === null || registered.trim() === '') {
    return { drift: true, reason: 'none_registered' };
  }
  let url: URL;
  try {
    url = new URL(registered);
  } catch {
    return { drift: true, reason: 'path' };
  }
  const prefix = `/${apiPrefix.replace(/^\/+|\/+$/g, '')}${WEBHOOK_SEGMENT}`;
  if (!url.pathname.startsWith(prefix) || url.search !== '') {
    return { drift: true, reason: 'path' };
  }
  const token = url.pathname.slice(prefix.length);
  if (token === '' || token.includes('/')) {
    return { drift: true, reason: 'path' };
  }
  if (publicBaseUrl !== null && url.origin !== new URL(publicBaseUrl).origin) {
    return { drift: true, reason: 'origin' };
  }
  if (PaymentSecretBox.hashToken(decodeURIComponent(token)) !== tokenHash) {
    return { drift: true, reason: 'token' };
  }
  return { drift: false, reason: 'match' };
}

/**
 * Redacts the token of a webhook URL for display and logs.
 *
 * @param registered URL as registered.
 * @returns The URL with the segment after `/payments/webhook/` replaced.
 */
function redact(registered: string): string {
  const at = registered.indexOf(WEBHOOK_SEGMENT);
  return at === -1 ? registered : `${registered.slice(0, at + WEBHOOK_SEGMENT.length)}[REDACTED]`;
}

/**
 * Detects drift of the webhook URL registered at Netpay (BN-TASK-026,
 * BN-REQ-CFG-004).
 *
 * Asking Netpay costs a call per tenant, so it is never done on a health probe:
 *
 *  * `GET /t/payments/config/webhook` checks on demand;
 *  * reconciliation checks each tenant when its last verdict is older than
 *    `checkIntervalMs` (one hour);
 *  * every check stores its verdict on the active configuration and logs
 *    `netpay_webhook_drift` (`drift` 1/0), which the log-based metric alerts on;
 *  * `/health/ready` (authenticated) shows {@link summary}: the stored verdicts,
 *    read from the database at most once per `summaryTtlMs`.
 */
export class WebhookDriftService implements TenantCheck {
  private readonly logger = new Logger(WebhookDriftService.name);
  private readonly now: () => number;
  private cached: { at: number; summary: Promise<DriftSummary> } | null = null;

  constructor(
    private readonly config: PaymentConfigService,
    private readonly netpay: NetpayClient,
    private readonly tenantPrisma: TenantPrismaService,
    private readonly controlPlane: ControlPlanePrismaService,
    private readonly options: DriftOptions,
  ) {
    this.now = options.now ?? Date.now;
  }

  /** The URL Netpay should call, with `{token}` in place of the token. */
  private expected(): string | null {
    if (this.options.publicBaseUrl === null) {
      return null;
    }
    const prefix = this.options.apiPrefix.replace(/^\/+|\/+$/g, '');
    return `${new URL(this.options.publicBaseUrl).origin}/${prefix}${WEBHOOK_SEGMENT}{token}`;
  }

  /**
   * Asks Netpay which URL it calls for a tenant, compares, stores and logs.
   *
   * @param tenant Tenant and schema.
   * @returns The report.
   */
  async check(tenant: { readonly id: string; readonly schemaName: string }): Promise<DriftReport> {
    const config = await this.config.getUsableInSchema(tenant.schemaName);
    const state = await this.state(tenant.schemaName);
    const answer = await this.netpay.getWebhook(config.environment, config.secretKey);
    // Netpay documents no response schema: the URL is read from either field.
    const url = [answer['webhook'], answer['url']].find(
      (v): v is string => typeof v === 'string' && v !== '',
    );
    const registered = url ?? null;
    const verdict = compareWebhookUrl(
      registered,
      this.options.publicBaseUrl,
      this.options.apiPrefix,
      state?.webhookTokenHash ?? '',
    );
    const checkedAt = new Date(this.now());
    await this.config.recordWebhookDrift(tenant.schemaName, config.id, verdict.drift, checkedAt);
    logWebhookDrift(this.logger, {
      tenantId: tenant.id,
      drift: verdict.drift ? 1 : 0,
      reason: verdict.reason,
    });
    return {
      ...verdict,
      registered: registered === null ? null : redact(registered),
      expected: this.expected(),
      checkedAt: checkedAt.toISOString(),
    };
  }

  /**
   * Checks a tenant when its last verdict is older than the interval; called by
   * each reconciliation pass.
   *
   * @param tenant Tenant and schema.
   * @param now Pass time.
   */
  async checkIfDue(tenant: { readonly id: string; readonly schemaName: string }, now: Date): Promise<void> {
    if (this.options.checkIntervalMs <= 0) {
      return;
    }
    const state = await this.state(tenant.schemaName);
    if (state === null) {
      return;
    }
    const last = state.webhookDriftCheckedAt?.getTime() ?? 0;
    if (now.getTime() - last < this.options.checkIntervalMs) {
      return;
    }
    await this.check(tenant);
  }

  /**
   * The drift of every active tenant, from the stored verdicts. Never calls Netpay;
   * reused for `summaryTtlMs`.
   *
   * @returns The summary.
   */
  summary(): Promise<DriftSummary> {
    const now = this.now();
    if (this.cached !== null && now - this.cached.at < this.options.summaryTtlMs) {
      return this.cached.summary;
    }
    const summary = this.computeSummary();
    this.cached = { at: now, summary };
    summary.catch(() => {
      this.cached = null;
    });
    return summary;
  }

  private async computeSummary(): Promise<DriftSummary> {
    const tenants = await this.controlPlane.client.tenant.findMany({
      where: { status: 'ACTIVE' },
      select: { id: true, schemaName: true },
    });
    let checked = 0;
    let drifted = 0;
    let unchecked = 0;
    let last: number | null = null;
    for (const tenant of tenants) {
      let state: Awaited<ReturnType<WebhookDriftService['state']>> = null;
      try {
        state = await this.state(tenant.schemaName);
      } catch {
        state = null;
      }
      if (state === null) {
        // No payment configuration: nothing to drift.
        continue;
      }
      if (state.webhookDrift === null || state.webhookDriftCheckedAt === null) {
        unchecked += 1;
        continue;
      }
      checked += 1;
      drifted += state.webhookDrift ? 1 : 0;
      last = Math.max(last ?? 0, state.webhookDriftCheckedAt.getTime());
    }
    return {
      status: drifted > 0 ? 'drift' : unchecked > 0 ? 'unknown' : 'ok',
      tenantsChecked: checked,
      tenantsDrifted: drifted,
      tenantsUnchecked: unchecked,
      lastCheckedAt: last === null ? null : new Date(last).toISOString(),
    };
  }

  /**
   * The active configuration's webhook bookkeeping.
   *
   * @param schemaName Tenant schema.
   * @returns The columns, or `null` without a configuration.
   */
  private state(schemaName: string): Promise<{
    id: string;
    webhookTokenHash: string;
    webhookDrift: boolean | null;
    webhookDriftCheckedAt: Date | null;
  } | null> {
    return this.tenantPrisma.forTenantTransaction(schemaName, (client) =>
      client.paymentProviderConfig.findFirst({
        where: { active: true },
        orderBy: { version: 'desc' },
        select: { id: true, webhookTokenHash: true, webhookDrift: true, webhookDriftCheckedAt: true },
      }),
    );
  }
}
