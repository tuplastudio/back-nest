import { Injectable } from '@nestjs/common';
import { MemberRole, ProjectStatus } from '../generated/tenant-plane/enums';
import type { Prisma } from '../generated/tenant-plane/client';
import { TenantPrismaService } from '../prisma/tenant-prisma.service';
import { RequestContextService } from '../tenancy/request-context.service';
import { AuthorizationException, ConflictException, NotFoundException } from '../common/errors/app.exception';
import { TENANT_ROLE_RANK } from '../common/decorators/tenant-role.decorator';

/**
 * Input for creating a project.
 */
export interface CreateProjectInput {
  /** Display name. */
  readonly name: string;
  /** URL-safe identifier, unique within the tenant. */
  readonly slug: string;
  /** Optional description. */
  readonly description?: string;
  /** Initial status. */
  readonly status?: ProjectStatus;
  /** PII-free structured attributes. */
  readonly metadata?: Record<string, unknown>;
  /**
   * Owning member.
   *
   * Required when the caller is an API key, since a key has no member identity
   * and the foreign key to `users` must stay valid. Ignored for member sessions,
   * which always own what they create.
   */
  readonly ownerId?: string;
}

/**
 * Input for updating a project.
 */
export interface UpdateProjectInput {
  /** New display name. */
  readonly name?: string;
  /** New description. */
  readonly description?: string;
  /** New status. */
  readonly status?: ProjectStatus;
  /** Replacement metadata. */
  readonly metadata?: Record<string, unknown>;
  /**
   * Version the caller last observed.
   *
   * When supplied and no longer current, the update is rejected with 409 rather
   * than silently overwriting a concurrent change.
   */
  readonly expectedVersion?: number;
}

/**
 * Example tenant-scoped resource.
 *
 * Serves as the reference implementation for the conventions this base
 * recommends for tenant data:
 *
 *  * **Tenant scoping** — every query runs on the request's schema, so the
 *    `ownerId` filter is a second line of defence rather than the only one.
 *  * **Soft deletion** — `deletedAt` instead of `DELETE`, so a mistake is
 *    recoverable and referential history stays intact.
 *  * **Optimistic concurrency** — a `version` column, so two editors cannot
 *    silently clobber each other.
 *  * **Cursor pagination** — the table grows without bound, so offsets would
 *    degrade and skip rows.
 */
@Injectable()
export class ProjectsService {
  /**
   * @param tenantPrisma Tenant client factory.
   * @param requestContext Request-scoped context holder.
   */
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly requestContext: RequestContextService,
  ) {}

  /**
   * Decides whether the caller may mutate an existing project.
   *
   * The owner may always change their own project. Above the owner, an ADMIN or
   * OWNER member may change anyone's, because that is what those roles mean
   * inside a tenant. Everyone else, including a read-only VIEWER, may not.
   *
   * An API key carries no member identity, so it is governed by its scopes at
   * the guard layer and is allowed to act on the tenant's projects.
   *
   * @param project The project already resolved in this tenant's schema.
   * @throws {AuthorizationException} When the caller may not mutate it.
   */
  private assertMayMutate(project: { ownerId: string }): void {
    const principal = this.requestContext.principal;
    // Platform admins are not tenant-scoped principals and carry no tenant role;
    // API keys are governed by their scopes at the guard layer.
    if (!principal || principal.kind !== 'tenant-user') {
      return;
    }
    if (TENANT_ROLE_RANK[principal.role] >= TENANT_ROLE_RANK[MemberRole.ADMIN]) {
      return;
    }
    if (project.ownerId !== principal.id) {
      throw new AuthorizationException(
        'Only the owner, or a member with the ADMIN role, may change this project.',
      );
    }
  }

  /**
   * Creates a project owned by the caller.
   *
   * @param input Project attributes.
   * @returns The created project.
   * @throws {ConflictException} When the slug is already used in this tenant.
   */
  async create(input: CreateProjectInput) {
    this.requestContext.requireTenant();
    const principal = this.requestContext.requirePrincipal();

    // A member session always owns what it creates. An API key has no member
    // identity, so ownership must be supplied explicitly — fabricating an owner
    // from the key id would break the foreign key to `users`.
    const ownerId = principal.kind === 'api-key' ? (input.ownerId ?? null) : principal.id;

    if (!ownerId) {
      throw new ConflictException('ownerId is required when creating a project with an API key.');
    }

    return this.tenantPrisma.forCurrentTenantTransaction((client) =>
      client.project.create({
        data: {
          name: input.name,
          slug: input.slug,
          description: input.description ?? null,
          status: input.status ?? ProjectStatus.DRAFT,
          metadata: (input.metadata ?? {}) as Prisma.InputJsonValue,
          ownerId,
        },
      }),
    );
  }

  /**
   * Lists projects with cursor pagination and optional filtering.
   *
   * @param filters Filtering and pagination parameters.
   * @returns A page of projects.
   */
  async list(filters: {
    status?: ProjectStatus;
    ownerId?: string;
    limit?: number;
    cursor?: string;
  }): Promise<{ items: readonly unknown[]; nextCursor: string | null; total: number }> {
    const limit = Math.min(Math.max(filters.limit ?? 25, 1), 100);

    const where = {
      deletedAt: null,
      ...(filters.status ? { status: filters.status } : {}),
      ...(filters.ownerId ? { ownerId: filters.ownerId } : {}),
    };

    // Sequential, not Promise.all: both queries share one connection inside the
    // interactive transaction that binds the tenant for row-level security.
    return this.tenantPrisma.forCurrentTenantTransaction(async (client) => {
      const rows = await client.project.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit,
        ...(filters.cursor ? { cursor: { id: filters.cursor }, skip: 1 } : {}),
      });
      const total = await client.project.count({ where });
      return {
        items: rows,
        nextCursor: rows.length === limit ? (rows.at(-1)?.id ?? null) : null,
        total,
      };
    });
  }

  /**
   * Returns one project.
   *
   * @param id Project UUID.
   * @returns The project.
   * @throws {NotFoundException} When it does not exist in this tenant.
   */
  async findById(id: string) {
    const project = await this.tenantPrisma.forCurrentTenantTransaction((client) =>
      client.project.findFirst({ where: { id, deletedAt: null } }),
    );
    if (!project) {
      throw new NotFoundException('Project', id);
    }
    return project;
  }

  /**
   * Updates a project with optional optimistic concurrency control.
   *
   * @param id Project UUID.
   * @param input Fields to change.
   * @returns The updated project.
   * @throws {ConflictException} When the expected version no longer matches.
   */
  async update(id: string, input: UpdateProjectInput) {
    const current = await this.findById(id);
    this.assertMayMutate(current);

    if (input.expectedVersion !== undefined && input.expectedVersion !== current.version) {
      throw new ConflictException(
        `Project was modified concurrently: expected version ${input.expectedVersion}, current is ${current.version}.`,
        { expected: input.expectedVersion, current: current.version },
      );
    }

    return this.tenantPrisma.forCurrentTenantTransaction((client) =>
      client.project.update({
        where: { id },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.status !== undefined ? { status: input.status } : {}),
          ...(input.metadata !== undefined ? { metadata: input.metadata as Prisma.InputJsonValue } : {}),
          version: { increment: 1 },
        },
      }),
    );
  }

  /**
   * Soft-deletes a project.
   *
   * @param id Project UUID.
   * @returns The deleted project.
   */
  async remove(id: string) {
    // Resolving first guarantees a 404 for an unknown id instead of a silent
    // no-op, and confirms the project belongs to this tenant's schema.
    const current = await this.findById(id);
    this.assertMayMutate(current);
    return this.tenantPrisma.forCurrentTenantTransaction((client) =>
      client.project.update({ where: { id }, data: { deletedAt: new Date(), version: { increment: 1 } } }),
    );
  }
}
