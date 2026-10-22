import { type LoggerService } from '@nestjs/common';

/**
 * Structured payment events, the contract between the code and the log-based
 * metrics of `scripts/gcp/monitoring/log-metrics.sh` (BN-REQ-OPS-005).
 *
 * {@link JsonLogger} flattens the payload into the Cloud Logging entry, so each
 * field below is `jsonPayload.<field>` in a metric filter or extractor. Renaming
 * a field here silently empties a metric: the test pins the names, and the
 * script reads the same constants' values.
 *
 * No PII and no provider-supplied text: ids, enums and numbers only.
 */
export const PAYMENT_LOG_EVENTS = {
  /** A payment order changed state. Metric: `payment_status_change` (counter by `to`). */
  statusChange: 'payment_status_change',
  /** One HTTP call to NetPay finished. Metric: `netpay_latency_ms` (distribution of `latencyMs`). */
  netpayRequest: 'netpay_request',
  /** One outbound webhook delivery attempt finished. Metric: `outbound_delivery_result` (counter by `result`). */
  outboundDelivery: 'outbound_delivery_result',
  /** Orders one reconciliation pass checked in a tenant. Metric: `reconcile_checked` (sum of `count`). */
  reconcileChecked: 'reconcile_checked',
  /** An order reconciliation changed. Metric: `reconcile_corrected` (counter by `from`, `to`). */
  reconcileCorrected: 'reconcile_corrected',
  /** Orders reconciliation could not check. Metric: `reconcile_errors` (sum of `count`). */
  reconcileErrors: 'reconcile_errors',
  /** Result of a webhook drift check. Metric: `netpay_webhook_drift` (`drift` 1/0, alert on 1). */
  webhookDrift: 'netpay_webhook_drift',
} as const;

/** Fields of a `payment_status_change` line. */
export interface PaymentStatusChange {
  readonly orderId: string;
  /** Previous status, or `null` on creation. */
  readonly from: string | null;
  readonly to: string;
  /** What caused it: `api`, `webhook`, `reconciliation`, … */
  readonly source: string;
}

/** Fields of a `netpay_request` line. */
export interface NetpayRequest {
  /** Logical operation, e.g. `charge`, `refund`, `checkout_session`. */
  readonly operation: string;
  readonly outcome: 'ok' | 'error' | 'timeout';
  readonly latencyMs: number;
  /** HTTP status, when a response arrived. */
  readonly httpStatus?: number;
}

/** Fields of an `outbound_delivery_result` line. */
export interface OutboundDeliveryResult {
  readonly deliveryId: string;
  readonly result: 'delivered' | 'retry' | 'failed' | 'disabled';
  readonly attempt: number;
  readonly httpStatus?: number;
  readonly latencyMs?: number;
}

/**
 * Logs a payment status change.
 *
 * @param logger Any Nest logger; in production the JSON logger.
 * @param fields See {@link PaymentStatusChange}.
 */
export function logPaymentStatusChange(
  logger: Pick<LoggerService, 'log'>,
  fields: PaymentStatusChange,
): void {
  logger.log({
    event: PAYMENT_LOG_EVENTS.statusChange,
    message: `order ${fields.orderId}: ${fields.from ?? '∅'} → ${fields.to}`,
    ...fields,
  });
}

/**
 * Logs a finished NetPay call; errors and timeouts at `warn`.
 *
 * @param logger Any Nest logger.
 * @param fields See {@link NetpayRequest}.
 */
export function logNetpayRequest(logger: Pick<LoggerService, 'log' | 'warn'>, fields: NetpayRequest): void {
  const entry = {
    event: PAYMENT_LOG_EVENTS.netpayRequest,
    message: `netpay ${fields.operation} ${fields.outcome} in ${Math.round(fields.latencyMs)}ms`,
    ...fields,
    latencyMs: Math.round(fields.latencyMs),
  };
  if (fields.outcome === 'ok') {
    logger.log(entry);
  } else {
    logger.warn(entry);
  }
}

/**
 * Logs an outbound webhook delivery attempt; anything but `delivered` at `warn`.
 *
 * @param logger Any Nest logger.
 * @param fields See {@link OutboundDeliveryResult}.
 */
export function logOutboundDelivery(
  logger: Pick<LoggerService, 'log' | 'warn'>,
  fields: OutboundDeliveryResult,
): void {
  const entry = {
    event: PAYMENT_LOG_EVENTS.outboundDelivery,
    message: `delivery ${fields.deliveryId} attempt ${fields.attempt}: ${fields.result}`,
    ...fields,
  };
  if (fields.result === 'delivered') {
    logger.log(entry);
  } else {
    logger.warn(entry);
  }
}

/** Fields of a `reconcile_checked` / `reconcile_errors` line. */
export interface ReconcileCount {
  readonly tenantId: string;
  readonly count: number;
}

/** Fields of a `reconcile_corrected` line. */
export interface ReconcileCorrected {
  readonly tenantId: string;
  readonly orderId: string;
  readonly from: string;
  readonly to: string;
  /** What reconciliation did: `verified`, `expired`, `refund_completed`, `charge_unknown_reset`, `paid_after_cancel`. */
  readonly action: string;
}

/** Fields of a `netpay_webhook_drift` line. */
export interface WebhookDriftCheck {
  readonly tenantId: string;
  /** 1 when Netpay calls another URL than this deployment's, 0 when it matches. */
  readonly drift: 0 | 1;
  /** `match`, `none_registered`, `origin`, `path` or `token`. Never the URL itself. */
  readonly reason: string;
}

/**
 * Logs how many orders one reconciliation pass checked in a tenant.
 *
 * @param logger Any Nest logger.
 * @param fields See {@link ReconcileCount}.
 */
export function logReconcileChecked(logger: Pick<LoggerService, 'log'>, fields: ReconcileCount): void {
  logger.log({
    event: PAYMENT_LOG_EVENTS.reconcileChecked,
    message: `reconciliation checked ${fields.count} order(s)`,
    ...fields,
  });
}

/**
 * Logs an order reconciliation corrected.
 *
 * @param logger Any Nest logger.
 * @param fields See {@link ReconcileCorrected}.
 */
export function logReconcileCorrected(logger: Pick<LoggerService, 'log'>, fields: ReconcileCorrected): void {
  logger.log({
    event: PAYMENT_LOG_EVENTS.reconcileCorrected,
    message: `reconciliation ${fields.action} order ${fields.orderId}: ${fields.from} → ${fields.to}`,
    ...fields,
  });
}

/**
 * Logs the orders reconciliation could not check, at `warn`.
 *
 * @param logger Any Nest logger.
 * @param fields See {@link ReconcileCount}.
 */
export function logReconcileErrors(logger: Pick<LoggerService, 'warn'>, fields: ReconcileCount): void {
  logger.warn({
    event: PAYMENT_LOG_EVENTS.reconcileErrors,
    message: `reconciliation could not check ${fields.count} order(s)`,
    ...fields,
  });
}

/**
 * Logs a webhook drift check; a drift at `warn`.
 *
 * @param logger Any Nest logger.
 * @param fields See {@link WebhookDriftCheck}.
 */
export function logWebhookDrift(
  logger: Pick<LoggerService, 'log' | 'warn'>,
  fields: WebhookDriftCheck,
): void {
  const entry = {
    event: PAYMENT_LOG_EVENTS.webhookDrift,
    message: `netpay webhook drift=${fields.drift} (${fields.reason})`,
    ...fields,
  };
  if (fields.drift === 1) {
    logger.warn(entry);
  } else {
    logger.log(entry);
  }
}
