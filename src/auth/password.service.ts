import { Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';
import { randomBytes } from 'node:crypto';
import { AppConfig } from '../config/app-config.service';

/**
 * Result of verifying a password against a stored hash.
 */
export interface PasswordVerification {
  /** Whether the password matches the hash. */
  readonly valid: boolean;
  /** `true` when the hash used weaker parameters than currently configured. */
  readonly needsRehash: boolean;
}

/**
 * Argon2id password hashing with transparent parameter upgrades.
 *
 * Why Argon2id
 * ------------
 * Argon2id is the current recommendation (RFC 9106): it is memory-hard, resists
 * both GPU parallelism and side-channel attacks, and has no known practical
 * attack cheaper than brute force at sane parameters. bcrypt is not memory-hard
 * and PBKDF2 gives an attacker a better cost per GPU. Cost parameters come from
 * configuration so they can be raised as hardware improves.
 *
 * Constant-time behaviour for unknown accounts
 * ---------------------------------------------
 * A dummy hash is verified when the account does not exist, so a sign-in attempt
 * for an unknown e-mail costs roughly the same CPU time as one for a known
 * e-mail. Without this, response timing alone reveals which e-mail addresses are
 * registered — a real and commonly exploited enumeration vector.
 *
 * Incremental rehashing
 * ---------------------
 * `needsRehash` is checked on every successful verification, so raising the cost
 * parameters upgrades every hash as its owner next signs in, instead of forcing
 * a global reset.
 */
@Injectable()
export class PasswordService {
  /**
   * Argon2id hash of a random value, used to equalise timing on unknown
   * accounts. Computed lazily because the Argon2 API is asynchronous and Nest
   * providers cannot await in their constructor.
   */
  private dummyHashPromise: Promise<string> | null = null;

  /**
   * @param config Validated application configuration providing Argon2 costs.
   */
  constructor(private readonly config: AppConfig) {}

  /**
   * Hashes a plaintext password.
   *
   * @param password Cleartext password.
   * @returns A PHC-formatted Argon2id hash.
   * @throws {Error} When the password is empty.
   */
  async hash(password: string): Promise<string> {
    if (typeof password !== 'string' || password.length === 0) {
      throw new Error('Cannot hash an empty password.');
    }
    return argon2.hash(password, this.hashOptions());
  }

  /**
   * Verifies a password against a stored hash.
   *
   * @param hash Stored PHC-formatted hash, or `null` when the account is unknown.
   * @param password Candidate cleartext password.
   * @returns Verification result including whether a rehash is warranted.
   */
  async verify(hash: string | null, password: string): Promise<PasswordVerification> {
    if (!hash) {
      // Burn equivalent CPU time so "account does not exist" is indistinguishable
      // from "wrong password".
      await argon2.verify(await this.timingEqualisingHash(), password).catch(() => false);
      return { valid: false, needsRehash: false };
    }

    try {
      const valid = await argon2.verify(hash, password);
      const needsRehash = valid && argon2.needsRehash(hash, this.costOptions());
      return { valid, needsRehash };
    } catch {
      // A malformed hash must read as "invalid credentials", never as a crash.
      return { valid: false, needsRehash: false };
    }
  }

  /**
   * Argon2id options for hashing.
   *
   * @returns Cost parameters for a new hash.
   */
  hashOptions(): argon2.HashOptions {
    return {
      type: argon2.argon2id,
      memoryCost: this.config.argon2MemoryCost,
      timeCost: this.config.argon2TimeCost,
      parallelism: this.config.argon2Parallelism,
    };
  }

  /**
   * Cost parameters accepted by `argon2.needsRehash`.
   *
   * `needsRehash` compares costs only — it has no notion of the algorithm — so
   * the `type` option is deliberately omitted here.
   *
   * @returns The configured cost parameters.
   */
  costOptions(): { memoryCost: number; timeCost: number; parallelism: number } {
    return {
      memoryCost: this.config.argon2MemoryCost,
      timeCost: this.config.argon2TimeCost,
      parallelism: this.config.argon2Parallelism,
    };
  }

  /**
   * Lazily computed dummy hash used for timing equalisation.
   *
   * @returns The dummy Argon2id hash.
   */
  timingEqualisingHash(): Promise<string> {
    this.dummyHashPromise ??= argon2.hash(randomBytes(32).toString('hex'), this.hashOptions());
    return this.dummyHashPromise;
  }
}
