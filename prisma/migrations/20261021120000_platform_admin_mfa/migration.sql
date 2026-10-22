-- TOTP second factor for platform administrators (BN-REQ-SEC-006).
--
-- Additive and nullable: existing administrators keep working until
-- MFA_REQUIRED_FOR_ADMINS (on by default in production) makes them enrol.
-- The secret is ciphertext under the PII keyring; recovery codes are hashes.

ALTER TABLE "platform_admins"
    ADD COLUMN "mfaSecretCiphertext" TEXT,
    ADD COLUMN "mfaEnabledAt" TIMESTAMP(3),
    ADD COLUMN "mfaLastUsedStep" INTEGER,
    ADD COLUMN "mfaRecoveryCodeHashes" TEXT[] DEFAULT ARRAY[]::TEXT[];
