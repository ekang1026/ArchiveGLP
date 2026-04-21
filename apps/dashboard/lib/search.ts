import type { ArchivedMessage } from '@archiveglp/schema';

export interface SearchArgs {
  q?: string | undefined;
  employee?: string | undefined;
}

/**
 * Stub. Real implementation queries the metadata Postgres replica (read-only
 * role) and, optionally, OpenSearch for full-text. Wiring the connection pool
 * and the supervisor audit-log write is in the next slice.
 */
export async function searchMessages(_args: SearchArgs): Promise<ArchivedMessage[]> {
  return [];
}
