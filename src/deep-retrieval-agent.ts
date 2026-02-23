/**
 * Deep Retrieval Agent
 *
 * A fully agentic memory retrieval system that uses Claude with tools
 * to intelligently gather context before Anton responds.
 *
 * Instead of a simple vector search, this agent:
 *   1. Analyzes the incoming message to understand what context is needed
 *   2. Fetches the sender's profile
 *   3. Runs multiple targeted memory searches (multi-hop)
 *   4. Pulls recent conversation history for continuity
 *   5. Synthesizes everything into a structured context package
 */

import { ANTHROPIC_API_KEY } from './config.js';
import { Mem0Client, Mem0SearchResult } from './mem0-client.js';
import { getRecentMessages } from './db.js';
import { logger } from './logger.js';
import { NewMessage } from './types.js';

// --- Types ---

export interface RetrievalContext {
  profile: Record<string, unknown> | null;
  memories: string[];
  recentConversation: string | null;
  keyContext: string | null;
}

interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | ContentBlock[];
}

interface ContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string;
}

// --- Tool Definitions ---

const TOOLS: ToolDefinition[] = [
  {
    name: 'search_memories',
    description:
      'Search Mem0 memories for a specific user. Returns relevant memories ranked by similarity. ' +
      'Use targeted, specific queries for best results. You can call this multiple times with different queries ' +
      'to find different types of context (e.g., search for topics, people, events, emotions separately).',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'A specific search query. Be targeted — "hiking trip in March" is better than "things we did".',
        },
        user_id: {
          type: 'string',
          description: 'The user ID to search memories for.',
        },
      },
      required: ['query', 'user_id'],
    },
  },
  {
    name: 'get_profile',
    description:
      'Get the structured profile for a user. Contains relationship info, interests, communication style, ' +
      'personal details, and other structured information. Always call this first to understand who you\'re gathering context for.',
    input_schema: {
      type: 'object',
      properties: {
        user_id: {
          type: 'string',
          description: 'The user ID to fetch the profile for.',
        },
      },
      required: ['user_id'],
    },
  },
  {
    name: 'get_all_memories',
    description:
      'Get ALL stored memories for a user. Unlike search_memories which returns ranked results for a query, ' +
      'this returns every memory stored for the user. Useful to get a complete picture of what we know about someone.',
    input_schema: {
      type: 'object',
      properties: {
        user_id: {
          type: 'string',
          description: 'The user ID to fetch all memories for.',
        },
      },
      required: ['user_id'],
    },
  },
  {
    name: 'get_recent_messages',
    description:
      'Get recent raw messages from a conversation. Useful for understanding the current conversational flow, ' +
      'what was discussed recently, and maintaining continuity. Returns messages in chronological order.',
    input_schema: {
      type: 'object',
      properties: {
        chat_jid: {
          type: 'string',
          description: 'The chat JID (conversation identifier).',
        },
        limit: {
          type: 'number',
          description: 'Number of recent messages to fetch. Default 20, max 50.',
        },
      },
      required: ['chat_jid'],
    },
  },
];

// --- System Prompt ---

const RETRIEVAL_SYSTEM_PROMPT = `You are a deep memory retrieval agent. Your job is to gather all relevant context about a person and their conversation history so that Anton (Chaithanya's AI digital twin) can respond naturally and personally.

You have four tools: search_memories, get_all_memories, get_profile, and get_recent_messages.

## Your Process

1. ALWAYS start by fetching the sender's profile with get_profile AND all their memories with get_all_memories
2. Read the incoming message carefully — what is the person talking about? What context would Chaithanya need?
3. If needed, search for memories relevant to specific topics
4. If the message references past events ("remember when...", "that thing", "last time"), do targeted searches to find that context
5. If search results mention other topics, people, or events that seem relevant, do follow-up searches
6. Get recent messages for conversational continuity
7. When you have enough context, return your findings

## Search Strategy

- Be specific with queries: "marathon training" not "running"
- Search for different angles: topic, people mentioned, emotions, time references
- If a memory mentions something interesting, search deeper on that
- Don't over-search — 3-5 searches is usually enough
- Profile + 2-3 memory searches + recent messages is a good baseline

## Output Format

When you have enough context, respond with ONLY a JSON object (no markdown, no code blocks):

{
  "profile_summary": "Brief summary of who this person is and their relationship with Chaithanya",
  "relevant_memories": ["memory 1", "memory 2", ...],
  "recent_conversation_summary": "Brief summary of what they've been discussing recently, or null if no recent messages",
  "key_context": "Any critical context Anton should know for this specific message — upcoming events, emotional state, things to reference or avoid"
}`;

// --- Tool Executor ---

async function executeTool(
  toolName: string,
  input: Record<string, unknown>,
  mem0: Mem0Client,
): Promise<string> {
  switch (toolName) {
    case 'search_memories': {
      const query = input.query as string;
      const userId = input.user_id as string;
      const results = await mem0.search(query, userId, 10);
      if (results.length === 0) {
        return JSON.stringify({ results: [], message: 'No memories found for this query.' });
      }
      return JSON.stringify({
        results: results.map((r: Mem0SearchResult) => ({
          memory: r.memory,
          score: r.score,
          created_at: r.created_at,
          updated_at: r.updated_at,
        })),
      });
    }

    case 'get_profile': {
      const userId = input.user_id as string;
      const profile = await mem0.getProfile(userId);
      if (!profile) {
        return JSON.stringify({ profile: null, message: 'No profile found for this user yet.' });
      }
      return JSON.stringify({ profile });
    }

    case 'get_all_memories': {
      const userId = input.user_id as string;
      const memories = await mem0.getAll(userId);
      if (memories.length === 0) {
        return JSON.stringify({ memories: [], message: 'No memories stored for this user.' });
      }
      return JSON.stringify({
        memories: memories.map((m) => ({
          memory: m.memory,
          created_at: m.created_at,
          updated_at: m.updated_at,
        })),
      });
    }

    case 'get_recent_messages': {
      const chatJid = input.chat_jid as string;
      const limit = Math.min((input.limit as number) || 20, 50);
      const messages = getRecentMessages(chatJid, limit);
      if (messages.length === 0) {
        return JSON.stringify({ messages: [], message: 'No recent messages found.' });
      }
      return JSON.stringify({
        messages: messages.map((m: NewMessage) => ({
          sender: m.sender_name,
          content: m.content,
          timestamp: m.timestamp,
          is_from_me: m.is_from_me,
        })),
      });
    }

    default:
      return JSON.stringify({ error: `Unknown tool: ${toolName}` });
  }
}

// --- Anthropic API Call ---

async function callAnthropic(
  messages: AnthropicMessage[],
  systemPrompt: string,
): Promise<{ content: ContentBlock[]; stop_reason: string }> {
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 4096,
      system: systemPrompt,
      tools: TOOLS,
      messages,
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Anthropic API error ${resp.status}: ${text}`);
  }

  const data = (await resp.json()) as { content: ContentBlock[]; stop_reason: string };
  return data;
}

// --- Main Agent Loop ---

/**
 * Run the deep retrieval agent to gather context for a conversation.
 *
 * This is the agentic replacement for the simple fetchContext() call.
 * It uses Claude with tools to intelligently search, reason, and gather
 * all the context Anton needs to respond naturally.
 */
export async function deepRetrieve(
  incomingMessages: NewMessage[],
  senderUserId: string,
  senderName: string,
  chatJid: string,
  mem0: Mem0Client,
): Promise<RetrievalContext> {
  const latestContent = incomingMessages.map((m) => m.content).join('\n');

  const userPrompt =
    `Incoming message from ${senderName} (user_id: ${senderUserId}, chat_jid: ${chatJid}):\n\n` +
    `"${latestContent}"\n\n` +
    `Gather all relevant context so Anton can respond to this message naturally and personally.`;

  const messages: AnthropicMessage[] = [{ role: 'user', content: userPrompt }];

  const MAX_TURNS = 10;
  let turns = 0;

  logger.info(
    { sender: senderName, senderUserId },
    'Deep retrieval agent: starting context gathering',
  );

  while (turns < MAX_TURNS) {
    turns++;

    const response = await callAnthropic(messages, RETRIEVAL_SYSTEM_PROMPT);

    // Check if the agent is done (no more tool calls)
    const toolUseBlocks = response.content.filter((b) => b.type === 'tool_use');
    const textBlocks = response.content.filter((b) => b.type === 'text');

    if (toolUseBlocks.length === 0 || response.stop_reason === 'end_turn') {
      // Agent is done — parse the final response
      const finalText = textBlocks.map((b) => b.text || '').join('');

      logger.info(
        { sender: senderName, turns },
        'Deep retrieval agent: context gathering complete',
      );

      return parseRetrievalResponse(finalText);
    }

    // Agent wants to use tools — execute them
    messages.push({ role: 'assistant', content: response.content });

    // Execute all tool calls in parallel
    const toolResults: ContentBlock[] = await Promise.all(
      toolUseBlocks.map(async (block) => {
        const toolName = block.name!;
        const toolInput = block.input as Record<string, unknown>;
        const toolUseId = block.id!;

        logger.debug(
          { tool: toolName, input: toolInput },
          'Deep retrieval agent: executing tool',
        );

        const result = await executeTool(toolName, toolInput, mem0);

        return {
          type: 'tool_result' as const,
          tool_use_id: toolUseId,
          content: result,
        };
      }),
    );

    messages.push({ role: 'user', content: toolResults });
  }

  logger.warn(
    { sender: senderName, turns },
    'Deep retrieval agent: hit max turns, returning partial context',
  );

  // If we hit max turns, return whatever we have
  return { profile: null, memories: [], recentConversation: null, keyContext: null };
}

// --- Response Parser ---

function parseRetrievalResponse(text: string): RetrievalContext {
  try {
    // Try to extract JSON from the response (agent should return pure JSON)
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      logger.warn('Deep retrieval agent: no JSON found in response, using raw text as context');
      return {
        profile: null,
        memories: [],
        recentConversation: null,
        keyContext: text,
      };
    }

    const parsed = JSON.parse(jsonMatch[0]);

    return {
      profile: parsed.profile_summary
        ? { summary: parsed.profile_summary }
        : null,
      memories: Array.isArray(parsed.relevant_memories)
        ? parsed.relevant_memories
        : [],
      recentConversation: parsed.recent_conversation_summary || null,
      keyContext: parsed.key_context || null,
    };
  } catch (err) {
    logger.error({ err, text: text.slice(0, 500) }, 'Failed to parse retrieval agent response');
    return {
      profile: null,
      memories: [],
      recentConversation: null,
      keyContext: text,
    };
  }
}
