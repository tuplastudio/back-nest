import { randomInt } from 'node:crypto';
import { Injectable, NotFoundException } from '@nestjs/common';
import { ControlPlanePrismaService } from '../prisma/control-plane-prisma.service';
import { TenantPrismaService } from '../prisma/tenant-prisma.service';
import { paymentUrls } from '../config/payment-urls';

/** Alfabeto sin O/0/I/1 para dictar el código por teléfono o leerlo en un ticket. */
const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const CODE_LENGTH = 6;

export interface QuickLinkRef {
  readonly code: string;
  readonly url: string;
}

/** Lo que ve el comprador sin sesión: nada más que lo necesario para decidir pagar. */
export interface PublicQuickLinkView {
  readonly code: string;
  readonly merchant: { readonly name: string };
  readonly concept: string;
  readonly amount: string;
  readonly currency: string;
  readonly status: string;
  /** Sólo mientras la orden está PENDING; después es null para no reenviar a un checkout muerto. */
  readonly hostedCheckoutUrl: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

@Injectable()
export class PaymentQuickLinksService {
  constructor(
    private readonly controlPlane: ControlPlanePrismaService,
    private readonly tenantPrisma: TenantPrismaService,
  ) {}

  /** `true` cuando QUICK_LINK_BASE_URL está configurado. */
  enabled(): boolean {
    return paymentUrls().quickLinkBaseUrl !== null;
  }

  newCode(): string {
    let code = '';
    for (let i = 0; i < CODE_LENGTH; i += 1) {
      code += ALPHABET[randomInt(ALPHABET.length)];
    }
    return code;
  }

  urlFor(code: string): string {
    return `${this.baseUrl()}/${code}`;
  }

  /** URLs de retorno de Netpay para este quick link; el host es nuestro, no del tenant. */
  returnUrls(code: string): { successUrl: string; cancelUrl: string } {
    const url = this.urlFor(code);
    return { successUrl: `${url}?result=ok`, cancelUrl: `${url}?result=cancel` };
  }

  async register(input: {
    code: string;
    tenantId: string;
    schemaName: string;
    orderId: string;
    hostedCheckoutUrl: string;
  }): Promise<QuickLinkRef> {
    await this.controlPlane.client.paymentQuickLink.create({ data: input });
    return { code: input.code, url: this.urlFor(input.code) };
  }

  /** Quick link de una orden del tenant actual, para que el agente lo reenvíe después de creado. */
  async findForOrder(tenantId: string, orderId: string): Promise<QuickLinkRef | null> {
    const link = await this.controlPlane.client.paymentQuickLink.findFirst({
      where: { tenantId, orderId },
      select: { code: true },
    });
    return link === null ? null : { code: link.code, url: this.urlFor(link.code) };
  }

  /**
   * Ruta pública: el código resuelve tenant y orden; la respuesta omite todo lo que no sea
   * necesario para pagar. 404 opaco tanto si el código no existe como si la orden desapareció.
   */
  async resolvePublic(rawCode: string): Promise<PublicQuickLinkView> {
    const code = rawCode.trim().toUpperCase();
    if (!/^[A-Z0-9]{4,12}$/.test(code)) {
      throw new NotFoundException('The requested resource was not found.');
    }
    const link = await this.controlPlane.client.paymentQuickLink.findUnique({
      where: { code },
      select: { code: true, tenantId: true, schemaName: true, orderId: true, hostedCheckoutUrl: true },
    });
    if (link === null) {
      throw new NotFoundException('The requested resource was not found.');
    }
    const [tenant, order] = await Promise.all([
      this.controlPlane.client.tenant.findUnique({
        where: { id: link.tenantId },
        select: { name: true, status: true },
      }),
      this.tenantPrisma.forTenantTransaction(link.schemaName, (client) =>
        client.paymentOrder.findFirst({
          where: { id: link.orderId },
          select: {
            merchantReferenceCode: true,
            amount: true,
            currency: true,
            status: true,
            createdAt: true,
            updatedAt: true,
          },
        }),
      ),
    ]);
    if (tenant === null || tenant.status !== 'ACTIVE' || order === null) {
      throw new NotFoundException('The requested resource was not found.');
    }
    return {
      code: link.code,
      merchant: { name: tenant.name },
      concept: order.merchantReferenceCode,
      amount: order.amount.toFixed(2),
      currency: order.currency,
      status: order.status,
      hostedCheckoutUrl: order.status === 'PENDING' ? link.hostedCheckoutUrl : null,
      createdAt: order.createdAt.toISOString(),
      updatedAt: order.updatedAt.toISOString(),
    };
  }

  private baseUrl(): string {
    const base = paymentUrls().quickLinkBaseUrl;
    if (base === null) {
      throw new Error('QUICK_LINK_BASE_URL is not configured.');
    }
    return base;
  }
}
