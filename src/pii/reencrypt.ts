import { type Keyring } from './keyring';

/**
 * Re-encryption of stored ciphertext onto the current keyring version
 * (BN-REQ-SEC-007).
 *
 * The job is storage-agnostic: a {@link ReencryptTarget} pages through one
 * encrypted column, and {@link reencryptTarget} rewrites every value that the
 * current key did not write. Updates are compare-and-swap on the previous
 * ciphertext, so a row the application rewrote concurrently is left alone.
 */

/** One encrypted value. */
export interface ReencryptRow {
  /** Stable, sortable row key. */
  readonly id: string;
  /** Stored ciphertext. */
  value: string;
  /** AAD the value was bound to. */
  readonly aad: string | undefined;
}

/** One encrypted column. */
export interface ReencryptTarget {
  /** Label for the report, e.g. `tenant_acme.users.emailCiphertext`. */
  readonly name: string;
  /**
   * Reads the next page, ordered by id.
   *
   * @param afterId Last id of the previous page, `null` for the first.
   * @param limit Page size.
   */
  fetchBatch(afterId: string | null, limit: number): Promise<ReencryptRow[]>;
  /**
   * Replaces a value only if it still holds `previous`.
   *
   * @returns `true` when the row was updated.
   */
  update(id: string, previous: string, next: string): Promise<boolean>;
}

/** Outcome for one target. */
export interface ReencryptReport {
  readonly target: string;
  readonly scanned: number;
  /** Values rewritten (or that would be, in a dry run). */
  readonly rewritten: number;
  /** Values that could not be decrypted with any key; left untouched. */
  readonly failed: number;
}

/**
 * Rewrites every non-current value of one target with the current key.
 *
 * @param keyring Keyring whose current version values are moved to.
 * @param target Column to process.
 * @param options Page size and dry-run flag.
 * @returns Counts for the report.
 */
export async function reencryptTarget(
  keyring: Keyring,
  target: ReencryptTarget,
  options: { batchSize: number; dryRun?: boolean },
): Promise<ReencryptReport> {
  let afterId: string | null = null;
  let scanned = 0;
  let rewritten = 0;
  let failed = 0;
  for (;;) {
    const rows = await target.fetchBatch(afterId, options.batchSize);
    if (rows.length === 0) {
      break;
    }
    for (const row of rows) {
      scanned += 1;
      if (keyring.isCurrent(row.value)) {
        continue;
      }
      let plaintext: string;
      try {
        plaintext = keyring.decrypt(row.value, row.aad);
      } catch {
        failed += 1;
        continue;
      }
      if (options.dryRun) {
        rewritten += 1;
        continue;
      }
      if (await target.update(row.id, row.value, keyring.encrypt(plaintext, row.aad))) {
        rewritten += 1;
      }
    }
    afterId = rows[rows.length - 1]?.id ?? null;
    if (rows.length < options.batchSize) {
      break;
    }
  }
  return { target: target.name, scanned, rewritten, failed };
}
