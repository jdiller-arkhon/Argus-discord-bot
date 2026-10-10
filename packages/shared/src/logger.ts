export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

function serializeError(value: unknown): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  return value;
}

/** Structured JSON-lines logger written to stdout/stderr. */
export function createLogger(
  name: string,
  level: LogLevel = (process.env.LOG_LEVEL as LogLevel | undefined) ?? 'info',
  baseFields: Record<string, unknown> = {},
): Logger {
  const threshold = LEVEL_ORDER[level] ?? LEVEL_ORDER.info;

  const write = (lvl: LogLevel, message: string, fields?: Record<string, unknown>) => {
    if (LEVEL_ORDER[lvl] < threshold) return;
    const entry: Record<string, unknown> = {
      time: new Date().toISOString(),
      level: lvl,
      bot: name,
      msg: message,
      ...baseFields,
    };
    for (const [key, value] of Object.entries(fields ?? {})) {
      entry[key] = serializeError(value);
    }
    const line = JSON.stringify(entry);
    if (lvl === 'error' || lvl === 'warn') process.stderr.write(`${line}\n`);
    else process.stdout.write(`${line}\n`);
  };

  return {
    debug: (m, f) => write('debug', m, f),
    info: (m, f) => write('info', m, f),
    warn: (m, f) => write('warn', m, f),
    error: (m, f) => write('error', m, f),
    child: (fields) => createLogger(name, level, { ...baseFields, ...fields }),
  };
}

/** Logger that discards everything; handy in tests. */
export const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silentLogger,
};
