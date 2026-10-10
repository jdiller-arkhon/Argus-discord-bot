import { z } from 'zod';

export class ConfigError extends Error {
  override name = 'ConfigError';
}

/**
 * Parses environment variables against a zod schema and throws one readable
 * error listing every invalid or missing variable.
 */
export function loadEnv<T extends z.ZodTypeAny>(
  schema: T,
  source: Record<string, string | undefined> = process.env,
): z.infer<T> {
  // Treat empty strings as unset so `FOO=` in .env falls back to defaults.
  const cleaned: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && value.trim() !== '') cleaned[key] = value.trim();
  }
  const result = schema.safeParse(cleaned);
  if (!result.success) {
    const lines = result.error.issues.map((issue) => {
      const path = issue.path.join('.') || '(root)';
      return `  - ${path}: ${issue.message}`;
    });
    throw new ConfigError(`Invalid environment configuration:\n${lines.join('\n')}`);
  }
  return result.data;
}

/** `"a, b,c"` -> `["a","b","c"]` */
export const csvList = z
  .string()
  .transform((value) =>
    value
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part.length > 0),
  );

/** `HH:mm` 24-hour local time. */
export const localTime = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'expected HH:mm (24-hour)');

export const booleanFlag = z
  .enum(['true', 'false', '1', '0', 'yes', 'no'])
  .transform((value) => value === 'true' || value === '1' || value === 'yes');

/** Discord snowflake ID. */
export const snowflake = z.string().regex(/^\d{17,20}$/, 'expected a Discord ID (17-20 digits)');
