import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { TenantGuard } from '../tenancy/tenant.guard';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { RequireScopes } from '../common/decorators/scopes.decorator';
import { PaymentOrdersService, type CheckoutMode } from './payment-orders.service';
import { PaymentConfigService } from './payment-config.service';
import { WebhookDriftService } from './webhook-drift.service';
import { NetpayClient } from './netpay.client';
import { TenantPrismaService } from '../prisma/tenant-prisma.service';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDefined,
  IsEmail,
  IsISO8601,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUrl,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import {
  MSI_ALLOWED_COUNTS,
  MSI_MINIMUM_BY_COUNT,
  NETPAY_COUNTRY_PATTERN,
  NETPAY_DIGITS_PATTERN,
  NETPAY_STATE_PATTERN,
  NETPAY_CARD_TOKEN_PATTERN,
  NETPAY_CLIENT_ID_PATTERN,
  type NetpayEnvironment,
} from './netpay-endpoints';
import { ValidationException } from '../common/errors/app.exception';
import { Idempotent } from '../common/idempotency/idempotent.decorator';
import { CurrentTenant } from '../common/decorators/current-tenant.decorator';
import type { TenantContext } from '../tenancy/tenant-context.interface';

/** Message for the certification's digits-only rule. */
const DIGITS_RULE = { message: 'must contain digits only.' };

/**
 * Validates a path parameter before it reaches a Netpay URL.
 *
 * @param value Parameter as received.
 * @param pattern Accepted shape.
 * @param name Parameter name, for the message.
 * @returns The value.
 * @throws {ValidationException} When the shape does not match.
 */
function pathParam(value: string, pattern: RegExp, name: string): string {
  if (!pattern.test(value)) {
    throw new ValidationException(`${name} is not valid.`);
  }
  return value;
}

/** The buyer a cash reference is issued to. */
export class OxxoBuyerDto {
  @IsString()
  @Length(1, 120)
  name!: string;

  @IsEmail()
  email!: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  @Matches(NETPAY_DIGITS_PATTERN, DIGITS_RULE)
  phone?: string;
}

/** Body for creating a payment order. */
export class CreatePaymentOrderDto {
  /** Business code the tenant uses for this order. */
  @IsString()
  @Length(1, 120)
  merchantReferenceCode!: string;

  /** Amount as sent by the tenant's own checkout. */
  @IsString()
  @Matches(/^\d{1,10}(\.\d{1,2})?$/)
  amount!: string;

  /** ISO currency. Netpay settles in MXN; other codes are passed through. */
  @IsOptional()
  @IsString()
  @Matches(/^[A-Z]{3}$/)
  currency?: string;

  /**
   * `hosted` (default) sends the buyer to a payment page Netpay hosts; `plus`
   * renders Netpay's button with a server-issued amount token; `custom` charges a
   * token produced by the storefront.
   */
  @IsOptional()
  @IsIn(['hosted', 'plus', 'custom', 'oxxo'])
  checkoutMode?: CheckoutMode;

  /**
   * Methods the hosted page offers: `card`, and/or `cep` (a cash reference, shown by
   * Netpay as OXXO Pay). Default `card`. Only used by `hosted`.
   */
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(2)
  @IsIn(['card', 'cep'], { each: true })
  paymentMethods?: ('card' | 'cep')[];

  /** Buyer a cash reference is issued to. Required for `oxxo`. */
  @ValidateIf((o: CreatePaymentOrderDto) => o.checkoutMode === 'oxxo' || o.buyer !== undefined)
  @IsDefined()
  @ValidateNested()
  @Type(() => OxxoBuyerDto)
  buyer?: OxxoBuyerDto;

  /** Days a cash reference stays payable (1-30). Default 2. */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(30)
  expirationDays?: number;

  /** Where Netpay sends the buyer after a successful hosted payment. */
  @IsOptional()
  @IsUrl({ require_protocol: true, require_tld: false, protocols: ['http', 'https'] })
  @MaxLength(2000)
  successUrl?: string;

  /** Where Netpay sends the buyer after a rejected hosted payment. */
  @IsOptional()
  @IsUrl({ require_protocol: true, require_tld: false, protocols: ['http', 'https'] })
  @MaxLength(2000)
  cancelUrl?: string;

  /**
   * Installment count. Netpay only offers 3, 6, 9, 12 and 18, each with a
   * minimum amount; both are checked here rather than left to a provider error.
   */
  @IsOptional()
  @IsInt()
  @Min(3)
  installments?: number;
}

/** Body for storing a buyer's card with the provider. */
export class StoreCardDto {
  /** The buyer's own identifier in this system. */
  @IsString()
  @MaxLength(120)
  identifier!: string;

  @IsString()
  @MaxLength(80)
  firstName!: string;

  @IsString()
  @MaxLength(80)
  lastName!: string;

  @IsEmail()
  email!: string;

  @IsString()
  @MaxLength(32)
  @Matches(NETPAY_DIGITS_PATTERN, DIGITS_RULE)
  phone!: string;

  /**
   * Card token from client-side tokenisation.
   *
   * Optional: a profile can be created first and a card attached later. A card
   * number is never accepted here, which is what keeps card data out of this
   * process.
   */
  @IsOptional()
  @IsString()
  @Matches(NETPAY_CARD_TOKEN_PATTERN, { message: 'cardToken must be a Netpay token, not card data.' })
  cardToken?: string;
}

/** Postal address Netpay needs on a charge. */
export class ChargeAddressDto {
  @IsString() @MaxLength(80) city!: string;

  /** ISO 3166-1 alpha-2, e.g. `MX`. */
  @IsString() @Matches(NETPAY_COUNTRY_PATTERN) country!: string;

  @IsString() @MaxLength(12) @Matches(NETPAY_DIGITS_PATTERN, DIGITS_RULE) postalCode!: string;

  /**
   * Subdivision segment of the ISO 3166-2 code, without the country: `NLE` for
   * `MX-NLE`. Netpay builds the full code itself.
   */
  @IsString() @Matches(NETPAY_STATE_PATTERN) state!: string;

  @IsString() @MaxLength(120) street1!: string;

  /** Neighbourhood (colonia). */
  @IsOptional() @IsString() @MaxLength(120) street2?: string;
}

/** Billing data Netpay requires on a charge. */
export class ChargeTokenBillingDto {
  @IsString() @MaxLength(80) firstName!: string;
  @IsString() @MaxLength(80) lastName!: string;
  @IsEmail() email!: string;

  /** Required: Netpay creates the buyer's customer profile from it. */
  @IsString() @MaxLength(32) @Matches(NETPAY_DIGITS_PATTERN, DIGITS_RULE) phone!: string;

  /** Required: the gateway answers 500 to a charge without an address. */
  @IsDefined()
  @ValidateNested()
  @Type(() => ChargeAddressDto)
  address!: ChargeAddressDto;
}

/** Body for charging a tokenized card. */
export class ChargeTokenDto {
  /**
   * Token produced by client-side tokenisation. A card number is never accepted
   * here, which is what keeps the card out of this process entirely.
   */
  @IsString()
  @Matches(NETPAY_CARD_TOKEN_PATTERN, { message: 'cardToken must be a Netpay token, not card data.' })
  cardToken!: string;

  @IsDefined()
  @ValidateNested()
  @Type(() => ChargeTokenBillingDto)
  billing!: ChargeTokenBillingDto;

  /** Store the card with Netpay for later use. */
  @IsOptional()
  @IsBoolean()
  saveCard?: boolean;

  /** An existing Netpay customer whose stored card `cardToken` is. */
  @IsOptional()
  @IsString()
  @Matches(NETPAY_CLIENT_ID_PATTERN)
  clientId?: string;

  /** The buyer's own id in this system; the order reference is used when absent. */
  @IsOptional()
  @IsString()
  @MaxLength(120)
  buyerIdentifier?: string;

  @IsOptional()
  @IsInt()
  @Min(3)
  installments?: number;

  /**
   * Fingerprint the browser produced while tokenising the card. It is also the
   * session id, and Netpay expects the same value it saw at tokenisation.
   */
  @IsString()
  @Matches(/^[\x21-\x7e]{1,256}$/)
  deviceFingerPrint!: string;

  /**
   * Device details the browser produced while tokenising (3-D Secure 2 data).
   * Netpay fails 3DS 2.0 without them, so they are required, and the service
   * checks that each field is present.
   */
  @IsObject()
  deviceInformation!: Record<string, string>;

  /**
   * Security code. Netpay requires it on every charge with a stored card
   * (`clientId`); it is forwarded and never stored, logged or returned.
   */
  @IsOptional()
  @IsString()
  @Matches(/^\d{3,4}$/)
  cvv?: string;

  /** `referenceId` the Netpay 3DS library produced in `netpay3ds.config()`. */
  @IsOptional()
  @IsString()
  @Matches(/^[\x21-\x7e]{1,256}$/)
  referenceId?: string;

  /** The buyer's `navigator.userAgent`, which Netpay documents as the value to send. */
  @IsOptional()
  @IsString()
  @Matches(/^[\x20-\x7e]{1,512}$/)
  userAgent?: string;

  /** Card brand from tokenisation; 18 installments are Visa and Mastercard only. */
  @IsOptional()
  @IsString()
  @MaxLength(32)
  cardBrand?: string;
}

/** Body for attaching a card to an existing customer. */
export class AssignCardDto {
  @IsString()
  @Matches(NETPAY_CARD_TOKEN_PATTERN, { message: 'cardToken must be a Netpay token, not card data.' })
  cardToken!: string;

  /** Security code, which Netpay requires on this call. */
  @IsString()
  @Matches(/^\d{3,4}$/)
  cvv!: string;

  /** Ask Netpay to hold 10 MXN to validate the card. */
  @IsOptional()
  @IsBoolean()
  preAuth?: boolean;
}

/** Body for confirming a charge after 3-D Secure. */
export class ConfirmChargeDto {
  /**
   * Id the Netpay 3DS library hands back once the buyer authenticated. Send
   * `null` when `netpay3ds.canProceed` said no challenge was needed.
   */
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @Length(1, 200)
  processorTransactionId!: string | null;
}

/** Body for refunding an order. */
export class RefundOrderDto {
  /** Reason recorded with the reversal. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  motive?: string;

  /** Amount to return; the whole remaining amount when omitted. May be partial. */
  @IsOptional()
  @IsString()
  @Matches(/^\d{1,10}(\.\d{1,2})?$/)
  amount?: string;
}

/** Body for verifying an order against Netpay by hand. */
export class VerifyOrderDto {
  /** Transaction to ask Netpay about. Defaults to the one already bound to the order. */
  @IsOptional()
  @IsString()
  @MaxLength(120)
  transactionId?: string;
}

/** Body for storing the tenant's Netpay credentials. */
export class SavePaymentConfigDto {
  @IsString()
  @Matches(/^pk_netpay_[A-Za-z0-9]+$/)
  publicKey!: string;

  @IsString()
  @Matches(/^sk_netpay_[A-Za-z0-9]+$/)
  secretKey!: string;

  @IsIn(['SANDBOX', 'LIVE'])
  environment!: NetpayEnvironment;

  @IsOptional()
  @IsString()
  @MaxLength(24)
  @Matches(/^[A-Za-z0-9_-]+$/)
  orderReferencePrefix?: string;

  /**
   * Origins a hosted order may send the buyer back to (`https://shop.example.com`),
   * BN-REQ-PAY-007. Empty: any `https` origin, logged as a warning. Omitted: kept.
   */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(255, { each: true })
  allowedReturnOrigins?: string[];

  /** ISO currencies this tenant may charge in (BN-REQ-PAY-008). Default `["MXN"]`. Omitted: kept. */
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10)
  @Matches(/^[A-Z]{3}$/, { each: true })
  allowedCurrencies?: string[];
}

/** Body for changing the tenant's payment settings without touching the keys. */
export class UpdatePaymentSettingsDto {
  /** See {@link SavePaymentConfigDto.allowedReturnOrigins}. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(255, { each: true })
  allowedReturnOrigins?: string[];

  /** See {@link SavePaymentConfigDto.allowedCurrencies}. */
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10)
  @Matches(/^[A-Z]{3}$/, { each: true })
  allowedCurrencies?: string[];
}

/** Query for listing orders (BN-REQ-REC-005). */
export class ListPaymentOrdersQueryDto {
  // A query string arrives as text; without the conversion `?limit=50` is refused
  // as "not an integer".
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  /** `nextCursor` of the previous page, unchanged. */
  @IsOptional()
  @IsString()
  @MaxLength(512)
  cursor?: string;

  /** ISO 8601 instant: only orders changed at or after it, oldest change first. */
  @IsOptional()
  @IsISO8601({ strict: true })
  updatedSince?: string;

  /** One status, or several separated by commas (`PAID,REFUNDED`). */
  @IsOptional()
  @IsString()
  @Matches(/^[A-Z_]+(,[A-Z_]+)*$/)
  @MaxLength(200)
  status?: string;

  @IsOptional()
  @IsString()
  @Length(1, 120)
  merchantReferenceCode?: string;
}

/** Body for registering the inbound webhook URL with Netpay. */
export class RegisterWebhookDto {
  /** Absolute, publicly reachable HTTPS URL. */
  @IsString()
  @IsUrl({ require_protocol: true })
  @MaxLength(2000)
  url!: string;
}

/**
 * Payment configuration and orders for the current tenant.
 *
 * The provider secret never appears in a response: `saveConfig` answers with
 * the public key and the environment only, and there is no endpoint that reads
 * the secret back.
 */
@ApiTags('payments')
@ApiBearerAuth('bearer-jwt')
@Controller('t/payments')
@UseGuards(TenantGuard)
export class PaymentOrdersController {
  constructor(
    private readonly orders: PaymentOrdersService,
    private readonly config: PaymentConfigService,
    private readonly netpay: NetpayClient,
    private readonly tenantPrisma: TenantPrismaService,
    private readonly drift: WebhookDriftService,
  ) {}

  /**
   * Creates an order and a Checkout Hosted session.
   *
   * @param body Order details.
   * @returns The order, with its checkout URL.
   */
  @Post('orders')
  @Idempotent()
  @RequirePermissions('payments:write')
  @RequireScopes('payments:write')
  @ApiOperation({ summary: 'Create a payment order and return a checkout URL' })
  @ApiCreatedResponse({ description: 'The created order.' })
  @HttpCode(HttpStatus.CREATED)
  createOrder(@Body() body: CreatePaymentOrderDto) {
    return this.orders.create({
      merchantReferenceCode: body.merchantReferenceCode,
      amount: body.amount,
      currency: body.currency,
      checkoutMode: body.checkoutMode,
      installments: body.installments,
      successUrl: body.successUrl,
      cancelUrl: body.cancelUrl,
      paymentMethods: body.paymentMethods,
      buyer: body.buyer,
      expirationDays: body.expirationDays,
    });
  }

  /**
   * Lists orders a page at a time, for a consumer to reconcile (BN-REQ-REC-005).
   *
   * @param query Page size, cursor and filters.
   * @returns `{ items, nextCursor }`.
   */
  @Get('orders')
  @RequirePermissions('payments:read')
  @RequireScopes('payments:read')
  @ApiOperation({
    summary: 'List payment orders (cursor pagination)',
    description:
      'Answers `{ items, nextCursor }`; pass `nextCursor` back as `cursor` until it is null. With `updatedSince` the orders come oldest change first (an incremental sync: keep the last `updatedAt` seen); without it, newest first. Filters: `status` (comma-separated), `merchantReferenceCode`. `limit` 1-100, default 25.',
  })
  @ApiOkResponse({ description: 'One page of orders and the cursor of the next one.' })
  listOrders(@Query() query: ListPaymentOrdersQueryDto) {
    return this.orders.list({
      limit: query.limit,
      cursor: query.cursor,
      updatedSince: query.updatedSince === undefined ? undefined : new Date(query.updatedSince),
      status: query.status?.split(','),
      merchantReferenceCode: query.merchantReferenceCode,
    });
  }

  /**
   * Reads one order.
   *
   * @param id Order id.
   * @returns The order.
   */
  @Get('orders/:id')
  @RequirePermissions('payments:read')
  @RequireScopes('payments:read')
  @ApiOperation({
    summary: 'Read one payment order',
    description:
      'Includes what a consumer reconciles against (BN-REQ-REC-006): `verifiedAmount`, `netpayTransactionId`, `refundedAmount`, `failureCode`, `paidAfterCancelAt` and `attempts` (`{ count, items }`).',
  })
  getOrder(@Param('id') id: string) {
    return this.orders.findById(id);
  }

  /**
   * Cancels an unpaid order (BN-REQ-PAY-004).
   *
   * @param id Order id.
   * @returns The cancelled order.
   */
  @Post('orders/:id/cancel')
  @RequirePermissions('payments:write')
  @RequireScopes('payments:write')
  @ApiOperation({
    summary: 'Cancel an unpaid payment order',
    description:
      'From PENDING, PENDING_VERIFICATION or FAILED → CANCELLED, emitting `payment.cancelled`. A bound charge is checked with Netpay first: 409 `ORDER_STATE_CONFLICT` (with the PAID order) if it was charged, or while Netpay has not decided; CHARGE_UNKNOWN is refused until verified. Netpay cannot expire a hosted session or a cash reference, so a payment that still arrives keeps the order CANCELLED and emits `payment.paid_after_cancel` for the consumer to refund. Repeating it on a CANCELLED order answers the order.',
  })
  @HttpCode(HttpStatus.OK)
  cancel(@Param('id') id: string) {
    return this.orders.cancel(id);
  }

  /**
   * Asks Netpay about an order's transaction and settles it from the answer.
   *
   * The way to close an order when the webhook never arrived (Netpay does not retry
   * it) or when a cash reference was paid at a store. The transaction id defaults to
   * the one already bound to the order; pass one seen in Netpay Manager otherwise.
   *
   * @param id Order id.
   * @param body Optional transaction id.
   * @returns What the verification concluded.
   */
  @Post('orders/:id/verify')
  @RequirePermissions('payments:write')
  @RequireScopes('payments:write')
  @ApiOperation({ summary: 'Verify an order against Netpay and settle it' })
  @HttpCode(HttpStatus.OK)
  async verify(@Param('id') id: string, @Body() body: VerifyOrderDto) {
    const order = await this.orders.findById(id);
    const transactionId = body.transactionId ?? order.netpayTransactionId;
    if (transactionId === null || transactionId === undefined) {
      // Netpay offers no search by order reference, so an order whose charge got no
      // answer (CHARGE_UNKNOWN) is resolved by the transaction id: the one Netpay
      // Manager shows, or the one the inbound notification binds (BN-REQ-PAY-003).
      throw new ValidationException(
        'The order has no transaction yet; pass the transactionId Netpay shows (Netpay cannot be searched by order reference).',
      );
    }
    return this.orders.verifyOrder(id, transactionId);
  }

  /**
   * Charges a tokenized card against an existing order. This is the Checkout
   * Custom path, and the only one that never hands the buyer to Netpay.
   *
   * @param id Order id.
   * @param body Token and billing data.
   * @returns The transaction as Netpay reports it.
   */
  @Post('orders/:id/charge')
  @Idempotent()
  @RequirePermissions('payments:write')
  @RequireScopes('payments:write')
  @ApiOperation({ summary: 'Charge a tokenized card against an order' })
  @HttpCode(HttpStatus.OK)
  charge(@Param('id') id: string, @Body() body: ChargeTokenDto) {
    return this.orders.chargeToken(id, {
      cardToken: body.cardToken,
      billing: body.billing,
      saveCard: body.saveCard,
      installments: body.installments,
      clientId: body.clientId,
      buyerIdentifier: body.buyerIdentifier,
      deviceFingerPrint: body.deviceFingerPrint,
      deviceInformation: body.deviceInformation,
      cvv: body.cvv,
      referenceId: body.referenceId,
      userAgent: body.userAgent,
      cardBrand: body.cardBrand,
    });
  }

  /**
   * Confirms a charge after the buyer passed 3-D Secure.
   *
   * A charge that needs authentication answers with `threeDSecureResponse`; the
   * storefront takes the buyer through the Netpay 3DS library and hands back the
   * processor transaction id here, which releases the charge to the bank.
   *
   * @param id Order id.
   * @param body Id the 3DS library returned.
   * @returns The order status after the provider was asked again.
   */
  @Post('orders/:id/confirm')
  @Idempotent()
  @RequirePermissions('payments:write')
  @RequireScopes('payments:write')
  @ApiOperation({ summary: 'Confirm a charge after 3-D Secure' })
  @HttpCode(HttpStatus.OK)
  confirm(@Param('id') id: string, @Body() body: ConfirmChargeDto) {
    return this.orders.confirmCharge(id, body.processorTransactionId);
  }

  /**
   * Stores a buyer's card with the provider, for later use.
   *
   * Netpay keeps the card; this system keeps only the returned token and the last
   * four digits. That is what holds the PCI scope down, and it is why no endpoint
   * here ever accepts a card number.
   *
   * @param body Profile details and the optional card token.
   * @returns The stored profile.
   */
  @Post('cards')
  @RequirePermissions('payments:write')
  @RequireScopes('payments:write')
  @ApiOperation({ summary: 'Store a buyer card with Netpay (saveCard)' })
  @ApiCreatedResponse({ description: 'The stored profile.' })
  storeCard(@Body() body: StoreCardDto) {
    return this.orders.storeCard({
      identifier: body.identifier,
      firstName: body.firstName,
      lastName: body.lastName,
      email: body.email,
      phone: body.phone,
      cardToken: body.cardToken,
    });
  }

  /**
   * Reads a customer and its stored cards.
   *
   * @param clientId Netpay customer id.
   * @returns Cards without any number.
   */
  @Get('cards/:clientId')
  @RequirePermissions('payments:read')
  @RequireScopes('payments:read')
  @ApiOperation({ summary: 'Read a Netpay customer and its stored cards' })
  getCustomer(@Param('clientId') clientId: string) {
    return this.orders.getCustomer(pathParam(clientId, NETPAY_CLIENT_ID_PATTERN, 'clientId'));
  }

  /**
   * Attaches a card token to an existing customer (at most three per customer).
   *
   * @param clientId Netpay customer id.
   * @param body Card token and its security code.
   * @returns The stored card, without the number.
   */
  @Put('cards/:clientId/token')
  @RequirePermissions('payments:write')
  @RequireScopes('payments:write')
  @ApiOperation({ summary: 'Attach a card token to an existing customer' })
  @HttpCode(HttpStatus.OK)
  assignCard(@Param('clientId') clientId: string, @Body() body: AssignCardDto) {
    return this.orders.assignCard(pathParam(clientId, NETPAY_CLIENT_ID_PATTERN, 'clientId'), body);
  }

  /**
   * Deletes a stored card from a customer.
   *
   * @param clientId Netpay customer id.
   * @param token Card token to remove.
   * @returns Confirmation.
   */
  @Delete('cards/:clientId/token/:token')
  @RequirePermissions('payments:write')
  @RequireScopes('payments:write')
  @ApiOperation({ summary: 'Delete a stored card from a customer' })
  @HttpCode(HttpStatus.OK)
  async deleteCard(@Param('clientId') clientId: string, @Param('token') token: string) {
    await this.orders.deleteCard(
      pathParam(clientId, NETPAY_CLIENT_ID_PATTERN, 'clientId'),
      pathParam(token, NETPAY_CARD_TOKEN_PATTERN, 'token'),
    );
    return { deleted: true };
  }

  /**
   * Lists the installment plans Netpay offers, with their minimum amounts.
   *
   * @returns The MSI rules.
   */
  @Get('installments')
  @RequirePermissions('payments:read')
  @RequireScopes('payments:read')
  @ApiOperation({ summary: 'List installment plans and their minimum amounts' })
  installments() {
    return {
      plans: MSI_ALLOWED_COUNTS.map((count) => ({
        count,
        minimumAmount: MSI_MINIMUM_BY_COUNT[count],
      })),
      currency: 'MXN',
    };
  }

  /**
   * Refunds a settled order.
   *
   * @param id Order id.
   * @returns The resulting status.
   */
  @Post('orders/:id/refund')
  @Idempotent()
  @RequirePermissions('payments:refund')
  @RequireScopes('payments:refund')
  @ApiOperation({ summary: 'Refund a settled payment order' })
  @HttpCode(HttpStatus.OK)
  refund(@Param('id') id: string, @Body() body: RefundOrderDto) {
    return this.orders.refund(id, body.motive, body.amount);
  }

  /**
   * Stores the tenant's Netpay credentials.
   *
   * @param body Credentials and environment.
   * @returns The stored configuration, without the secret.
   */
  @Get('config')
  @RequirePermissions('payments:read')
  @RequireScopes('payments:read')
  @ApiOperation({ summary: 'Read this tenant’s Netpay configuration (never the secret)' })
  async readConfig() {
    const stored = await this.tenantPrisma.forCurrentTenantTransaction((client) =>
      client.paymentProviderConfig.findFirst({
        where: { active: true },
        orderBy: { version: 'desc' },
        select: {
          id: true,
          version: true,
          environment: true,
          publicKey: true,
          orderReferencePrefix: true,
          enabled: true,
          webhookRegisteredAt: true,
          webhookDrift: true,
          webhookDriftCheckedAt: true,
          allowedReturnOrigins: true,
          allowedCurrencies: true,
        },
      }),
    );
    if (stored === null) {
      return { configured: false };
    }
    return {
      configured: true,
      configId: stored.id,
      version: stored.version,
      environment: stored.environment,
      // The public key ships to browsers by design: NetpayJS tokenises with it.
      publicKey: stored.publicKey,
      orderReferencePrefix: stored.orderReferencePrefix,
      enabled: stored.enabled,
      allowedReturnOrigins: stored.allowedReturnOrigins,
      allowedCurrencies: stored.allowedCurrencies,
      webhookRegisteredAt: stored.webhookRegisteredAt?.toISOString() ?? null,
      webhookDrift: stored.webhookDrift,
      webhookDriftCheckedAt: stored.webhookDriftCheckedAt?.toISOString() ?? null,
    };
  }

  @Post('config')
  @RequirePermissions('payments:configure')
  @RequireScopes('payments:configure')
  @ApiOperation({
    summary: 'Store this tenant’s Netpay credentials (a new configuration version)',
    description:
      'Append-only (BN-REQ-CFG-002): a change writes the next version and orders keep the version they were created with. A first configuration, or a change of environment or secret key, returns a new `webhookToken` once, retires the previous one and clears `webhookRegisteredAt`: register the new URL with Netpay (BN-REQ-CFG-003).',
  })
  @HttpCode(HttpStatus.OK)
  async saveConfig(@Body() body: SavePaymentConfigDto) {
    const { config, webhookToken } = await this.config.save({
      publicKey: body.publicKey,
      secretKey: body.secretKey,
      environment: body.environment,
      orderReferencePrefix: body.orderReferencePrefix,
      allowedReturnOrigins: body.allowedReturnOrigins,
      allowedCurrencies: body.allowedCurrencies,
    });
    return {
      configId: config.id,
      version: config.version,
      environment: config.environment,
      publicKey: config.publicKey,
      orderReferencePrefix: config.orderReferencePrefix,
      enabled: config.enabled,
      allowedReturnOrigins: config.allowedReturnOrigins,
      allowedCurrencies: config.allowedCurrencies,
      // Returned only when the token is new: a first configuration, or a change of
      // environment or secret key. The caller has to register it with Netpay; there
      // is no way to read it back, since only its hash is stored.
      webhookToken,
      webhookUrlPath: webhookToken === null ? null : `/api/v1/payments/webhook/${webhookToken}`,
    };
  }

  /**
   * Changes the allowlists without touching the keys, as a new configuration version.
   *
   * @param body Settings to change.
   * @returns The new version's settings.
   */
  @Patch('config')
  @RequirePermissions('payments:configure')
  @RequireScopes('payments:configure')
  @ApiOperation({
    summary: 'Change the return-origin and currency allowlists',
    description:
      'Writes a new configuration version with the same keys and webhook token. `allowedReturnOrigins`: https origins a hosted order may return the buyer to (BN-REQ-PAY-007); `allowedCurrencies`: ISO codes this tenant may charge in (BN-REQ-PAY-008).',
  })
  @HttpCode(HttpStatus.OK)
  async updateSettings(@Body() body: UpdatePaymentSettingsDto) {
    const { config } = await this.config.updateSettings({
      allowedReturnOrigins: body.allowedReturnOrigins,
      allowedCurrencies: body.allowedCurrencies,
    });
    return {
      configId: config.id,
      version: config.version,
      allowedReturnOrigins: config.allowedReturnOrigins,
      allowedCurrencies: config.allowedCurrencies,
    };
  }

  /**
   * Issues a fresh inbound webhook token.
   *
   * Returned exactly once, like the one-time secret of an API key. The stored
   * value is a hash, so a database disclosure yields nothing usable.
   *
   * @returns The token and the path to register with Netpay.
   */
  @Post('config/webhook-token')
  @RequirePermissions('payments:configure')
  @RequireScopes('payments:configure')
  @ApiOperation({ summary: 'Rotate the inbound webhook token' })
  @HttpCode(HttpStatus.OK)
  rotateWebhookToken() {
    return this.config.rotateWebhookToken();
  }

  /**
   * Registers the current inbound webhook URL against Netpay.
   *
   * Netpay requires a public HTTPS URL, and a Netpay account is registered per
   * key set, which is what makes the per-tenant isolation work.
   *
   * @param body Absolute URL to register.
   * @returns Confirmation.
   */
  @Post('config/webhook-register')
  @RequirePermissions('payments:configure')
  @RequireScopes('payments:configure')
  @ApiOperation({ summary: 'Register the inbound webhook URL with Netpay' })
  @HttpCode(HttpStatus.OK)
  async registerWebhook(@Body() body: RegisterWebhookDto) {
    const config = await this.config.getUsable();
    if (!/^https:\/\//.test(body.url)) {
      throw new ValidationException('The webhook URL must be HTTPS.');
    }
    await this.netpay.registerWebhook(config.environment, config.secretKey, body.url);
    await this.config.markWebhookRegistered(config.id, body.url);
    return { registered: true };
  }

  /**
   * Reads the webhook URL Netpay has registered for this key set and compares it
   * with this deployment's (BN-REQ-CFG-004).
   *
   * @returns The registered URL (token redacted), the expected one, and `drift`.
   *   A provider error surfaces like every other Netpay call.
   */
  @Get('config/webhook')
  @RequirePermissions('payments:configure')
  @RequireScopes('payments:configure')
  @ApiOperation({
    summary: 'Read the webhook URL registered with Netpay and detect drift',
    description:
      '`drift: true` when Netpay calls anything other than `${PUBLIC_BASE_URL}/api/v1/payments/webhook/{token}` with this tenant’s current token; `reason` is `match`, `none_registered`, `origin`, `path` or `token`. The verdict is stored, logged as `netpay_webhook_drift` (the alert’s metric) and summarised in the authenticated `/health/ready`.',
  })
  async registeredWebhook(@CurrentTenant() tenant: TenantContext) {
    const report = await this.drift.check({ id: tenant.id, schemaName: tenant.schemaName });
    return {
      // Kept for existing readers: the registered URL, with its token redacted.
      webhook: report.registered,
      expected: report.expected,
      drift: report.drift,
      reason: report.reason,
      checkedAt: report.checkedAt,
    };
  }
}
