import { Bot, Context } from 'grammy';
import { hydrateFiles, FileFlavor } from '@grammyjs/files';

import { logger } from '../logger.js';
import { Channel, OnInboundMessage, OnChatMetadata, RegisteredGroup } from '../types.js';

type MyContext = FileFlavor<Context>;

export interface TelegramChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  botToken: string;
}

/**
 * Telegram Channel for Anton.
 * Uses grammY (long polling) to receive and send messages.
 * JID format: "tg:{chat_id}" for all chats (groups and DMs).
 */
export class TelegramChannel implements Channel {
  name = 'telegram';

  private bot: Bot<MyContext>;
  private connected = false;
  private opts: TelegramChannelOpts;

  constructor(opts: TelegramChannelOpts) {
    this.opts = opts;
    this.bot = new Bot<MyContext>(opts.botToken);
    this.bot.api.config.use(hydrateFiles(opts.botToken));
  }

  async connect(): Promise<void> {
    // Handle text messages
    this.bot.on('message:text', async (ctx) => {
      await this.handleMessage(ctx, ctx.message.text);
    });

    // Handle photo messages — extract caption, download later for vision
    this.bot.on('message:photo', async (ctx) => {
      const caption = ctx.message.caption || '[Photo]';
      // TODO: Download photo and extract description via vision model
      // For now, pass caption as content
      await this.handleMessage(ctx, caption);
    });

    // Handle document/file messages
    this.bot.on('message:document', async (ctx) => {
      const caption = ctx.message.caption || `[Document: ${ctx.message.document.file_name || 'unnamed'}]`;
      await this.handleMessage(ctx, caption);
    });

    // Handle voice messages
    this.bot.on('message:voice', async (ctx) => {
      await this.handleMessage(ctx, '[Voice message]');
    });

    // Handle stickers
    this.bot.on('message:sticker', async (ctx) => {
      const emoji = ctx.message.sticker.emoji || '';
      await this.handleMessage(ctx, `[Sticker ${emoji}]`);
    });

    // Error handler
    this.bot.catch((err) => {
      logger.error({ err: err.error }, 'Telegram bot error');
    });

    // Start long polling (non-blocking)
    this.bot.start({
      onStart: () => {
        this.connected = true;
        logger.info('Connected to Telegram');
      },
    });

    // Wait briefly for connection to establish
    await new Promise<void>((resolve) => {
      const check = () => {
        if (this.connected) {
          resolve();
        } else {
          setTimeout(check, 100);
        }
      };
      setTimeout(check, 100);
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const chatId = this.jidToChatId(jid);
    if (!chatId) {
      logger.warn({ jid }, 'Cannot send: invalid Telegram JID');
      return;
    }

    // Telegram bot IS the identity — send text as-is, no name prefix
    const message = text;

    try {
      // Telegram has a 4096 character limit per message — split if needed
      const MAX_LEN = 4096;
      if (message.length <= MAX_LEN) {
        await this.bot.api.sendMessage(chatId, message);
      } else {
        // Split on newlines or at max length
        let remaining = message;
        while (remaining.length > 0) {
          const chunk = remaining.slice(0, MAX_LEN);
          remaining = remaining.slice(MAX_LEN);
          await this.bot.api.sendMessage(chatId, chunk);
        }
      }
      logger.info({ jid, length: message.length }, 'Telegram message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Telegram message');
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('tg:');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    await this.bot.stop();
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!isTyping) return; // Telegram only supports "typing" action, no "stopped typing"
    const chatId = this.jidToChatId(jid);
    if (!chatId) return;

    try {
      await this.bot.api.sendChatAction(chatId, 'typing');
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send typing indicator');
    }
  }

  // --- Private helpers ---

  private async handleMessage(ctx: Context, content: string): Promise<void> {
    if (!content) return;

    const chatId = ctx.chat?.id;
    const from = ctx.from;
    if (!chatId || !from) return;

    const jid = `tg:${chatId}`;
    const timestamp = new Date((ctx.message?.date || Math.floor(Date.now() / 1000)) * 1000).toISOString();
    const isGroup = ctx.chat?.type === 'group' || ctx.chat?.type === 'supergroup';
    const chatName = isGroup
      ? (ctx.chat as { title?: string }).title || `Group ${chatId}`
      : `${from.first_name || ''} ${from.last_name || ''}`.trim() || `User ${from.id}`;

    const senderName = `${from.first_name || ''} ${from.last_name || ''}`.trim() || `User ${from.id}`;
    const sender = `tg:${from.id}`;

    const fromMe = from.is_bot && from.id === this.bot.botInfo?.id;
    const isBotMessage = fromMe;

    // Always report chat metadata for discovery
    this.opts.onChatMetadata(jid, timestamp, chatName, 'telegram', isGroup);

    // Deliver all messages — auto-registration in onMessage handles DMs
    const messageId = ctx.message?.message_id?.toString() || `${Date.now()}`;

    this.opts.onMessage(jid, {
      id: messageId,
      chat_jid: jid,
      sender,
      sender_name: senderName,
      content,
      timestamp,
      is_from_me: fromMe,
      is_bot_message: isBotMessage,
    });
  }

  private jidToChatId(jid: string): number | null {
    const match = jid.match(/^tg:(-?\d+)$/);
    return match ? parseInt(match[1], 10) : null;
  }
}
