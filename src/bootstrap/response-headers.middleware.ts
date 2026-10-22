import { Injectable, Logger, NestMiddleware } from '@nestjs/common';
import { PiiRedactionService } from '../pii/pii-redaction.service';

/**
 * Adds request id and PII-redaction metadata to the HTTP response headers.
 *
 * Registered before the context middleware so that even a request rejected
 * during tenant resolution carries a correlation id the caller can quote in a
 * support ticket.
 */
@Injectable()
export class ResponseHeadersMiddleware implements NestMiddleware {
  private readonly logger = new Logger(ResponseHeadersMiddleware.name);

  /**
   * @param redaction PII scrubber, exposed for consistency with the auth flow.
   */
  constructor(private readonly redaction: PiiRedactionService) {}

  /**
   * @param _request Incoming request (unused; the response is the subject here).
   * @param response Outgoing response.
   * @param next Next middleware in the chain.
   */
  use(_request: unknown, response: { setHeader(name: string, value: string): void }, next: () => void): void {
    // No X-Powered-By, not even a masked one (BN-REQ-SEC-011): Express' own
    // header is disabled in applyHttpSettings and helmet strips it as well.
    response.setHeader('X-Content-Type-Options', 'nosniff');
    this.logger.debug(`Response headers applied (redaction: ${this.redaction.isEnabled}).`);
    next();
  }
}
