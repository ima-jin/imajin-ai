import { db, identities, challenges, tokens } from '@/src/db';
import { inArray } from 'drizzle-orm';

/**
 * Tracks records created during a test and deletes them on cleanup.
 * Foreign-key order: tokens → challenges → identities.
 */
export class TestDb {
  private trackedIdentities: string[] = [];
  private trackedChallenges: string[] = [];
  private trackedTokens: string[] = [];

  trackIdentity(id: string): void {
    this.trackedIdentities.push(id);
  }

  trackChallenge(id: string): void {
    this.trackedChallenges.push(id);
  }

  trackToken(id: string): void {
    this.trackedTokens.push(id);
  }

  async cleanup(): Promise<void> {
    if (this.trackedTokens.length) {
      await db.delete(tokens).where(inArray(tokens.id, this.trackedTokens));
    }
    if (this.trackedChallenges.length) {
      await db.delete(challenges).where(inArray(challenges.id, this.trackedChallenges));
    }
    if (this.trackedIdentities.length) {
      await db.delete(identities).where(inArray(identities.id, this.trackedIdentities));
    }
    this.trackedIdentities = [];
    this.trackedChallenges = [];
    this.trackedTokens = [];
  }
}

/** Convenience factory — one instance per describe block. */
export function createTestDb(): TestDb {
  return new TestDb();
}
