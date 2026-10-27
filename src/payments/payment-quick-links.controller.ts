import { Controller, Get, Param } from '@nestjs/common';
import { ApiNotFoundResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../common/decorators/public.decorator';
import { AuthThrottle } from '../auth/throttling';
import { PaymentQuickLinksService, type PublicQuickLinkView } from './payment-quick-links.service';

/**
 * Ruta pública del quick link de cobro. Sin sesión ni tenant: el código resuelve ambos.
 * Mismo throttler que las credenciales para frenar enumeración de códigos.
 */
@ApiTags('payments')
@Controller('public/quick-links')
export class PaymentQuickLinksController {
  constructor(private readonly quickLinks: PaymentQuickLinksService) {}

  @Public()
  @AuthThrottle()
  @Get(':code')
  @ApiOperation({ summary: 'Public view of a payment quick link (merchant, concept, amount, checkout URL)' })
  @ApiOkResponse({ description: 'The quick link.' })
  @ApiNotFoundResponse({ description: 'Unknown code.' })
  resolve(@Param('code') code: string): Promise<PublicQuickLinkView> {
    return this.quickLinks.resolvePublic(code);
  }
}
