import { Body, Controller, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { ApiExcludeEndpoint, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../common/decorators/public.decorator';
import { NetpayWebhookService, type InboundNetpayEvent } from './netpay-webhook.service';

/**
 * Inbound payment notifications from Netpay.
 *
 * Two properties of this route are not negotiable:
 *
 * It is {@link Public}, because Netpay sends no credential. What replaces
 * authentication is the opaque token in the path, which is unguessable, stored
 * only as a hash, and rotatable — and it is the *only* thing identifying the
 * tenant. `X-Tenant-Id` is deliberately ignored: a header is caller-supplied
 * and an unsigned notification proves nothing about who sent it.
 *
 * And it always answers the same way. An unauthenticated route that said
 * "unknown tenant" differently from "unknown order" would be an enumeration
 * oracle across every tenant's payments.
 */
@ApiTags('payments')
@Controller('payments/webhook')
export class NetpayWebhookController {
  constructor(private readonly webhooks: NetpayWebhookService) {}

  /**
   * Receives one notification.
   *
   * @param token Opaque per-tenant token.
   * @param payload Notification body.
   * @returns Nothing; the status is always the same.
   */
  @Public()
  @Post(':token')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Inbound payment notification (called by Netpay)' })
  @ApiExcludeEndpoint()
  async receive(@Param('token') token: string, @Body() payload: InboundNetpayEvent): Promise<void> {
    await this.webhooks.receive(token, payload ?? {});
  }
}
