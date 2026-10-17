import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthModule } from '../auth/auth.module';
import { TenantPrismaService } from '../prisma/tenant-prisma.service';
import { ControlPlanePrismaService } from '../prisma/control-plane-prisma.service';
import { PaymentSecretBox } from './payment-secret-box';
import { NetpayClient } from './netpay.client';
import { NodeDnsResolver, NodeHttpTransport, NodeOutboundTransport } from './http.transport';
import { PaymentConfigService } from './payment-config.service';
import { PaymentOrdersService } from './payment-orders.service';
import { PaymentEvents } from './payment-events';
import { PaymentOrdersController } from './payment-orders.controller';
import { NetpayWebhookService } from './netpay-webhook.service';
import { NetpayWebhookController } from './netpay-webhook.controller';
import { UrlGuard } from './outbound/url-guard';
import {
  OutboundDispatcher,
  type OutboundOptions,
  type OutboundTransport,
} from './outbound/outbound-dispatcher.service';
import { OutboundWebhookService } from './outbound/outbound-webhook.service';
import { OutboundWebhookController } from './outbound/outbound-webhook.controller';

/** Injection token for the dispatcher tuning. */
export const OUTBOUND_OPTIONS = Symbol('OutboundOptions');

/** Injection token for the outbound transport, so a test can supply a fake. */
export const OUTBOUND_TRANSPORT = Symbol('OutboundTransport');

/**
 * Payments, one Netpay account per tenant.
 *
 * A tenant's configuration, keys and orders live inside its own schema, so the
 * isolation that covers `users` also covers its credentials and its money. The one
 * piece of control-plane state is a routing table from an opaque webhook token to
 * a tenant, because the inbound notification is unsigned and therefore carries no
 * usable tenant identity of its own.
 *
 * Both transports are injected, which is what lets the whole integration be
 * tested with no network.
 */
@Module({
  imports: [AuthModule],
  controllers: [PaymentOrdersController, NetpayWebhookController, OutboundWebhookController],
  providers: [
    {
      provide: PaymentSecretBox,
      inject: [ConfigService],
      useFactory: (config: ConfigService): PaymentSecretBox =>
        new PaymentSecretBox(config.getOrThrow<string>('payments.encryptionKey')),
    },
    {
      provide: NetpayClient,
      inject: [NodeHttpTransport],
      useFactory: (http: NodeHttpTransport) => new NetpayClient(http),
    },
    { provide: NodeHttpTransport, useClass: NodeHttpTransport },
    {
      provide: OUTBOUND_TRANSPORT,
      inject: [NodeHttpTransport],
      useFactory: (http: NodeHttpTransport): OutboundTransport => new NodeOutboundTransport(http),
    },
    {
      provide: OUTBOUND_OPTIONS,
      inject: [ConfigService],
      useFactory: (config: ConfigService): OutboundOptions => ({
        maxAttempts: config.getOrThrow<number>('outboundWebhooks.maxAttempts'),
        baseBackoffMs: config.getOrThrow<number>('outboundWebhooks.baseBackoffMs'),
        maxBackoffMs: config.getOrThrow<number>('outboundWebhooks.maxBackoffMs'),
        jitterMs: config.getOrThrow<number>('outboundWebhooks.jitterMs'),
        timeoutMs: config.getOrThrow<number>('outboundWebhooks.timeoutMs'),
        // Disabled means the dispatcher never polls, so nothing is delivered
        // until it is switched on deliberately.
        pollIntervalMs: config.getOrThrow<boolean>('outboundWebhooks.enabled')
          ? config.getOrThrow<number>('outboundWebhooks.pollIntervalMs')
          : 0,
        batchSize: config.getOrThrow<number>('outboundWebhooks.batchSize'),
        autoDisableAfter: config.getOrThrow<number>('outboundWebhooks.autoDisableAfter'),
        maxTenantsPerTick: config.getOrThrow<number>('outboundWebhooks.maxTenantsPerTick'),
      }),
    },
    {
      provide: UrlGuard,
      inject: [NodeDnsResolver, ConfigService],
      useFactory: (dns: NodeDnsResolver, config: ConfigService): UrlGuard =>
        new UrlGuard(
          dns,
          config.getOrThrow<boolean>('outboundWebhooks.requireHttps'),
          config.getOrThrow<string[]>('outboundWebhooks.allowedCidrs'),
        ),
    },
    { provide: NodeDnsResolver, useClass: NodeDnsResolver },
    {
      provide: OutboundDispatcher,
      inject: [
        TenantPrismaService,
        ControlPlanePrismaService,
        OUTBOUND_TRANSPORT,
        UrlGuard,
        PaymentSecretBox,
        OUTBOUND_OPTIONS,
      ],
      useFactory: (
        tenantPrisma: TenantPrismaService,
        controlPlane: ControlPlanePrismaService,
        transport: OutboundTransport,
        urlGuard: UrlGuard,
        secretBox: PaymentSecretBox,
        options: OutboundOptions,
      ): OutboundDispatcher =>
        new OutboundDispatcher(tenantPrisma, controlPlane, transport, urlGuard, secretBox, options),
    },
    PaymentConfigService,
    PaymentOrdersService,
    PaymentEvents,
    NetpayWebhookService,
    OutboundWebhookService,
  ],
  exports: [PaymentSecretBox, PaymentConfigService, PaymentOrdersService, OutboundDispatcher],
})
export class PaymentsModule {}
