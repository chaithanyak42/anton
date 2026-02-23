/**
 * Anton Dashboard Server
 *
 * Lightweight Express-like HTTP server (using Node's built-in http module).
 * Serves a web dashboard showing:
 *   - Live feed of Anton's interactions
 *   - Contact cards with Mem0 memories
 *   - Conversation history
 *   - Stats overview
 *
 * Runs alongside the WhatsApp bot in the same process, sharing the SQLite DB.
 */

import http from 'http';
import { URL } from 'url';

import { Mem0Client } from './mem0-client.js';
import { logger } from './logger.js';
import {
  getAllChats,
  getRecentMessages,
  ChatInfo,
} from './db.js';
import { NewMessage } from './types.js';

const DASHBOARD_PORT = 3420;

// --- Event Stream for Live Feed ---

interface InteractionEvent {
  timestamp: string;
  senderName: string;
  senderJid: string;
  chatJid: string;
  incomingMessage: string;
  response: string;
  retrievalTimeMs: number;
  responseTimeMs: number;
  memoryCount: number;
  hasProfile: boolean;
}

const recentInteractions: InteractionEvent[] = [];
const MAX_INTERACTIONS = 100;
const sseClients: Set<http.ServerResponse> = new Set();

/**
 * Record an interaction for the live feed.
 * Called from anton-agent.ts after each response.
 */
export function recordInteraction(event: InteractionEvent): void {
  recentInteractions.unshift(event);
  if (recentInteractions.length > MAX_INTERACTIONS) {
    recentInteractions.pop();
  }

  // Push to all SSE clients
  const data = JSON.stringify(event);
  for (const client of sseClients) {
    client.write(`data: ${data}\n\n`);
  }
}

// --- API Handlers ---

function jsonResponse(res: http.ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify(data));
}

async function handleApiContacts(mem0: Mem0Client, res: http.ServerResponse): Promise<void> {
  const chats = getAllChats().filter(
    (c: ChatInfo) => c.jid !== '__group_sync__' && !c.is_group,
  );

  const contacts = chats.map((c: ChatInfo) => ({
    jid: c.jid,
    name: c.name,
    lastActive: c.last_message_time,
    channel: c.channel || 'whatsapp',
  }));

  jsonResponse(res, contacts);
}

async function handleApiContactMemories(
  mem0: Mem0Client,
  userId: string,
  res: http.ServerResponse,
): Promise<void> {
  try {
    const [memories, profile] = await Promise.all([
      mem0.getAll(userId),
      mem0.getProfile(userId),
    ]);

    jsonResponse(res, {
      userId,
      profile,
      memories: memories.map((m) => ({
        id: m.id,
        memory: m.memory,
        created_at: m.created_at,
        updated_at: m.updated_at,
      })),
    });
  } catch (err) {
    jsonResponse(res, { error: 'Failed to fetch memories' }, 500);
  }
}

async function handleApiConversation(chatJid: string, res: http.ServerResponse): Promise<void> {
  const messages = getRecentMessages(chatJid, 50);
  jsonResponse(
    res,
    messages.map((m: NewMessage) => ({
      sender: m.sender_name,
      content: m.content,
      timestamp: m.timestamp,
      isFromMe: m.is_from_me,
    })),
  );
}

function handleApiInteractions(res: http.ServerResponse): void {
  jsonResponse(res, recentInteractions);
}

function handleApiStats(res: http.ServerResponse): void {
  const chats = getAllChats().filter(
    (c: ChatInfo) => c.jid !== '__group_sync__',
  );
  const dmCount = chats.filter((c) => !c.is_group).length;
  const groupCount = chats.filter((c) => c.is_group).length;

  jsonResponse(res, {
    totalContacts: dmCount,
    totalGroups: groupCount,
    totalInteractions: recentInteractions.length,
    avgResponseTimeMs:
      recentInteractions.length > 0
        ? Math.round(
            recentInteractions.reduce((s, i) => s + i.responseTimeMs, 0) /
              recentInteractions.length,
          )
        : 0,
    avgRetrievalTimeMs:
      recentInteractions.length > 0
        ? Math.round(
            recentInteractions.reduce((s, i) => s + i.retrievalTimeMs, 0) /
              recentInteractions.length,
          )
        : 0,
  });
}

function handleSSE(res: http.ServerResponse): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });
  res.write('\n');
  sseClients.add(res);
  res.on('close', () => sseClients.delete(res));
}

// --- Dashboard HTML ---

function serveDashboard(res: http.ServerResponse): void {
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(DASHBOARD_HTML);
}

// --- HTTP Server ---

export function startDashboard(mem0: Mem0Client): void {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host}`);
    const pathname = url.pathname;

    try {
      // API routes
      if (pathname === '/api/contacts') {
        await handleApiContacts(mem0, res);
      } else if (pathname.startsWith('/api/contacts/') && pathname.endsWith('/memories')) {
        const userId = decodeURIComponent(pathname.split('/')[3]);
        await handleApiContactMemories(mem0, userId, res);
      } else if (pathname.startsWith('/api/conversation/')) {
        const chatJid = decodeURIComponent(pathname.split('/').slice(3).join('/'));
        await handleApiConversation(chatJid, res);
      } else if (pathname === '/api/interactions') {
        handleApiInteractions(res);
      } else if (pathname === '/api/stats') {
        handleApiStats(res);
      } else if (pathname === '/api/events') {
        handleSSE(res);
      } else {
        // Serve dashboard
        serveDashboard(res);
      }
    } catch (err) {
      logger.error({ err, pathname }, 'Dashboard request error');
      jsonResponse(res, { error: 'Internal server error' }, 500);
    }
  });

  server.listen(DASHBOARD_PORT, () => {
    logger.info({ port: DASHBOARD_PORT }, 'Dashboard server started');
  });
}

// --- Inline HTML/CSS/JS ---

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Anton Dashboard</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }

    :root {
      --bg: #0a0a0a;
      --surface: #141414;
      --surface-2: #1e1e1e;
      --border: #2a2a2a;
      --text: #e5e5e5;
      --text-dim: #888;
      --accent: #3b82f6;
      --accent-dim: #1e3a5f;
      --green: #22c55e;
      --green-dim: #14532d;
      --orange: #f59e0b;
      --purple: #a855f7;
    }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: var(--bg);
      color: var(--text);
      line-height: 1.5;
    }

    /* --- Layout --- */
    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 16px 24px;
      border-bottom: 1px solid var(--border);
      background: var(--surface);
    }

    .header h1 {
      font-size: 20px;
      font-weight: 600;
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .header .status {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 13px;
      color: var(--green);
    }

    .header .status .dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--green);
      animation: pulse 2s infinite;
    }

    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.4; }
    }

    .nav {
      display: flex;
      gap: 4px;
      padding: 8px 24px;
      background: var(--surface);
      border-bottom: 1px solid var(--border);
    }

    .nav button {
      padding: 8px 16px;
      background: transparent;
      border: none;
      color: var(--text-dim);
      font-size: 14px;
      cursor: pointer;
      border-radius: 6px;
      transition: all 0.2s;
    }

    .nav button:hover {
      background: var(--surface-2);
      color: var(--text);
    }

    .nav button.active {
      background: var(--accent-dim);
      color: var(--accent);
    }

    .main {
      max-width: 1200px;
      margin: 0 auto;
      padding: 24px;
    }

    .page { display: none; }
    .page.active { display: block; }

    /* --- Stats Cards --- */
    .stats-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 16px;
      margin-bottom: 24px;
    }

    .stat-card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 20px;
    }

    .stat-card .label {
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--text-dim);
      margin-bottom: 4px;
    }

    .stat-card .value {
      font-size: 28px;
      font-weight: 700;
    }

    .stat-card .unit {
      font-size: 14px;
      color: var(--text-dim);
      font-weight: 400;
    }

    /* --- Live Feed --- */
    .feed-item {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 16px 20px;
      margin-bottom: 12px;
      animation: fadeIn 0.3s ease;
    }

    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(-8px); }
      to { opacity: 1; transform: translateY(0); }
    }

    .feed-item .feed-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 12px;
    }

    .feed-item .sender {
      font-weight: 600;
      font-size: 15px;
    }

    .feed-item .time {
      font-size: 12px;
      color: var(--text-dim);
    }

    .feed-item .message-pair {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
    }

    .feed-item .msg-box {
      padding: 12px;
      border-radius: 8px;
      font-size: 14px;
      line-height: 1.5;
    }

    .feed-item .msg-incoming {
      background: var(--surface-2);
      border-left: 3px solid var(--accent);
    }

    .feed-item .msg-outgoing {
      background: var(--surface-2);
      border-left: 3px solid var(--green);
    }

    .feed-item .msg-label {
      font-size: 11px;
      text-transform: uppercase;
      color: var(--text-dim);
      margin-bottom: 4px;
      letter-spacing: 0.5px;
    }

    .feed-item .feed-meta {
      display: flex;
      gap: 16px;
      margin-top: 12px;
      font-size: 12px;
      color: var(--text-dim);
    }

    .feed-item .feed-meta span {
      display: flex;
      align-items: center;
      gap: 4px;
    }

    /* --- Contacts --- */
    .contacts-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
      gap: 16px;
    }

    .contact-card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 20px;
      cursor: pointer;
      transition: border-color 0.2s;
    }

    .contact-card:hover {
      border-color: var(--accent);
    }

    .contact-card .contact-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 12px;
    }

    .contact-card .contact-name {
      font-weight: 600;
      font-size: 16px;
    }

    .contact-card .contact-channel {
      font-size: 11px;
      padding: 2px 8px;
      border-radius: 10px;
      background: var(--accent-dim);
      color: var(--accent);
    }

    .contact-card .contact-last-active {
      font-size: 12px;
      color: var(--text-dim);
      margin-bottom: 12px;
    }

    .contact-card .memories-list {
      list-style: none;
    }

    .contact-card .memories-list li {
      font-size: 13px;
      color: var(--text-dim);
      padding: 4px 0;
      border-bottom: 1px solid var(--border);
    }

    .contact-card .memories-list li:last-child {
      border-bottom: none;
    }

    .contact-card .memory-count {
      font-size: 12px;
      color: var(--text-dim);
      margin-top: 8px;
    }

    .contact-card .loading {
      color: var(--text-dim);
      font-size: 13px;
      font-style: italic;
    }

    /* --- Conversation View --- */
    .convo-panel {
      display: none;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 12px;
      margin-bottom: 24px;
      overflow: hidden;
    }

    .convo-panel.active { display: block; }

    .convo-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 16px 20px;
      border-bottom: 1px solid var(--border);
    }

    .convo-header h3 { font-size: 16px; font-weight: 600; }

    .convo-header button {
      background: transparent;
      border: 1px solid var(--border);
      color: var(--text-dim);
      padding: 4px 12px;
      border-radius: 6px;
      cursor: pointer;
      font-size: 12px;
    }

    .convo-messages {
      max-height: 400px;
      overflow-y: auto;
      padding: 16px 20px;
    }

    .convo-msg {
      margin-bottom: 8px;
      font-size: 14px;
    }

    .convo-msg .convo-sender {
      font-weight: 600;
      font-size: 13px;
    }

    .convo-msg .convo-time {
      font-size: 11px;
      color: var(--text-dim);
      margin-left: 8px;
    }

    .convo-msg.from-me {
      padding-left: 16px;
      border-left: 2px solid var(--green);
    }

    .convo-msg.from-them {
      padding-left: 16px;
      border-left: 2px solid var(--accent);
    }

    /* --- Profile Panel --- */
    .profile-panel {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 20px;
      margin-bottom: 16px;
    }

    .profile-panel h3 {
      font-size: 14px;
      margin-bottom: 8px;
      color: var(--purple);
    }

    .profile-panel pre {
      font-size: 13px;
      color: var(--text-dim);
      white-space: pre-wrap;
      word-wrap: break-word;
    }

    /* --- Empty State --- */
    .empty-state {
      text-align: center;
      padding: 60px 20px;
      color: var(--text-dim);
    }

    .empty-state .emoji {
      font-size: 48px;
      margin-bottom: 16px;
    }

    .empty-state h3 {
      font-size: 18px;
      margin-bottom: 8px;
      color: var(--text);
    }
  </style>
</head>
<body>
  <div class="header">
    <h1>Anton</h1>
    <div class="status">
      <div class="dot"></div>
      <span>Live</span>
    </div>
  </div>

  <div class="nav">
    <button class="active" data-page="feed">Live Feed</button>
    <button data-page="contacts">Contacts</button>
    <button data-page="stats">Overview</button>
  </div>

  <div class="main">
    <!-- Live Feed Page -->
    <div id="page-feed" class="page active">
      <div id="feed-container">
        <div class="empty-state" id="feed-empty">
          <div class="emoji">&#x1F4E1;</div>
          <h3>Waiting for messages...</h3>
          <p>Anton's interactions will appear here in real-time</p>
        </div>
      </div>
    </div>

    <!-- Contacts Page -->
    <div id="page-contacts" class="page">
      <div id="convo-panel" class="convo-panel">
        <div class="convo-header">
          <h3 id="convo-title">Conversation</h3>
          <button onclick="closeConvo()">Close</button>
        </div>
        <div class="convo-messages" id="convo-messages"></div>
      </div>
      <div id="contacts-grid" class="contacts-grid">
        <div class="empty-state">
          <div class="emoji">&#x1F464;</div>
          <h3>Loading contacts...</h3>
        </div>
      </div>
    </div>

    <!-- Stats Page -->
    <div id="page-stats" class="page">
      <div class="stats-grid" id="stats-grid"></div>
      <h3 style="margin-bottom: 16px; font-size: 16px;">Recent Interactions</h3>
      <div id="stats-interactions"></div>
    </div>
  </div>

  <script>
    // --- Navigation ---
    document.querySelectorAll('.nav button').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.nav button').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
        btn.classList.add('active');
        document.getElementById('page-' + btn.dataset.page).classList.add('active');

        if (btn.dataset.page === 'contacts') loadContacts();
        if (btn.dataset.page === 'stats') loadStats();
      });
    });

    // --- SSE Live Feed ---
    const evtSource = new EventSource('/api/events');
    evtSource.onmessage = (event) => {
      const interaction = JSON.parse(event.data);
      addFeedItem(interaction);
    };

    // Also load existing interactions on page load
    fetch('/api/interactions').then(r => r.json()).then(interactions => {
      if (interactions.length > 0) {
        document.getElementById('feed-empty')?.remove();
        interactions.forEach(i => addFeedItem(i, false));
      }
    });

    function addFeedItem(i, prepend = true) {
      const empty = document.getElementById('feed-empty');
      if (empty) empty.remove();

      const container = document.getElementById('feed-container');
      const div = document.createElement('div');
      div.className = 'feed-item';

      const time = new Date(i.timestamp).toLocaleTimeString();
      const totalTime = ((i.retrievalTimeMs + i.responseTimeMs) / 1000).toFixed(1);

      div.innerHTML = \`
        <div class="feed-header">
          <span class="sender">\${esc(i.senderName)}</span>
          <span class="time">\${time}</span>
        </div>
        <div class="message-pair">
          <div class="msg-box msg-incoming">
            <div class="msg-label">Incoming</div>
            \${esc(i.incomingMessage)}
          </div>
          <div class="msg-box msg-outgoing">
            <div class="msg-label">Anton's Response</div>
            \${esc(i.response)}
          </div>
        </div>
        <div class="feed-meta">
          <span>&#x23F1;&#xFE0F; \${totalTime}s total</span>
          <span>&#x1F50D; \${(i.retrievalTimeMs/1000).toFixed(1)}s retrieval</span>
          <span>&#x1F9E0; \${i.memoryCount} memories</span>
          <span>\${i.hasProfile ? '&#x2705; Profile' : '&#x274C; No profile'}</span>
        </div>
      \`;

      if (prepend) {
        container.prepend(div);
      } else {
        container.appendChild(div);
      }
    }

    // --- Contacts ---
    async function loadContacts() {
      const grid = document.getElementById('contacts-grid');
      grid.innerHTML = '<div class="empty-state"><div class="emoji">&#x23F3;</div><h3>Loading...</h3></div>';

      const contacts = await fetch('/api/contacts').then(r => r.json());

      if (contacts.length === 0) {
        grid.innerHTML = '<div class="empty-state"><div class="emoji">&#x1F464;</div><h3>No contacts yet</h3><p>Send a message to Anton on WhatsApp</p></div>';
        return;
      }

      grid.innerHTML = '';
      for (const c of contacts) {
        const card = document.createElement('div');
        card.className = 'contact-card';
        const lastActive = new Date(c.lastActive).toLocaleDateString(undefined, {
          month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
        });

        card.innerHTML = \`
          <div class="contact-header">
            <span class="contact-name">\${esc(c.name)}</span>
            <span class="contact-channel">\${c.channel}</span>
          </div>
          <div class="contact-last-active">Last active: \${lastActive}</div>
          <div class="loading">Loading memories...</div>
        \`;

        card.addEventListener('click', () => openConvo(c.jid, c.name));
        grid.appendChild(card);

        // Load memories async
        fetch('/api/contacts/' + encodeURIComponent(c.jid) + '/memories')
          .then(r => r.json())
          .then(data => {
            const loadingEl = card.querySelector('.loading');
            if (!data.memories || data.memories.length === 0) {
              loadingEl.textContent = 'No memories yet';
              return;
            }
            const list = document.createElement('ul');
            list.className = 'memories-list';
            const shown = data.memories.slice(0, 5);
            shown.forEach(m => {
              const li = document.createElement('li');
              li.textContent = m.memory;
              list.appendChild(li);
            });
            loadingEl.replaceWith(list);

            if (data.memories.length > 5) {
              const more = document.createElement('div');
              more.className = 'memory-count';
              more.textContent = '+' + (data.memories.length - 5) + ' more memories';
              card.appendChild(more);
            }
          })
          .catch(() => {
            const loadingEl = card.querySelector('.loading');
            if (loadingEl) loadingEl.textContent = 'Failed to load memories';
          });
      }
    }

    // --- Conversation View ---
    async function openConvo(jid, name) {
      const panel = document.getElementById('convo-panel');
      panel.classList.add('active');
      document.getElementById('convo-title').textContent = name;

      const msgContainer = document.getElementById('convo-messages');
      msgContainer.innerHTML = '<p style="color:var(--text-dim)">Loading...</p>';

      const messages = await fetch('/api/conversation/' + encodeURIComponent(jid)).then(r => r.json());

      if (messages.length === 0) {
        msgContainer.innerHTML = '<p style="color:var(--text-dim)">No messages yet</p>';
        return;
      }

      msgContainer.innerHTML = '';
      messages.forEach(m => {
        const div = document.createElement('div');
        div.className = 'convo-msg ' + (m.isFromMe ? 'from-me' : 'from-them');
        const time = new Date(m.timestamp).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
        div.innerHTML = \`
          <span class="convo-sender">\${esc(m.isFromMe ? 'Anton' : m.sender)}</span>
          <span class="convo-time">\${time}</span>
          <div>\${esc(m.content)}</div>
        \`;
        msgContainer.appendChild(div);
      });

      msgContainer.scrollTop = msgContainer.scrollHeight;
    }

    function closeConvo() {
      document.getElementById('convo-panel').classList.remove('active');
    }

    // --- Stats ---
    async function loadStats() {
      const stats = await fetch('/api/stats').then(r => r.json());
      const grid = document.getElementById('stats-grid');
      grid.innerHTML = \`
        <div class="stat-card">
          <div class="label">Contacts</div>
          <div class="value">\${stats.totalContacts}</div>
        </div>
        <div class="stat-card">
          <div class="label">Interactions</div>
          <div class="value">\${stats.totalInteractions}</div>
        </div>
        <div class="stat-card">
          <div class="label">Avg Response</div>
          <div class="value">\${(stats.avgResponseTimeMs/1000).toFixed(1)} <span class="unit">sec</span></div>
        </div>
        <div class="stat-card">
          <div class="label">Avg Retrieval</div>
          <div class="value">\${(stats.avgRetrievalTimeMs/1000).toFixed(1)} <span class="unit">sec</span></div>
        </div>
      \`;

      // Load recent interactions for stats page too
      const interactions = await fetch('/api/interactions').then(r => r.json());
      const container = document.getElementById('stats-interactions');
      container.innerHTML = '';
      interactions.slice(0, 10).forEach(i => {
        const div = document.createElement('div');
        div.className = 'feed-item';
        const time = new Date(i.timestamp).toLocaleTimeString();
        const totalTime = ((i.retrievalTimeMs + i.responseTimeMs) / 1000).toFixed(1);
        div.innerHTML = \`
          <div class="feed-header">
            <span class="sender">\${esc(i.senderName)}</span>
            <span class="time">\${time} &#x2022; \${totalTime}s</span>
          </div>
          <div class="message-pair">
            <div class="msg-box msg-incoming">
              <div class="msg-label">Message</div>
              \${esc(i.incomingMessage)}
            </div>
            <div class="msg-box msg-outgoing">
              <div class="msg-label">Response</div>
              \${esc(i.response)}
            </div>
          </div>
        \`;
        container.appendChild(div);
      });
    }

    // --- Helpers ---
    function esc(str) {
      if (!str) return '';
      const div = document.createElement('div');
      div.textContent = str;
      return div.innerHTML;
    }
  </script>
</body>
</html>`;
