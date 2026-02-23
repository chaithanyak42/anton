/**
 * Anton Agent — The Brain
 *
 * Core agent that uses Mem0's Deep Retrieval Agent for intelligent context
 * gathering, then generates responses via Claude with full personality matching.
 *
 * Flow:
 *   1. Extract sender identity from message
 *   2. Run deep retrieval agent (agentic multi-hop memory search)
 *   3. Build system prompt: owner personality + retrieved context
 *   4. Call Claude via Agent SDK
 *   5. Store conversation in Mem0 (auto-updates profile in background)
 *   6. Return response
 */

import fs from 'fs';
import path from 'path';

import { ANTHROPIC_API_KEY, ASSISTANT_NAME, GROUPS_DIR } from './config.js';
import { Mem0Client } from './mem0-client.js';
import { deepRetrieve, RetrievalContext } from './deep-retrieval-agent.js';
import { recordInteraction } from './dashboard.js';
import { logger } from './logger.js';
import { NewMessage } from './types.js';

// Load the owner personality prompt from groups/global/CLAUDE.md
function loadOwnerPersonality(): string {
  const personalityPath = path.join(GROUPS_DIR, 'global', 'CLAUDE.md');
  try {
    return fs.readFileSync(personalityPath, 'utf-8');
  } catch {
    logger.warn({ path: personalityPath }, 'Owner personality file not found, using default');
    return `You are ${ASSISTANT_NAME}, a personal AI assistant. Be helpful and conversational.`;
  }
}

/**
 * Build the full system prompt with owner personality and deep retrieval context.
 */
function buildSystemPrompt(
  ownerPersonality: string,
  senderName: string,
  context: RetrievalContext,
): string {
  const parts: string[] = [];

  // Owner personality — who Anton IS
  parts.push(ownerPersonality);

  // Profile — who they're talking to
  if (context.profile) {
    parts.push('\n\n## About This Contact\n');
    if (typeof context.profile === 'object' && 'summary' in context.profile) {
      parts.push(context.profile.summary as string);
    } else {
      parts.push(JSON.stringify(context.profile, null, 2));
    }
  }

  // Relevant memories from deep retrieval
  if (context.memories.length > 0) {
    parts.push('\n\n## Relevant Memories\n');
    parts.push('These are relevant memories from past interactions:');
    for (const mem of context.memories) {
      parts.push(`- ${mem}`);
    }
    parts.push('\nWeave these naturally into conversation. Don\'t list them.');
  }

  // Recent conversation for continuity
  if (context.recentConversation) {
    parts.push('\n\n## Recent Conversation Context\n');
    parts.push(context.recentConversation);
  }

  // Key context the retrieval agent identified
  if (context.keyContext) {
    parts.push('\n\n## Key Context for This Message\n');
    parts.push(context.keyContext);
  }

  return parts.join('\n');
}

/**
 * Format incoming messages into a prompt for the agent.
 */
function formatMessagesForAgent(messages: NewMessage[]): string {
  const lines = messages.map((m) => {
    const prefix = m.is_from_me ? ASSISTANT_NAME : m.sender_name;
    return `[${prefix}] (${m.timestamp}): ${m.content}`;
  });
  return lines.join('\n');
}

export interface AntonAgentResult {
  status: 'success' | 'error';
  response: string | null;
  error?: string;
}

/**
 * Run the Anton agent for a set of messages.
 *
 * This is the main entry point that replaces runContainerAgent().
 * It runs the deep retrieval agent for context, calls Claude, stores the conversation, and returns.
 */
export async function runAntonAgent(
  messages: NewMessage[],
  mem0: Mem0Client,
  onOutput?: (text: string) => Promise<void>,
): Promise<AntonAgentResult> {
  if (messages.length === 0) {
    return { status: 'success', response: null };
  }

  // Identify the sender (use the most recent non-bot message sender)
  const senderMessage = [...messages].reverse().find((m) => !m.is_bot_message && !m.is_from_me);
  const senderJid = senderMessage?.sender || messages[0].sender;
  const senderName = senderMessage?.sender_name || messages[0].sender_name;
  const chatJid = messages[0].chat_jid;

  // Use sender JID as the Mem0 user_id (unique per contact across platforms)
  const senderUserId = senderJid;

  logger.info(
    { sender: senderName, senderUserId, messageCount: messages.length },
    'Anton agent: processing messages',
  );

  try {
    // Step 1: Run deep retrieval agent (agentic context gathering)
    const retrievalStart = Date.now();
    const context = await deepRetrieve(messages, senderUserId, senderName, chatJid, mem0);
    const retrievalTimeMs = Date.now() - retrievalStart;

    logger.info(
      {
        sender: senderName,
        hasProfile: !!context.profile,
        memoryCount: context.memories.length,
        hasRecentConvo: !!context.recentConversation,
        hasKeyContext: !!context.keyContext,
        retrievalTimeMs,
      },
      'Anton agent: deep retrieval complete',
    );

    // Step 2: Build system prompt
    const ownerPersonality = loadOwnerPersonality();
    const systemPrompt = buildSystemPrompt(ownerPersonality, senderName, context);

    // Step 3: Format the conversation for Claude
    const userPrompt = formatMessagesForAgent(messages);

    // Step 4: Call Claude via direct Anthropic API
    const responseStart = Date.now();
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4096,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      }),
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Anthropic API error ${resp.status}: ${text}`);
    }

    const data = (await resp.json()) as { content: Array<{ type: string; text?: string }> };
    let fullResponse = '';
    for (const block of data.content) {
      if (block.type === 'text' && block.text) {
        fullResponse += block.text;
      }
    }

    const responseTimeMs = Date.now() - responseStart;

    if (!fullResponse) {
      logger.warn({ sender: senderName }, 'Anton agent: empty response from Claude');
      return { status: 'error', response: null, error: 'Empty response from Claude' };
    }

    // Step 5: Send output if callback provided
    if (onOutput) {
      await onOutput(fullResponse);
    }

    // Record interaction for dashboard live feed
    const latestContent = messages
      .filter((m) => !m.is_bot_message && !m.is_from_me)
      .map((m) => m.content)
      .join('\n');

    recordInteraction({
      timestamp: new Date().toISOString(),
      senderName,
      senderJid,
      chatJid,
      incomingMessage: latestContent,
      response: fullResponse,
      retrievalTimeMs,
      responseTimeMs,
      memoryCount: context.memories.length,
      hasProfile: !!context.profile,
    });

    // Step 6: Store conversation in Mem0 (async, don't block response)
    const mem0Messages: { role: 'user' | 'assistant'; content: string }[] = messages
      .filter((m) => !m.is_bot_message)
      .map((m) => ({
        role: 'user' as const,
        content: `${m.sender_name}: ${m.content}`,
      }));
    mem0Messages.push({
      role: 'assistant',
      content: fullResponse,
    });

    // Custom instructions for relationship-aware memory extraction
    const customInstructions =
      'You are extracting memories from a conversation between Chaithanya and one of his contacts. ' +
      'Focus on: personal facts about the contact (interests, life events, preferences, work), ' +
      'relationship dynamics (how they interact, shared history, inside jokes), ' +
      'commitments and plans (things promised, upcoming meetups, deadlines), ' +
      'emotional context (what they\'re going through, their mood patterns), ' +
      'and preferences (communication style, topics they enjoy). ' +
      'Always attribute memories to the contact, not to Chaithanya. ' +
      'Extract specific, actionable facts — not vague summaries.';

    // Fire and forget — don't block the response
    mem0.add(mem0Messages, senderUserId, {
      channel: chatJid.startsWith('tg:') ? 'telegram' : 'whatsapp',
      chat_jid: chatJid,
    }, customInstructions).catch((err) => {
      logger.error({ err, senderUserId }, 'Failed to store conversation in Mem0');
    });

    logger.info(
      { sender: senderName, responseLength: fullResponse.length },
      'Anton agent: response generated',
    );

    return { status: 'success', response: fullResponse };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    logger.error({ err, sender: senderName }, 'Anton agent error');
    return { status: 'error', response: null, error: errorMessage };
  }
}
