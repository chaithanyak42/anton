/**
 * Mem0 HTTP Client for Anton
 * Simple TypeScript client for the Mem0 Platform API.
 * Handles: add memories, search memories, fetch user profiles.
 */

import { logger } from './logger.js';

const MEM0_API_HOST = 'https://api.mem0.ai';

export interface Mem0Memory {
  id: string;
  memory: string;
  user_id?: string;
  agent_id?: string;
  created_at?: string;
  updated_at?: string;
  metadata?: Record<string, unknown>;
}

export interface Mem0SearchResult {
  id: string;
  memory: string;
  score?: number;
  user_id?: string;
  created_at?: string;
  updated_at?: string;
  metadata?: Record<string, unknown>;
}

export interface Mem0Message {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export class Mem0Client {
  private apiKey: string;
  private headers: Record<string, string>;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
    this.headers = {
      'Authorization': `Token ${apiKey}`,
      'Content-Type': 'application/json',
    };
  }

  /**
   * Add memories from a conversation.
   * Mem0 automatically extracts and stores relevant facts.
   * Also triggers async profile generation/update.
   */
  async add(
    messages: Mem0Message[],
    userId: string,
    metadata?: Record<string, unknown>,
    customInstructions?: string,
  ): Promise<void> {
    try {
      const body: Record<string, unknown> = {
        messages,
        user_id: userId,
      };
      if (metadata) body.metadata = metadata;
      if (customInstructions) body.custom_instructions = customInstructions;

      const resp = await fetch(`${MEM0_API_HOST}/v1/memories/`, {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify(body),
      });

      if (!resp.ok) {
        const text = await resp.text();
        logger.error({ status: resp.status, body: text }, 'Mem0 add failed');
        return;
      }

      logger.debug({ userId, messageCount: messages.length }, 'Mem0 memories added');
    } catch (err) {
      logger.error({ err, userId }, 'Mem0 add error');
    }
  }

  /**
   * Search memories relevant to a query for a specific user.
   * Returns the most relevant memories ranked by similarity.
   */
  async search(
    query: string,
    userId: string,
    limit: number = 10,
  ): Promise<Mem0SearchResult[]> {
    try {
      const resp = await fetch(`${MEM0_API_HOST}/v2/memories/search/`, {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify({
          query,
          filters: { user_id: userId },
          limit,
        }),
      });

      if (!resp.ok) {
        const text = await resp.text();
        logger.error({ status: resp.status, body: text }, 'Mem0 search failed');
        return [];
      }

      const results = await resp.json() as Mem0SearchResult[];
      logger.debug({ userId, query: query.slice(0, 100), resultCount: results.length }, 'Mem0 search done');
      return results;
    } catch (err) {
      logger.error({ err, userId }, 'Mem0 search error');
      return [];
    }
  }

  /**
   * Fetch the auto-generated user profile.
   * Returns structured JSON matching the configured profile schema.
   * Returns null if no profile exists yet.
   */
  async getProfile(userId: string): Promise<Record<string, unknown> | null> {
    try {
      const resp = await fetch(
        `${MEM0_API_HOST}/v1/entities/user/${encodeURIComponent(userId)}/profile/`,
        {
          method: 'GET',
          headers: { 'Authorization': `Token ${this.apiKey}` },
        },
      );

      if (!resp.ok) {
        if (resp.status === 404) {
          logger.debug({ userId }, 'No Mem0 profile found');
          return null;
        }
        const text = await resp.text();
        logger.error({ status: resp.status, body: text }, 'Mem0 getProfile failed');
        return null;
      }

      const profile = await resp.json() as Record<string, unknown>;
      logger.debug({ userId }, 'Mem0 profile fetched');
      return profile;
    } catch (err) {
      logger.error({ err, userId }, 'Mem0 getProfile error');
      return null;
    }
  }

  /**
   * Fetch all memories for a specific user.
   * Returns every stored memory (no search ranking).
   */
  async getAll(userId: string): Promise<Mem0Memory[]> {
    try {
      const resp = await fetch(
        `${MEM0_API_HOST}/v1/memories/?user_id=${encodeURIComponent(userId)}`,
        {
          method: 'GET',
          headers: { 'Authorization': `Token ${this.apiKey}` },
        },
      );

      if (!resp.ok) {
        const text = await resp.text();
        logger.error({ status: resp.status, body: text }, 'Mem0 getAll failed');
        return [];
      }

      const results = await resp.json() as Mem0Memory[];
      logger.debug({ userId, count: results.length }, 'Mem0 getAll done');
      return results;
    } catch (err) {
      logger.error({ err, userId }, 'Mem0 getAll error');
      return [];
    }
  }

  /**
   * Fetch context for a sender — the modular retrieval layer.
   * Currently: profile + search. Later: upgraded to deep retrieval agent.
   */
  async fetchContext(
    senderUserId: string,
    message: string,
  ): Promise<{ profile: Record<string, unknown> | null; memories: Mem0SearchResult[] }> {
    // Run profile fetch and memory search in parallel
    const [profile, memories] = await Promise.all([
      this.getProfile(senderUserId),
      this.search(message, senderUserId),
    ]);

    return { profile, memories };
  }
}
