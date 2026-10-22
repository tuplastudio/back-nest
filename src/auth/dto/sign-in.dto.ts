import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsNotEmpty, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Credentials submitted by a platform administrator.
 *
 * The e-mail is PII: it is never logged in clear text, never persisted as
 * plaintext, and is only ever returned to the caller in masked form.
 */
export class SignInDto {
  /** Registered e-mail address. */
  @ApiProperty({
    example: 'owner@example.com',
    description: 'E-mail address of the platform administrator.',
  })
  @IsEmail({}, { message: 'A valid e-mail address is required.' })
  @MaxLength(320)
  email!: string;

  /** Account password. */
  @ApiProperty({
    example: 'correct-horse-battery-staple',
    description: 'Account password. Never logged.',
    format: 'password',
  })
  @IsString()
  @MinLength(8, { message: 'Password must be at least 8 characters long.' })
  @MaxLength(200)
  password!: string;

  /**
   * TOTP or recovery code. Optional: without it an MFA-enrolled admin gets a
   * session that can only call `POST /auth/mfa/verify`.
   */
  @ApiPropertyOptional({ example: '123456', description: 'TOTP or recovery code (BN-REQ-SEC-006).' })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  otp?: string;
}

/** A TOTP or recovery code. */
export class MfaCodeDto {
  /** Six-digit TOTP code, or a recovery code. */
  @ApiProperty({ example: '123456' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(32)
  code!: string;
}

/** Password change payload (BN-REQ-SEC-008). */
export class ChangePasswordDto {
  /** Password in use. */
  @ApiProperty({ format: 'password' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  currentPassword!: string;

  /** Replacement password. */
  @ApiProperty({ format: 'password', minLength: 12 })
  @IsString()
  @MinLength(12, { message: 'The new password must be at least 12 characters long.' })
  @MaxLength(200)
  newPassword!: string;
}

/** MFA enrolment material, shown once. */
export class MfaEnrollmentDto {
  /** Base32 shared secret. */
  @ApiProperty()
  secret!: string;

  /** `otpauth://` URI to render as a QR code. */
  @ApiProperty()
  otpauthUrl!: string;
}

/**
 * Refresh token submitted to obtain a new access token.
 */
export class RefreshTokenDto {
  /** The refresh token issued at sign-in. */
  @ApiProperty({ description: 'Refresh token issued by the previous sign-in or refresh.' })
  @IsString()
  @IsNotEmpty()
  refreshToken!: string;
}

/**
 * Successful authentication result.
 *
 * The refresh token is also set as an `HttpOnly` cookie by the controller, so
 * browser clients never expose it to JavaScript. The body copy exists for
 * non-browser clients such as CLIs and backend services.
 */
export class TokenResponseDto {
  /** Signed JWT access token. */
  @ApiProperty({ description: 'Short-lived JWT for the Authorization header.' })
  accessToken!: string;

  /** Rotating refresh token. */
  @ApiProperty({ description: 'Long-lived refresh token; rotate on every use.' })
  refreshToken!: string;

  /** Token type, always `Bearer`. */
  @ApiProperty({ example: 'Bearer' })
  tokenType!: 'Bearer';

  /** Access token lifetime in seconds. */
  @ApiProperty({ example: 900, description: 'Access token lifetime in seconds.' })
  expiresIn!: number;

  /** Masked e-mail, so the client can confirm which account signed in. */
  @ApiProperty({ example: 'o***r@example.com', description: 'Masked e-mail of the authenticated principal.' })
  emailMasked!: string;

  /** Non-PII display name of the principal. */
  @ApiProperty({ example: 'Platform Owner' })
  displayName!: string;

  /** Granted role, for UI affordances only. The server re-checks permissions. */
  @ApiProperty({ enum: ['OWNER', 'ADMIN', 'AUDITOR'] })
  role!: string;

  /** `true` when the account must set a new password before continuing. */
  @ApiProperty({ description: 'Whether a password change is required before use.' })
  mustChangePassword!: boolean;

  /**
   * `true` when the session still owes a second factor: verify at
   * `POST /auth/mfa/verify`, or enrol first when none is set up.
   */
  @ApiProperty({ description: 'Whether the session must still verify (or enrol) a second factor.' })
  mfaRequired!: boolean;
}
