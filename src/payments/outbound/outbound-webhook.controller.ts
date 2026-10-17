import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ArrayMinSize, IsArray, IsBoolean, IsOptional, IsString, IsUrl, MaxLength } from 'class-validator';
import { TenantGuard } from '../../tenancy/tenant.guard';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { OutboundWebhookService } from './outbound-webhook.service';
import { ALL_PAYMENT_EVENTS } from '../payment-events';

/** Body for registering an outbound endpoint. */
export class CreateWebhookEndpointDto {
  @IsString()
  @IsUrl({ require_protocol: true })
  @MaxLength(2000)
  url!: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  description?: string;

  @IsArray()
  // `MinLength` would measure the string representation of the array rather
  // than its length, so the array needs its own rule.
  @ArrayMinSize(1)
  @IsString({ each: true })
  events!: string[];
}

/** Body for toggling an endpoint. */
export class ToggleWebhookEndpointDto {
  @IsBoolean()
  enabled!: boolean;
}

/**
 * The tenant's outbound webhook endpoints.
 *
 * `webhooks:write` is deliberately not granted to `tenant-admin`: registering a
 * destination creates a channel through which tenant data leaves, on top of the
 * outbound-request surface the URL guard has to police.
 */
@ApiTags('webhooks')
@ApiBearerAuth('bearer-jwt')
@Controller('t/webhooks')
@UseGuards(TenantGuard)
export class OutboundWebhookController {
  constructor(private readonly endpoints: OutboundWebhookService) {}

  /**
   * Lists endpoints.
   *
   * @returns The tenant's endpoints.
   */
  @Get()
  @RequirePermissions('webhooks:read')
  @ApiOperation({ summary: 'List outbound webhook endpoints' })
  list() {
    return this.endpoints.list();
  }

  /**
   * Registers an endpoint and returns its signing secret once.
   *
   * @param body Destination and subscribed events.
   * @returns The endpoint and its secret.
   */
  @Post()
  @RequirePermissions('webhooks:write')
  @ApiOperation({ summary: 'Register an outbound webhook endpoint' })
  @ApiCreatedResponse({ description: 'The endpoint; the secret is shown only here.' })
  create(@Body() body: CreateWebhookEndpointDto) {
    return this.endpoints.create({
      url: body.url,
      description: body.description,
      events: body.events,
    });
  }

  /**
   * Lists the events that can be subscribed to.
   *
   * @returns Event names.
   */
  @Get('events')
  @RequirePermissions('webhooks:read')
  @ApiOperation({ summary: 'List subscribable events' })
  availableEvents() {
    return { events: ALL_PAYMENT_EVENTS };
  }

  /**
   * Rotates an endpoint's secret, keeping the previous one valid.
   *
   * @param id Endpoint id.
   * @returns The endpoint and its new secret.
   */
  @Post(':id/rotate-secret')
  @RequirePermissions('webhooks:rotate-secret')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Rotate an endpoint signing secret' })
  @ApiOkResponse({ description: 'The endpoint; the new secret is shown only here.' })
  rotateSecret(@Param('id') id: string) {
    return this.endpoints.rotateSecret(id);
  }

  /**
   * Ends a rotation overlap.
   *
   * @param id Endpoint id.
   */
  @Post(':id/end-rotation')
  @RequirePermissions('webhooks:rotate-secret')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Retire the previous signing secret' })
  endRotation(@Param('id') id: string) {
    return this.endpoints.endRotation(id);
  }

  /**
   * Enables or disables an endpoint.
   *
   * @param id Endpoint id.
   * @param body Desired state.
   */
  @Post(':id/status')
  @RequirePermissions('webhooks:write')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Enable or disable an endpoint' })
  setStatus(@Param('id') id: string, @Body() body: ToggleWebhookEndpointDto) {
    return this.endpoints.setEnabled(id, body.enabled);
  }

  /**
   * Lists recent deliveries for an endpoint.
   *
   * @param id Endpoint id.
   * @returns The deliveries.
   */
  @Get(':id/deliveries')
  @RequirePermissions('webhooks:read')
  @ApiOperation({ summary: 'List recent deliveries for an endpoint' })
  deliveries(@Param('id') id: string) {
    return this.endpoints.deliveries(id);
  }

  /**
   * Re-queues a delivery.
   *
   * @param deliveryId Delivery id.
   */
  @Post('deliveries/:deliveryId/replay')
  @RequirePermissions('webhooks:replay')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Re-queue a delivery' })
  replay(@Param('deliveryId') deliveryId: string) {
    return this.endpoints.replay(deliveryId);
  }
}
