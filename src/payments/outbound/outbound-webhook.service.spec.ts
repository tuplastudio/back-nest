import 'reflect-metadata';
import { OutboundWebhookService } from './outbound-webhook.service';
import { PaymentSecretBox } from '../payment-secret-box';
import { UrlGuard, UrlRejectedError, type DnsResolver } from './url-guard';
import { NotFoundException, ValidationException } from '../../common/errors/app.exception';
import type { TenantPrismaService } from '../../prisma/tenant-prisma.service';
import type { RequestContextService } from '../../tenancy/request-context.service';
import type { AuditEntry, AuditLogService } from '../../audit/audit-log.service';

const TENANT = '11111111-1111-4111-8111-111111111111';
const OTHER_TENANT = '22222222-2222-4222-8222-222222222222';

interface EndpointRow {
  id: string;
  tenantId: string;
  url: string;
  description: string | null;
  events: string[];
  status: string;
  consecutiveFailures: number;
  disabledReason: string | null;
  disabledAt: Date | null;
  secretCiphertext: string;
  previousSecretCiphertext: string | null;
  createdAt: Date;
}

interface DeliveryRow {
  id: string;
  endpointId: string;
  status: string;
  attempt: number;
  error: string | null;
  nextAttemptAt: Date | null;
  createdAt: Date;
  eventId?: string;
  eventType?: string;
  orderId?: string | null;
  replayedAt?: Date | null;
  attemptsBeforeReplay?: number;
}

/** The member acting in these tests. */
const ACTOR = {
  kind: 'tenant-user',
  id: 'member-7',
  displayName: 'Ops',
  role: 'OWNER',
  tenantId: TENANT,
} as const;

/**
 * Builds the service over an in-memory tenant schema.
 *
 * @param tenantId Tenant resolved for the request, or `null` for none.
 * @param answers DNS answers for every name.
 */
function harness(
  tenantId: string | null = TENANT,
  answers: { address: string; family: 4 | 6 }[] = [{ address: '93.184.216.34', family: 4 }],
) {
  const box = new PaymentSecretBox(Buffer.alloc(32, 6).toString('base64'));
  const endpoints = new Map<string, EndpointRow>();
  const deliveries = new Map<string, DeliveryRow>();

  const pick = <T extends object>(row: T, select: Record<string, boolean> | undefined): Partial<T> =>
    select === undefined
      ? row
      : (Object.fromEntries(Object.keys(select).map((key) => [key, row[key as keyof T]])) as Partial<T>);

  const client = {
    webhookEndpoint: {
      findMany: (args: { where: { tenantId: string }; select: Record<string, boolean> }) =>
        Promise.resolve(
          [...endpoints.values()]
            .filter((e) => e.tenantId === args.where.tenantId)
            .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
            .map((e) => pick(e, args.select)),
        ),
      findFirst: (args: { where: { id: string; tenantId: string }; select: Record<string, boolean> }) => {
        const row = endpoints.get(args.where.id);
        return Promise.resolve(row && row.tenantId === args.where.tenantId ? pick(row, args.select) : null);
      },
      create: (args: { data: Partial<EndpointRow>; select: Record<string, boolean> }) => {
        const row = {
          status: 'ACTIVE',
          consecutiveFailures: 0,
          disabledReason: null,
          disabledAt: null,
          previousSecretCiphertext: null,
          createdAt: new Date(),
          ...args.data,
        } as EndpointRow;
        endpoints.set(row.id, row);
        return Promise.resolve(pick(row, args.select));
      },
      update: (args: {
        where: { id: string };
        data: Partial<EndpointRow>;
        select?: Record<string, boolean>;
      }) => {
        const row = endpoints.get(args.where.id)!;
        Object.assign(row, args.data);
        return Promise.resolve(pick(row, args.select));
      },
    },
    webhookDelivery: {
      findMany: (args: { where: { endpointId: string }; take: number }) =>
        Promise.resolve(
          [...deliveries.values()].filter((d) => d.endpointId === args.where.endpointId).slice(0, args.take),
        ),
      findFirst: (args: {
        where: { id: string; endpoint: { tenantId: string } };
        select: Record<string, boolean>;
      }) => {
        const row = deliveries.get(args.where.id);
        const owner = row === undefined ? undefined : endpoints.get(row.endpointId);
        return Promise.resolve(
          row && owner?.tenantId === args.where.endpoint.tenantId ? pick(row, args.select) : null,
        );
      },
      update: (args: { where: { id: string }; data: Partial<DeliveryRow> }) => {
        const row = deliveries.get(args.where.id)!;
        Object.assign(row, args.data);
        return Promise.resolve(row);
      },
    },
  };

  const tenantPrisma = {
    forCurrentTenantTransaction: (cb: (c: typeof client) => Promise<unknown>) => cb(client),
  } as unknown as TenantPrismaService;
  const requestContext = {
    get: () => ({
      tenant: tenantId === null ? undefined : { id: tenantId },
      principal: ACTOR,
      ipHash: 'ip-hash',
      userAgentHash: 'ua-hash',
    }),
  } as unknown as RequestContextService;
  const dns: DnsResolver = { lookup: () => Promise.resolve(answers) };
  const audits: AuditEntry[] = [];
  const audit = {
    record: (entry: AuditEntry) => {
      audits.push(entry);
      return Promise.resolve();
    },
  } as unknown as AuditLogService;

  const service = new OutboundWebhookService(
    tenantPrisma,
    requestContext,
    box,
    new UrlGuard(dns, true),
    audit,
  );
  return { service, endpoints, deliveries, box, audits };
}

const CREATE = { url: 'https://hooks.example.com/pay?route=a', description: 'ERP', events: ['payment.paid'] };

describe('OutboundWebhookService', () => {
  describe('create', () => {
    it('stores the endpoint, encrypts the secret and shows it exactly once', async () => {
      const { service, endpoints, box } = harness();
      const created = await service.create(CREATE);
      expect(created.secret).toMatch(/^whsec_/);
      expect(created.url).toBe(CREATE.url);
      expect(created.status).toBe('ACTIVE');
      expect(typeof created.createdAt).toBe('string');

      const stored = endpoints.get(created.id)!;
      expect(stored.tenantId).toBe(TENANT);
      expect(stored.secretCiphertext).not.toContain(created.secret);
      expect(box.decrypt(stored.secretCiphertext, PaymentSecretBox.aadForEndpoint(created.id))).toBe(
        created.secret,
      );
      // Never in a listing.
      const [listed] = await service.list();
      expect(listed).not.toHaveProperty('secret');
      expect(JSON.stringify(listed)).not.toContain(created.secret);
    });

    it('accepts a host with several public addresses (BN-TASK-001)', async () => {
      const { service } = harness(TENANT, [
        { address: '93.184.216.34', family: 4 },
        { address: '93.184.216.35', family: 4 },
        { address: '2606:2800:220:1::1', family: 6 },
      ]);
      await expect(service.create(CREATE)).resolves.toMatchObject({ status: 'ACTIVE' });
    });

    it('refuses a host with one private address with 422 BLOCKED_ADDRESS', async () => {
      const { service, endpoints } = harness(TENANT, [
        { address: '93.184.216.34', family: 4 },
        { address: '10.0.0.1', family: 4 },
      ]);
      const error = await service.create(CREATE).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(UrlRejectedError);
      expect(error).toMatchObject({ code: 'BLOCKED_ADDRESS', status: 422 });
      expect(endpoints.size).toBe(0);
    });

    it('requires at least one event', async () => {
      const { service } = harness();
      await expect(service.create({ ...CREATE, events: [] })).rejects.toBeInstanceOf(ValidationException);
    });

    it('names unknown events', async () => {
      const { service } = harness();
      await expect(
        service.create({ ...CREATE, events: ['payment.paid', 'payment.teleported'] }),
      ).rejects.toThrow(/payment\.teleported/);
    });

    it('stores a missing description as null', async () => {
      const { service } = harness();
      const created = await service.create({ url: CREATE.url, events: CREATE.events });
      expect(created.description).toBeNull();
    });

    it('refuses to act without a resolved tenant', async () => {
      const { service } = harness(null);
      await expect(service.create(CREATE)).rejects.toBeInstanceOf(ValidationException);
      await expect(service.list()).rejects.toBeInstanceOf(ValidationException);
    });
  });

  describe('rotation', () => {
    it('issues a new secret, keeps the previous one valid and re-enables the endpoint', async () => {
      const { service, endpoints, box } = harness();
      const created = await service.create(CREATE);
      Object.assign(endpoints.get(created.id)!, {
        status: 'AUTO_DISABLED',
        consecutiveFailures: 40,
        disabledReason: 'Failing continuously for 24 h.',
      });

      const rotated = await service.rotateSecret(created.id);
      expect(rotated.secret).not.toBe(created.secret);
      expect(rotated.status).toBe('ACTIVE');
      expect(rotated.consecutiveFailures).toBe(0);
      expect(rotated.disabledReason).toBeNull();
      const stored = endpoints.get(created.id)!;
      const aad = PaymentSecretBox.aadForEndpoint(created.id);
      expect(box.decrypt(stored.secretCiphertext, aad)).toBe(rotated.secret);
      expect(box.decrypt(stored.previousSecretCiphertext!, aad)).toBe(created.secret);

      await service.endRotation(created.id);
      expect(endpoints.get(created.id)!.previousSecretCiphertext).toBeNull();
    });

    it('treats an endpoint of another tenant as absent', async () => {
      const { service, endpoints } = harness();
      const created = await service.create(CREATE);
      endpoints.get(created.id)!.tenantId = OTHER_TENANT;
      await expect(service.rotateSecret(created.id)).rejects.toBeInstanceOf(NotFoundException);
      await expect(service.endRotation(created.id)).rejects.toBeInstanceOf(NotFoundException);
      await expect(service.setEnabled(created.id, false)).rejects.toBeInstanceOf(NotFoundException);
      await expect(service.deliveries(created.id)).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('audit of endpoint changes (BN-REQ-OPS-011)', () => {
    it('records create, rotation, end of rotation and enable/disable with the actor, never a secret', async () => {
      const { service, audits } = harness();
      const created = await service.create(CREATE);
      await service.rotateSecret(created.id);
      await service.endRotation(created.id);
      await service.setEnabled(created.id, false);
      await service.setEnabled(created.id, true);
      expect(audits.map((a) => a.action)).toEqual([
        'webhook.endpoint_created',
        'webhook.endpoint_secret_rotated',
        'webhook.endpoint_rotation_ended',
        'webhook.endpoint_disabled',
        'webhook.endpoint_enabled',
      ]);
      for (const entry of audits) {
        expect(entry).toMatchObject({
          tenantId: TENANT,
          actorType: 'TENANT_USER',
          actorId: 'member-7',
          resourceType: 'webhook_endpoint',
          resourceId: created.id,
        });
        expect(JSON.stringify(entry)).not.toContain(created.secret);
      }
      expect(audits[0].metadata).toMatchObject({ events: ['payment.paid'] });
    });
  });

  describe('setEnabled', () => {
    it('disables with an operator reason and re-enables cleanly', async () => {
      const { service, endpoints } = harness();
      const created = await service.create(CREATE);
      await service.setEnabled(created.id, false);
      expect(endpoints.get(created.id)).toMatchObject({
        status: 'DISABLED',
        disabledReason: 'Disabled by an operator.',
      });
      expect(endpoints.get(created.id)!.disabledAt).toBeInstanceOf(Date);

      await service.setEnabled(created.id, true);
      expect(endpoints.get(created.id)).toMatchObject({
        status: 'ACTIVE',
        disabledReason: null,
        disabledAt: null,
      });
    });
  });

  describe('deliveries and replay', () => {
    it('lists recent deliveries for an owned endpoint', async () => {
      const { service, deliveries } = harness();
      const created = await service.create(CREATE);
      deliveries.set('d1', {
        id: 'd1',
        endpointId: created.id,
        status: 'DEAD',
        attempt: 30,
        error: 'UNRESOLVED',
        nextAttemptAt: null,
        createdAt: new Date(),
      });
      await expect(service.deliveries(created.id)).resolves.toHaveLength(1);
    });

    it('re-queues a delivery for another attempt', async () => {
      const { service, deliveries } = harness();
      const created = await service.create(CREATE);
      deliveries.set('d1', {
        id: 'd1',
        endpointId: created.id,
        status: 'DEAD',
        attempt: 30,
        error: 'HTTP 500',
        nextAttemptAt: null,
        createdAt: new Date(),
      });
      await service.replay('d1');
      expect(deliveries.get('d1')).toMatchObject({ status: 'PENDING', error: null });
      expect(deliveries.get('d1')!.nextAttemptAt).toBeInstanceOf(Date);
    });

    it('keeps the attempt history and restarts the retry window at the replay (BN-REQ-EVT-010)', async () => {
      const { service, deliveries } = harness();
      const created = await service.create(CREATE);
      const before = Date.now();
      deliveries.set('d1', {
        id: 'd1',
        endpointId: created.id,
        status: 'DEAD',
        attempt: 30,
        error: 'HTTP 500',
        nextAttemptAt: null,
        createdAt: new Date(before - 48 * 3_600_000),
      });
      await service.replay('d1');
      const row = deliveries.get('d1')!;
      // Not reset: the next attempt is the 30th, and the header says so.
      expect(row.attempt).toBe(30);
      // Attempts already made; the cap counts only those after the replay.
      expect(row.attemptsBeforeReplay).toBe(29);
      expect(row.replayedAt).toBeInstanceOf(Date);
      expect(row.replayedAt!.getTime()).toBeGreaterThanOrEqual(before);
    });

    it('audits the replay with the actor, the tenant and the transition', async () => {
      const { service, deliveries, audits } = harness();
      const created = await service.create(CREATE);
      deliveries.set('d1', {
        id: 'd1',
        endpointId: created.id,
        status: 'DEAD',
        attempt: 12,
        error: 'HTTP 500',
        nextAttemptAt: null,
        createdAt: new Date(),
        eventId: 'evt_1',
        eventType: 'payment.paid',
        orderId: 'order-9',
      });
      audits.length = 0;
      await service.replay('d1');
      expect(audits).toEqual([
        expect.objectContaining({
          tenantId: TENANT,
          actorType: 'TENANT_USER',
          actorId: 'member-7',
          action: 'webhook.delivery_replayed',
          resourceType: 'webhook_delivery',
          resourceId: 'd1',
          metadata: expect.objectContaining({
            endpointId: created.id,
            eventId: 'evt_1',
            orderId: 'order-9',
            from: 'DEAD',
            to: 'PENDING',
            attempt: 12,
          }) as unknown,
        }),
      ]);
    });

    it('refuses to replay a delivery of another tenant, or one that does not exist', async () => {
      const { service, deliveries, endpoints } = harness();
      const created = await service.create(CREATE);
      endpoints.get(created.id)!.tenantId = OTHER_TENANT;
      deliveries.set('d1', {
        id: 'd1',
        endpointId: created.id,
        status: 'DEAD',
        attempt: 3,
        error: null,
        nextAttemptAt: null,
        createdAt: new Date(),
      });
      await expect(service.replay('d1')).rejects.toBeInstanceOf(NotFoundException);
      await expect(service.replay('missing')).rejects.toBeInstanceOf(NotFoundException);
      expect(deliveries.get('d1')!.status).toBe('DEAD');
    });
  });
});
