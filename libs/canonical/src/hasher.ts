import * as crypto from 'crypto';

export function canonicalizeJson(obj: unknown): string {
  if (obj === null || typeof obj !== 'object') {
    return JSON.stringify(obj);
  }

  if (Array.isArray(obj)) {
    return '[' + obj.map((item) => canonicalizeJson(item)).join(',') + ']';
  }

  const sortedKeys = Object.keys(obj as Record<string, unknown>).sort();
  const parts: string[] = [];

  for (const key of sortedKeys) {
    const val = (obj as Record<string, unknown>)[key];
    if (val !== undefined) {
      parts.push(JSON.stringify(key) + ':' + canonicalizeJson(val));
    }
  }

  return '{' + parts.join(',') + '}';
}

/**
 * Computes a deterministic SHA-256 hash of core canonical business fields.
 */
export function computeCanonicalHash(data: Record<string, unknown>): string {
  const serialized = canonicalizeJson(data);
  return crypto.createHash('sha256').update(serialized).digest('hex');
}