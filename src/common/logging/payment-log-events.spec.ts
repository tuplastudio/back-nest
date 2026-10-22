import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JsonLogger } from './json-logger';
import {
  logNetpayRequest,
  logOutboundDelivery,
  logPaymentStatusChange,
  logReconcileChecked,
  logReconcileCorrected,
  logReconcileErrors,
  logWebhookDrift,
  PAYMENT_LOG_EVENTS,
} from './payment-log-events';

describe('payment log events (BN-TASK-044)', () => {
  const lines: Array<Record<string, unknown>> = [];
  const logger = new JsonLogger({
    level: 'log',
    write: (l) => lines.push(JSON.parse(l) as Record<string, unknown>),
  });
  const script = readFileSync(join(process.cwd(), 'scripts/gcp/monitoring/log-metrics.sh'), 'utf8');

  beforeEach(() => {
    lines.length = 0;
  });

  it('payment_status_change carries the fields the metric reads', () => {
    logPaymentStatusChange(logger, { orderId: 'o1', from: 'PENDING', to: 'PAID', source: 'webhook' });
    expect(lines[0]).toMatchObject({
      severity: 'INFO',
      event: 'payment_status_change',
      to: 'PAID',
      from: 'PENDING',
    });
  });

  it('netpay_request is a rounded latency, warn on failure', () => {
    logNetpayRequest(logger, { operation: 'charge', outcome: 'timeout', latencyMs: 15000.4 });
    expect(lines[0]).toMatchObject({
      severity: 'WARNING',
      event: 'netpay_request',
      operation: 'charge',
      latencyMs: 15000,
    });
  });

  it('outbound_delivery_result carries result', () => {
    logOutboundDelivery(logger, { deliveryId: 'd1', result: 'retry', attempt: 2, httpStatus: 503 });
    expect(lines[0]).toMatchObject({
      severity: 'WARNING',
      event: 'outbound_delivery_result',
      result: 'retry',
    });
  });

  it('reconcile_checked / reconcile_corrected / reconcile_errors carry counts and the transition (BN-TASK-016)', () => {
    logReconcileChecked(logger, { tenantId: 't1', count: 3 });
    logReconcileCorrected(logger, {
      tenantId: 't1',
      orderId: 'o1',
      from: 'PENDING',
      to: 'PAID',
      action: 'verified',
    });
    logReconcileErrors(logger, { tenantId: 't1', count: 2 });
    expect(lines).toEqual([
      expect.objectContaining({ severity: 'INFO', event: 'reconcile_checked', count: 3 }),
      expect.objectContaining({
        severity: 'INFO',
        event: 'reconcile_corrected',
        from: 'PENDING',
        to: 'PAID',
      }),
      expect.objectContaining({ severity: 'WARNING', event: 'reconcile_errors', count: 2 }),
    ]);
  });

  it('netpay_webhook_drift is 1 (warning) on drift and 0 otherwise (BN-TASK-026)', () => {
    logWebhookDrift(logger, { tenantId: 't1', drift: 1, reason: 'token' });
    logWebhookDrift(logger, { tenantId: 't1', drift: 0, reason: 'match' });
    expect(lines).toEqual([
      expect.objectContaining({ severity: 'WARNING', event: 'netpay_webhook_drift', drift: 1 }),
      expect.objectContaining({ severity: 'INFO', event: 'netpay_webhook_drift', drift: 0 }),
    ]);
  });

  it('the log-based metrics filter on these exact event names and fields', () => {
    for (const event of Object.values(PAYMENT_LOG_EVENTS)) {
      expect(script).toContain(`jsonPayload.event="${event}"`);
    }
    expect(script).toContain('EXTRACT(jsonPayload.latencyMs)');
    expect(script).toContain('EXTRACT(jsonPayload.to)');
    expect(script).toContain('EXTRACT(jsonPayload.result)');
    expect(script).toContain('EXTRACT(jsonPayload.count)');
    expect(script).toContain('EXTRACT(jsonPayload.drift)');
  });
});
