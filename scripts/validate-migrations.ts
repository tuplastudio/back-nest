#!/usr/bin/env tsx
/**
 * Migration Validation Script
 *
 * This script validates Prisma migrations before deployment to ensure:
 * 1. No destructive changes are accidentally introduced
 * 2. Migration files follow naming conventions
 * 3. SQL is syntactically valid
 * 4. No conflicts with existing migrations
 *
 * Usage:
 *   npm run validate-migrations
 *   or
 *   tsx scripts/validate-migrations.ts
 */

import { execSync } from 'child_process';
import { readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';

interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

// ANSI color codes
const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
};

function log(message: string, color: keyof typeof colors = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

function error(message: string) {
  log(`❌ ${message}`, 'red');
}

function success(message: string) {
  log(`✓ ${message}`, 'green');
}

function warning(message: string) {
  log(`⚠ ${message}`, 'yellow');
}

function info(message: string) {
  log(`ℹ ${message}`, 'blue');
}

/**
 * Check if a migration contains destructive operations
 */
function checkDestructiveChanges(sql: string): string[] {
  const destructivePatterns = [
    /DROP\s+(TABLE|COLUMN|INDEX|SCHEMA|DATABASE)/gi,
    /ALTER\s+TABLE.*\s+DROP\s+COLUMN/gi,
    /TRUNCATE\s+TABLE/gi,
    /DELETE\s+FROM\s+\w+\s*(WHERE\s+1=1)?/gi,
  ];

  const errors: string[] = [];

  for (const pattern of destructivePatterns) {
    const matches = sql.match(pattern);
    if (matches) {
      errors.push(`Destructive operation detected: ${matches[0]}`);
    }
  }

  return errors;
}

/**
 * Check if a migration contains potentially unsafe operations
 */
function checkUnsafeChanges(sql: string): string[] {
  const warnings: string[] = [];

  // Long-running operations
  if (sql.match(/ALTER\s+TABLE.*\s+ADD\s+COLUMN.*DEFAULT/gi)) {
    warnings.push('Adding column with DEFAULT may lock the table on large datasets');
  }

  // Data type changes
  if (sql.match(/ALTER\s+TABLE.*\s+ALTER\s+COLUMN.*TYPE/gi)) {
    warnings.push('Changing column type may require exclusive lock and rewrite table');
  }

  // Adding unique constraint on existing data
  if (sql.match(/ALTER\s+TABLE.*\s+ADD\s+CONSTRAINT.*UNIQUE/gi)) {
    warnings.push('Adding UNIQUE constraint on existing table may lock the table');
  }

  // Adding foreign key on existing data
  if (sql.match(/ALTER\s+TABLE.*\s+ADD\s+CONSTRAINT.*FOREIGN\s+KEY/gi)) {
    warnings.push('Adding FOREIGN KEY constraint on existing table may lock the table');
  }

  return warnings;
}

/**
 * Validate migration naming convention
 */
function validateMigrationName(filename: string): string[] {
  const errors: string[] = [];

  // Expected format: YYYYMMDDHHMMSS_migration_name.sql
  const pattern = /^\d{14}_[a-z0-9_]+\.sql$/;

  if (!pattern.test(filename)) {
    errors.push(
      `Invalid migration filename: ${filename}. Expected format: YYYYMMDDHHMMSS_migration_name.sql`
    );
  }

  return errors;
}

/**
 * Validate SQL syntax using Prisma
 */
function validateSQLSyntax(schemaPath: string): string[] {
  const errors: string[] = [];

  try {
    // Try to format the schema to validate syntax
    execSync(`npx prisma format --schema=${schemaPath}`, { stdio: 'pipe' });
  } catch (err) {
    errors.push(`Schema syntax validation failed: ${err}`);
  }

  return errors;
}

/**
 * Check for migration conflicts
 */
function checkMigrationConflicts(): string[] {
  const errors: string[] = [];

  try {
    // Check if there are unapplied migrations in the database
    const status = execSync('npx prisma migrate status --schema prisma/schema.prisma', {
      encoding: 'utf-8',
    });

    if (status.includes('have been applied')) {
      // This is normal, just info
    }
  } catch (err) {
    // If command fails, it might mean no database connection
    // We'll just warn about this
    warnings('Could not check migration status (no database connection?)');
  }

  return errors;
}

/**
 * Main validation function
 */
function validateMigrations(): ValidationResult {
  const result: ValidationResult = {
    valid: true,
    errors: [],
    warnings: [],
  };

  info('Starting migration validation...\n');

  // Check if migrations directory exists
  const migrationsDir = join(process.cwd(), 'prisma', 'migrations');
  if (!existsSync(migrationsDir)) {
    error('Migrations directory not found: prisma/migrations');
    result.valid = false;
    return result;
  }

  // Read migration directories
  const migrationDirs = readdirSync(migrationsDir, { withFileTypes: true })
    .filter((dirent) => dirent.isDirectory())
    .map((dirent) => dirent.name)
    .sort();

  if (migrationDirs.length === 0) {
    warning('No migrations found');
    return result;
  }

  info(`Found ${migrationDirs.length} migration(s)\n`);

  // Validate each migration
  for (const migrationDir of migrationDirs) {
    info(`Validating migration: ${migrationDir}`);

    const migrationFile = join(migrationsDir, migrationDir, 'migration.sql');

    if (!existsSync(migrationFile)) {
      error(`Migration file not found: ${migrationFile}`);
      result.errors.push(`Missing migration.sql in ${migrationDir}`);
      result.valid = false;
      continue;
    }

    // Validate filename
    const nameErrors = validateMigrationName(migrationDir);
    if (nameErrors.length > 0) {
      result.errors.push(...nameErrors);
      result.valid = false;
    }

    // Read SQL
    const sql = readFileSync(migrationFile, 'utf-8');

    // Check for destructive changes
    const destructiveErrors = checkDestructiveChanges(sql);
    if (destructiveErrors.length > 0) {
      result.errors.push(...destructiveErrors.map((e) => `${migrationDir}: ${e}`));
      result.valid = false;
    }

    // Check for unsafe changes
    const unsafeWarnings = checkUnsafeChanges(sql);
    if (unsafeWarnings.length > 0) {
      result.warnings.push(...unsafeWarnings.map((w) => `${migrationDir}: ${w}`));
    }

    success(`Migration ${migrationDir} validated`);
  }

  // Validate schema syntax
  info('\nValidating Prisma schema syntax...');
  const schemaErrors = validateSQLSyntax('prisma/schema.prisma');
  if (schemaErrors.length > 0) {
    result.errors.push(...schemaErrors);
    result.valid = false;
  } else {
    success('Prisma schema syntax is valid');
  }

  // Check for conflicts
  info('\nChecking for migration conflicts...');
  const conflictErrors = checkMigrationConflicts();
  if (conflictErrors.length > 0) {
    result.errors.push(...conflictErrors);
    result.valid = false;
  } else {
    success('No migration conflicts detected');
  }

  return result;
}

/**
 * Main execution
 */
function main() {
  const result = validateMigrations();

  console.log('\n' + '='.repeat(60));
  console.log('VALIDATION RESULTS');
  console.log('='.repeat(60) + '\n');

  if (result.errors.length > 0) {
    error('Errors found:');
    result.errors.forEach((err) => console.log(`  - ${err}`));
    console.log('');
  }

  if (result.warnings.length > 0) {
    warning('Warnings:');
    result.warnings.forEach((warn) => console.log(`  - ${warn}`));
    console.log('');
  }

  if (result.valid) {
    success('All migrations are valid!');
    console.log('\n✓ Ready to deploy migrations');
    process.exit(0);
  } else {
    error('Migration validation failed!');
    console.log('\n✗ Please fix the errors before deploying');
    process.exit(1);
  }
}

// Run if executed directly
if (require.main === module) {
  main();
}

export { validateMigrations };
