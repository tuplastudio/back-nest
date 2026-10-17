import { Injectable } from '@nestjs/common';
import { PiiCryptoService } from '../pii/pii-crypto.service';

/**
 * Purpose-built masking strategies for PII rendering.
 *
 * Masking is the *default* presentation. A raw value is only ever returned to
 * the principal that owns it, and only when it is explicitly required.
 */
@Injectable()
export class PiiMaskService {
  /**
   * Masks an e-mail address, keeping enough characters to recognise it.
   *
   * `ada.lovelace@example.com` becomes `a***e@example.com`. For very short
   * local parts the whole local part is hidden.
   *
   * @param email Address to mask.
   * @returns The masked representation.
   */
  maskEmail(email: string): string {
    if (!email || !email.includes('@')) {
      return '***';
    }
    const [local, domain] = this.splitEmail(email);
    if (local.length <= 2) {
      return `***@${domain}`;
    }
    const visibleHead = local.slice(0, 1);
    const visibleTail = local.slice(-1);
    return `${visibleHead}${'*'.repeat(Math.min(local.length - 2, 8))}${visibleTail}@${domain}`;
  }

  /**
   * Masks a phone number, keeping the country code and last two digits.
   *
   * `+5215512345678` becomes `+52*****78`.
   *
   * @param phone Phone number in E.164 format.
   * @returns The masked representation.
   */
  maskPhone(phone: string): string {
    if (!phone || phone.length <= 4) {
      return '***';
    }
    const head = phone.slice(0, Math.min(3, phone.length - 4));
    const tail = phone.slice(-2);
    return `${head}${'*'.repeat(Math.max(phone.length - head.length - tail.length, 3))}${tail}`;
  }

  /**
   * Masks an IPv4 or IPv6 address down to its network prefix.
   *
   * `192.168.1.42` becomes `192.168.1.0/24`, `2001:db8::1` becomes
   * `2001:db8::/32`. Enough to spot abuse patterns, not enough to identify a
   * device.
   *
   * @param ip Address to mask.
   * @returns The masked representation.
   */
  maskIp(ip: string): string {
    if (ip.includes(':')) {
      const groups = ip.split(':').filter((group) => group.length > 0);
      return `${groups.slice(0, 2).join(':')}::/32`;
    }
    const octets = ip.split('.');
    if (octets.length !== 4) {
      return '***';
    }
    return `${octets.slice(0, 3).join('.')}.0/24`;
  }

  /**
   * Masks a person's display name, keeping the first letter.
   *
   * @param name Name to mask.
   * @returns The masked representation.
   */
  maskName(name: string): string {
    if (!name) {
      return '***';
    }
    return `${name.slice(0, 1)}${'*'.repeat(Math.min(name.length - 1, 7))}`;
  }

  /**
   * Generic helper for free-text secrets.
   *
   * @param value Value to redact.
   * @returns A fixed placeholder that reveals nothing about the input.
   */
  redact(value: string): string {
    return value ? '[REDACTED]' : '';
  }

  /**
   * Splits an address into local and domain parts.
   *
   * @param email Address to split.
   * @returns Tuple of `[localPart, domain]`.
   */
  private splitEmail(email: string): [string, string] {
    const normalized = PiiCryptoService.normalizeEmail(email);
    const atIndex = normalized.lastIndexOf('@');
    return [normalized.slice(0, atIndex), normalized.slice(atIndex + 1)];
  }
}
