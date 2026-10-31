import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Query,
  Redirect,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiExcludeEndpoint, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { IsIn, IsOptional, IsString, IsUrl, Length, MaxLength } from 'class-validator';
import { TenantGuard } from '../../tenancy/tenant.guard';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { RequireScopes } from '../../common/decorators/scopes.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { NotFoundException } from '../../common/errors/app.exception';
import { PaymentGatewaysService } from './payment-gateways.service';
import { GatewayWebhookService } from './gateway-webhook.service';
import { parseGatewayParam, type GatewayProvider } from './gateway-endpoints';

/** Body of `POST /t/payments/gateways/:provider/connect`. */
export class ConnectGatewayDto {
  /** Where the OAuth callback sends the merchant back; must be on `PAYMENT_GATEWAY_RETURN_ORIGINS`. */
  @IsString()
  @IsUrl({ require_protocol: true, require_tld: false, protocols: ['http', 'https'] })
  @MaxLength(2000)
  returnUrl!: string;
}

/** Body of `PUT /t/payments/gateways/:provider/credentials` (Conekta, Openpay). Never logged or returned. */
export class GatewayCredentialsDto {
  @IsString()
  @Length(8, 200)
  privateKey!: string;

  @IsString()
  @Length(8, 200)
  publicKey!: string;

  /** Openpay merchant id (`m…`). */
  @IsOptional()
  @IsString()
  @Length(8, 40)
  merchantId?: string;

  /** Openpay only: which API host the keys belong to. */
  @IsOptional()
  @IsIn(['SANDBOX', 'LIVE'])
  environment?: 'SANDBOX' | 'LIVE';
}

/**
 * Reads the `:provider` path parameter.
 *
 * @param raw `stripe` or `mercadopago`.
 * @returns The gateway.
 * @throws {NotFoundException} For anything else.
 */
function gatewayParam(raw: string): GatewayProvider {
  const provider = parseGatewayParam(raw);
  if (provider === null) {
    throw new NotFoundException('The requested resource was not found.');
  }
  return provider;
}

/** A tenant's alternative gateway accounts (docs 33). */
@ApiTags('payments')
@Controller('t/payments/gateways')
@UseGuards(TenantGuard)
export class PaymentGatewaysController {
  constructor(private readonly gateways: PaymentGatewaysService) {}

  /**
   * Every gateway and whether this tenant can charge with it.
   *
   * @returns `{ data: [...] }`.
   */
  @Get()
  @RequirePermissions('payments:read')
  @RequireScopes('payments:read')
  @ApiOperation({
    summary: 'List payment gateways (Netpay, Stripe, Mercado Pago, Conekta, Openpay) and their connection',
  })
  @ApiOkResponse({ description: '`{ data: [{ provider, available, connected, environment, … }] }`.' })
  async list() {
    return { data: await this.gateways.status() };
  }

  /**
   * Starts the OAuth connection of a gateway.
   *
   * @param provider `stripe` or `mercadopago`.
   * @param body Return URL.
   * @returns `{ authorizeUrl }`.
   */
  @Post(':provider/connect')
  @RequirePermissions('payments:configure')
  @RequireScopes('payments:configure')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Start connecting a Stripe / Mercado Pago account (OAuth)',
    description:
      'Answers `{ authorizeUrl }`. `returnUrl` must be on an origin in PAYMENT_GATEWAY_RETURN_ORIGINS (422 `RETURN_URL_NOT_ALLOWED`). After the merchant authorises, the callback redirects to `returnUrl?gateway=<provider>&status=connected` (or `status=error&reason=<code>`).',
  })
  connect(@Param('provider') provider: string, @Body() body: ConnectGatewayDto) {
    return this.gateways.connect(gatewayParam(provider), body.returnUrl);
  }

  /**
   * Stores a Conekta / Openpay account's API keys (D8).
   *
   * @param provider `conekta` or `openpay`.
   * @param body Keys.
   * @returns The provider's `GET /gateways` row.
   */
  @Put(':provider/credentials')
  @RequirePermissions('payments:configure')
  @RequireScopes('payments:configure')
  @ApiOperation({
    summary: 'Connect Conekta / Openpay with the tenant’s API keys',
    description:
      'Conekta: `{ privateKey, publicKey }`. Openpay: `{ merchantId, privateKey, publicKey, environment }`. The keys are checked against the gateway (422 `GATEWAY_CREDENTIALS_INVALID` when refused), stored encrypted, never returned. Answers the provider’s `GET /gateways` row.',
  })
  saveCredentials(@Param('provider') provider: string, @Body() body: GatewayCredentialsDto) {
    return this.gateways.saveCredentials(gatewayParam(provider), {
      privateKey: body.privateKey,
      publicKey: body.publicKey,
      ...(body.merchantId === undefined ? {} : { merchantId: body.merchantId }),
      ...(body.environment === undefined ? {} : { environment: body.environment }),
    });
  }

  /**
   * Disconnects a gateway.
   *
   * @param provider `stripe` or `mercadopago`.
   * @returns `{ provider, connected: false }`.
   */
  @Delete(':provider')
  @RequirePermissions('payments:configure')
  @RequireScopes('payments:configure')
  @ApiOperation({ summary: 'Disconnect a gateway account (Stripe, Mercado Pago, Conekta, Openpay)' })
  disconnect(@Param('provider') provider: string) {
    return this.gateways.disconnect(gatewayParam(provider));
  }
}

/** Public OAuth callbacks of the gateways. The signed `state` names the tenant. */
@ApiTags('payments')
@Controller('payments/gateways/oauth')
export class GatewayOAuthCallbackController {
  constructor(private readonly gateways: PaymentGatewaysService) {}

  /**
   * Completes an OAuth connection and sends the merchant back.
   *
   * @param provider `stripe` or `mercadopago`.
   * @param query `code`, `state`, `error`.
   * @returns The redirect.
   */
  @Public()
  @Get(':provider/callback')
  @Redirect()
  @ApiExcludeEndpoint()
  async callback(
    @Param('provider') provider: string,
    @Query() query: { code?: string; state?: string; error?: string },
  ): Promise<{ url: string; statusCode: number }> {
    const url = await this.gateways.completeOAuth(gatewayParam(provider), {
      code: typeof query.code === 'string' ? query.code : undefined,
      state: typeof query.state === 'string' ? query.state : undefined,
      error: typeof query.error === 'string' ? query.error : undefined,
    });
    return { url, statusCode: HttpStatus.FOUND };
  }
}

/**
 * Gateway webhooks: signed (Stripe, Mercado Pago) or routed by an opaque token
 * (Conekta, Openpay). Public, and always the same answer: an unauthenticated
 * route that answered differently per outcome would be an enumeration oracle.
 */
@ApiTags('payments')
@Controller('payments/gateway-webhook')
export class GatewayWebhookController {
  constructor(private readonly webhooks: GatewayWebhookService) {}

  /**
   * Stripe Connect events.
   *
   * @param request Carries the raw body kept by the JSON parser (`main.ts`).
   * @param signature `Stripe-Signature`.
   */
  @Public()
  @Post('stripe')
  @HttpCode(HttpStatus.OK)
  @ApiExcludeEndpoint()
  async stripe(
    @Req() request: Request & { rawBody?: Buffer },
    @Headers('stripe-signature') signature: string | undefined,
  ): Promise<void> {
    await this.webhooks.receiveStripe(request.rawBody, signature);
  }

  /**
   * Mercado Pago notifications.
   *
   * @param signature `x-signature`.
   * @param requestId `x-request-id`.
   * @param dataId `data.id` query parameter.
   * @param body Notification body.
   */
  @Public()
  @Post('mercadopago')
  @HttpCode(HttpStatus.OK)
  @ApiExcludeEndpoint()
  async mercadoPago(
    @Headers('x-signature') signature: string | undefined,
    @Headers('x-request-id') requestId: string | undefined,
    @Query('data.id') dataId: string | undefined,
    @Body() body: { type?: string; user_id?: number | string; data?: { id?: string | number } } | undefined,
  ): Promise<void> {
    await this.webhooks.receiveMercadoPago({
      signature,
      requestId,
      queryDataId: typeof dataId === 'string' ? dataId : undefined,
      body,
    });
  }

  /**
   * Conekta / Openpay notifications, routed by the per-tenant token.
   *
   * @param provider `conekta` or `openpay`.
   * @param token Opaque token.
   * @param body Notification body.
   */
  @Public()
  @Post(':provider/:token')
  @HttpCode(HttpStatus.OK)
  @ApiExcludeEndpoint()
  async withToken(
    @Param('provider') provider: string,
    @Param('token') token: string,
    @Body() body: unknown,
  ): Promise<void> {
    const gateway = parseGatewayParam(provider);
    if (gateway === 'CONEKTA' || gateway === 'OPENPAY') {
      await this.webhooks.receiveWithToken(gateway, token, body);
    }
  }
}
