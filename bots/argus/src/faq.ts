import { readFileSync } from 'node:fs';
import { ConfigError } from '@arkhon/shared';
import { z } from 'zod';

export const faqSchema = z.object({
  entries: z
    .array(
      z.object({
        /** Stable slug used as the `/argus help topic` choice value. */
        id: z.string().regex(/^[a-z0-9-]{1,40}$/, 'expected a lowercase slug'),
        /** Shown as the choice name, so at most 100 characters. */
        question: z.string().min(3).max(100),
        answer: z.string().min(3).max(1000),
      }),
    )
    .min(1)
    // Discord allows at most 25 choices on an option.
    .max(25)
    .refine((entries) => new Set(entries.map((entry) => entry.id)).size === entries.length, 'FAQ ids must be unique'),
});

export type Faq = z.infer<typeof faqSchema>;
export type FaqEntry = Faq['entries'][number];

export function parseFaq(raw: unknown): Faq {
  return faqSchema.parse(raw);
}

/** Reads and validates the FAQ file; a bad file stops startup with a readable error. */
export function loadFaq(path: string): Faq {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new ConfigError(`Could not read the FAQ file at ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const result = faqSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`);
    throw new ConfigError(`Invalid FAQ file at ${path}:\n${issues.join('\n')}`);
  }
  return result.data;
}
