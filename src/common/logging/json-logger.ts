import { type LoggerService, type LogLevel } from '@nestjs/common';
import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Levels accepted by `LOG_LEVEL`, from least to most verbose.
 *
 * `fatal` is not configurable: a process that is about to die always says why.
 */
export const LOG_LEVELS = ['error', 'warn', 'log', 'debug', 'verbose'] as const;

/** A value of `LOG_LEVEL`. */
export type ConfiguredLogLevel = (typeof LOG_LEVELS)[number];

/**
 * Cloud Logging severities, keyed by Nest level.
 *
 * Cloud Run parses a JSON line written to stdout into a structured entry and
 * reads `severity` from it; without the field every line lands as `DEFAULT`
 * and no alert can filter on errors.
 */
const SEVERITY: Record<LogLevel, string> = {
  fatal: 'CRITICAL',
  error: 'ERROR',
  warn: 'WARNING',
  log: 'INFO',
  debug: 'DEBUG',
  verbose: 'DEBUG',
};

/** Fields a log line can inherit from the request it is emitted in. */
export interface LogContextFields {
  /** Correlation id echoed in `X-Request-Id`. */
  requestId?: string;
  /** Tenant the request resolved to. */
  tenantId?: string;
  /** Cloud Trace id from `X-Cloud-Trace-Context`. */
  traceId?: string;
  /** Span id from the same header. */
  spanId?: string;
  /** Whether the upstream sampled the trace (`o=1`). */
  traceSampled?: boolean;
}

/**
 * Per-request fields set by the access-log middleware.
 *
 * A dedicated store rather than `RequestContextService` because the access log
 * runs before Nest's middleware chain (it has to, to time the whole request),
 * and the trace header is known before any tenant is resolved.
 */
export const logContextStorage = new AsyncLocalStorage<LogContextFields>();

/** Options for {@link JsonLogger}. */
export interface JsonLoggerOptions {
  /** Most verbose level emitted; mirrors `LOG_LEVEL`. */
  level: ConfiguredLogLevel;
  /**
   * GCP project that owns the trace. Cloud Logging only links an entry to a
   * trace when the field is the full resource name, so without a project the
   * trace field is omitted rather than emitted in a form it would ignore.
   */
  projectId?: string;
  /** Extra request fields, e.g. read from `RequestContextService`. */
  context?: () => LogContextFields;
  /** Sink, one call per line. Defaults to `process.stdout`. */
  write?: (line: string) => void;
  /** Clock, injectable for tests. */
  now?: () => Date;
}

/** Keys a structured payload is not allowed to overwrite. */
const RESERVED_KEYS = new Set(['severity', 'timestamp']);

/** `TRACE_ID[/SPAN_ID][;o=OPTIONS]`, as sent by Google front ends. */
const CLOUD_TRACE_PATTERN = /^([a-f0-9]{32})(?:\/(\d{1,20}))?(?:;o=([01]))?$/i;

/**
 * Parses an `X-Cloud-Trace-Context` header.
 *
 * Anything that does not match is dropped: the value is client-controlled and
 * ends up verbatim in a log field.
 *
 * @param header Raw header value.
 * @returns The trace fields, or an empty object when absent or malformed.
 */
export function parseTraceContext(header: string | undefined): LogContextFields {
  const match = header ? CLOUD_TRACE_PATTERN.exec(header.trim()) : null;
  if (!match?.[1]) {
    return {};
  }
  const fields: LogContextFields = { traceId: match[1].toLowerCase() };
  if (match[2]) {
    fields.spanId = match[2];
  }
  if (match[3]) {
    fields.traceSampled = match[3] === '1';
  }
  return fields;
}

/**
 * Nest logger that writes one JSON object per line, in the shape Cloud Logging
 * understands.
 *
 * Every line carries `severity`, `message`, `timestamp` and, inside a request,
 * `requestId`, `tenantId` and `logging.googleapis.com/trace`. A structured
 * payload (`logger.log({ event: 'payment_status_change', ... })`) is flattened
 * into the entry, which is what lets log-based metrics extract its fields.
 *
 * `LOG_LEVEL` is honoured: lines more verbose than the configured level are
 * never serialised. `fatal` always passes.
 */
export class JsonLogger implements LoggerService {
  private enabled: Set<LogLevel>;
  private readonly write: (line: string) => void;
  private readonly now: () => Date;

  /**
   * @param options See {@link JsonLoggerOptions}.
   */
  constructor(private readonly options: JsonLoggerOptions) {
    this.enabled = JsonLogger.levelsUpTo(options.level);
    this.write = options.write ?? ((line) => process.stdout.write(`${line}\n`));
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Levels enabled by a `LOG_LEVEL` value.
   *
   * @param level Most verbose level to emit.
   * @returns That level, every less verbose one, and `fatal`.
   */
  static levelsUpTo(level: ConfiguredLogLevel): Set<LogLevel> {
    const index = LOG_LEVELS.indexOf(level);
    return new Set<LogLevel>(['fatal', ...LOG_LEVELS.slice(0, index + 1)]);
  }

  /**
   * Whether a level would be written.
   *
   * @param level Level to test.
   * @returns `true` when enabled.
   */
  isEnabled(level: LogLevel): boolean {
    return this.enabled.has(level);
  }

  /** @inheritdoc */
  setLogLevels(levels: LogLevel[]): void {
    this.enabled = new Set<LogLevel>(['fatal', ...levels]);
  }

  /** @inheritdoc */
  log(message: unknown, ...optionalParams: unknown[]): void {
    this.emit('log', message, optionalParams);
  }

  /** @inheritdoc */
  error(message: unknown, ...optionalParams: unknown[]): void {
    this.emit('error', message, optionalParams);
  }

  /** @inheritdoc */
  warn(message: unknown, ...optionalParams: unknown[]): void {
    this.emit('warn', message, optionalParams);
  }

  /** @inheritdoc */
  debug(message: unknown, ...optionalParams: unknown[]): void {
    this.emit('debug', message, optionalParams);
  }

  /** @inheritdoc */
  verbose(message: unknown, ...optionalParams: unknown[]): void {
    this.emit('verbose', message, optionalParams);
  }

  /** @inheritdoc */
  fatal(message: unknown, ...optionalParams: unknown[]): void {
    this.emit('fatal', message, optionalParams);
  }

  /**
   * Writes a fully structured entry. Used by the access log, whose fields are
   * not a message plus a context.
   *
   * @param level Nest level, decides severity and filtering.
   * @param fields Entry fields; `message` should be present.
   */
  entry(level: LogLevel, fields: Record<string, unknown>): void {
    if (!this.isEnabled(level)) {
      return;
    }
    this.writeEntry(level, fields);
  }

  /**
   * Normalises Nest's variadic signature into an entry.
   *
   * Nest passes the context as the last string argument, and for `error` a
   * stack before it. Mirrors `ConsoleLogger`'s reading of the arguments.
   */
  private emit(level: LogLevel, message: unknown, params: unknown[]): void {
    if (!this.isEnabled(level)) {
      return;
    }

    const rest = [...params];
    let context: string | undefined;
    if (rest.length > 0 && typeof rest[rest.length - 1] === 'string') {
      context = rest.pop() as string;
    }
    let stack: string | undefined;
    if ((level === 'error' || level === 'fatal') && typeof rest[0] === 'string') {
      stack = rest.shift() as string;
    }
    // `logger.error(message, stack)` without a context arrives as a single
    // trailing string that looks like a stack.
    if ((level === 'error' || level === 'fatal') && !stack && context?.includes('\n    at ')) {
      stack = context;
      context = undefined;
    }

    const fields: Record<string, unknown> = {};
    if (message instanceof Error) {
      fields['message'] = message.message;
      stack ??= message.stack;
    } else if (message !== null && typeof message === 'object' && !Array.isArray(message)) {
      const payload = message as Record<string, unknown>;
      for (const [key, value] of Object.entries(payload)) {
        if (!RESERVED_KEYS.has(key)) {
          fields[key] = value;
        }
      }
      if (typeof fields['message'] !== 'string') {
        fields['message'] = typeof payload['event'] === 'string' ? payload['event'] : JSON.stringify(payload);
      }
    } else {
      fields['message'] = typeof message === 'string' ? message : JSON.stringify(message);
    }

    if (context) {
      fields['context'] = context;
    }
    if (stack) {
      fields['stack_trace'] = stack;
    }
    if (rest.length > 0) {
      fields['params'] = rest;
    }

    this.writeEntry(level, fields);
  }

  /** Adds severity, timestamp and request fields, then writes the line. */
  private writeEntry(level: LogLevel, fields: Record<string, unknown>): void {
    const request = { ...logContextStorage.getStore(), ...this.options.context?.() };
    const entry: Record<string, unknown> = {
      severity: SEVERITY[level],
      ...fields,
      timestamp: this.now().toISOString(),
    };

    if (request.requestId) {
      entry['requestId'] ??= request.requestId;
    }
    if (request.tenantId) {
      entry['tenantId'] ??= request.tenantId;
    }
    if (request.traceId) {
      if (this.options.projectId) {
        entry['logging.googleapis.com/trace'] =
          `projects/${this.options.projectId}/traces/${request.traceId}`;
      } else {
        entry['traceId'] = request.traceId;
      }
      if (request.spanId) {
        entry['logging.googleapis.com/spanId'] = request.spanId;
      }
      if (request.traceSampled !== undefined) {
        entry['logging.googleapis.com/trace_sampled'] = request.traceSampled;
      }
    }

    let line: string;
    try {
      line = JSON.stringify(entry);
    } catch {
      line = JSON.stringify({
        severity: entry['severity'],
        message: '[UNSERIALISABLE LOG ENTRY]',
        timestamp: entry['timestamp'],
      });
    }
    this.write(line);
  }
}
