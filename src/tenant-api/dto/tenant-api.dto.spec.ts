import 'reflect-metadata';
import { validateSync } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { MemberRole } from '../../generated/tenant-plane/enums';
import { CreateUserDto, GRANTABLE_MEMBER_ROLES } from './tenant-api.dto';

/** The exact ValidationPipe options registered in src/bootstrap/apply-http-settings.ts. */
const PIPE_OPTIONS = {
  whitelist: true,
  forbidNonWhitelisted: true,
  forbidUnknownValues: true,
  transform: true,
  transformOptions: { enableImplicitConversion: false },
  stopAtFirstError: false,
  validationError: { target: false, value: false },
} as const;

function violationsFor(role?: string): string[] {
  const dto = plainToInstance(CreateUserDto, {
    email: 'attacker@dummy.test',
    displayName: 'Escalated',
    password: 'correct-horse-battery-staple',
    ...(role === undefined ? {} : { role }),
  });
  return validateSync(dto as object, PIPE_OPTIONS as never).flatMap((e) =>
    Object.values(e.constraints ?? {}),
  );
}

describe('CreateUserDto.role (regression: OWNER must not be grantable)', () => {
  it.each(['ADMIN', 'MEMBER', 'VIEWER'])('accepts the grantable role %s', (role) => {
    expect(violationsFor(role)).toHaveLength(0);
  });

  it('rejects OWNER with a message that names the rule', () => {
    const violations = violationsFor('OWNER');
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.join(' ')).toContain('OWNER is not grantable');
  });

  it('rejects an unknown role', () => {
    expect(violationsFor('SUPERUSER').length).toBeGreaterThan(0);
  });

  it('does not coerce or strip an injected OWNER value', () => {
    const dto = plainToInstance(CreateUserDto, {
      email: 'attacker@dummy.test',
      displayName: 'X',
      role: 'OWNER',
    });
    expect(dto.role).toBe('OWNER');
  });

  it('excludes OWNER from the exported grantable set', () => {
    expect(GRANTABLE_MEMBER_ROLES as readonly string[]).not.toContain(MemberRole.OWNER);
    expect([...GRANTABLE_MEMBER_ROLES]).toEqual([MemberRole.ADMIN, MemberRole.MEMBER, MemberRole.VIEWER]);
  });

  it('keeps role optional, so an omitted role still validates', () => {
    expect(violationsFor(undefined)).toHaveLength(0);
    expect(plainToInstance(CreateUserDto, { email: 'a@b.test', displayName: 'X' }).role).toBeUndefined();
  });

  it('still rejects a malformed e-mail, proving the pipe options are in effect', () => {
    const dto = plainToInstance(CreateUserDto, { email: 'not-an-email', displayName: 'X' });
    expect(validateSync(dto as object, PIPE_OPTIONS as never).length).toBeGreaterThan(0);
  });
});
