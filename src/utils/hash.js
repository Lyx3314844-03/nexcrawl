import { createHash } from 'node:crypto';

export function hashText(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}
