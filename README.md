# Anton

Your AI digital twin that lives on WhatsApp. Anton responds as you to your friends and contacts — using your personality, your memories, and your context.

Powered by [Mem0](https://mem0.ai) for persistent memory and Claude for intelligence.

## Architecture

> Open `architecture.excalidraw` in [Excalidraw](https://excalidraw.com) for the interactive version.

```
┌────────────┐     ┌────────────────┐     ┌──────────────────┐     ┌──────────────────┐     ┌──────────────┐
│            │     │                │     │  Deep Retrieval   │     │  Response Agent   │     │              │
│Your Friends│────►│    Baileys     │────►│     Agent         │────►│                  │────►│  Reply Sent  │
│on WhatsApp │     │ Your WhatsApp  │     │                  │     │  Claude Sonnet    │     │ via WhatsApp │
│            │     │                │     │  Claude Haiku     │     │  + Personality    │     │              │
└────────────┘     └───────┬────────┘     │  + 4 Tools        │     └────────┬─────────┘     └──────────────┘
                           │              └────────┬─────────┘              │
                           │                  ▲    │                        │
                    store   │         fetch    │    │ store           live   │
                    msgs    │        context   │    │ convo        updates  │
                           ▼                  │    ▼                        ▼
                   ┌────────────────┐     ┌───┴──────────────┐     ┌──────────────────┐
                   │   SQLite DB    │     │  Mem0 Platform   │     │  Web Dashboard   │
                   │Messages & State│     │                  │     │  localhost:3420   │
                   └────────────────┘     │Memories · Profiles│     └──────────────────┘
                                          │     · Search      │
                                          └──────────────────┘
```

## How It Works

1. Friend sends you a WhatsApp message
2. Anton receives it via Baileys (your actual WhatsApp account)
3. **Deep Retrieval Agent** (Claude Haiku) gathers context from Mem0:
   - Fetches sender's profile
   - Retrieves all memories about this contact
   - Searches for relevant memories (multi-hop)
   - Pulls recent conversation history from SQLite
4. **Response Agent** (Claude Sonnet) generates a reply using your personality prompt + context
5. Reply sent on WhatsApp as you
6. Conversation stored in Mem0 (auto-extracts new memories)

## Features

- **Responds as you** — not a bot, not an assistant. Uses your actual WhatsApp account via Baileys
- **Deep memory** — Mem0 stores per-contact memories, profiles, and relationship context
- **Agentic retrieval** — Multi-hop memory search using Claude Haiku with tools (search, get_all, profile, recent messages)
- **Personality matching** — Customizable personality prompt to match your texting style
- **Live dashboard** — Real-time web UI showing interactions, contacts, memories, and stats
- **Auto-learning** — Every conversation automatically extracts and stores new memories

## Quick Start

### Prerequisites

- Node.js 20+
- [Mem0 Platform](https://app.mem0.ai) API key
- [Anthropic](https://console.anthropic.com) API key

### Setup

```bash
# Install dependencies
npm install

# Create .env file
cat > .env << EOF
ANTHROPIC_API_KEY=sk-ant-...
mem0_API_KEY=m0-...
EOF

# Start Anton
npm run dev
```

On first run, you'll need to scan a QR code to link your WhatsApp account.

### Seed Contacts (Optional)

Pre-load memories about your contacts so Anton knows them from day one:

```bash
# Edit scripts/seed-contacts.ts with your contacts
npm run seed
```

### Dashboard

Once running, open **http://localhost:3420** to see:
- **Live Feed** — Real-time incoming messages and Anton's responses
- **Contacts** — Per-contact memory cards with Mem0 profiles
- **Overview** — Stats, response times, interaction history

## Architecture

```
src/
├── index.ts                  # Main orchestrator — message loop, state management
├── anton-agent.ts            # The brain — retrieval + Claude response + Mem0 storage
├── deep-retrieval-agent.ts   # Agentic multi-hop memory retrieval (Haiku + tools)
├── mem0-client.ts            # Mem0 Platform API client
├── dashboard.ts              # Web dashboard (HTTP + SSE for live updates)
├── channels/
│   └── whatsapp.ts           # WhatsApp via Baileys (your actual account)
├── db.ts                     # SQLite for messages, chats, state
├── config.ts                 # Environment config
├── router.ts                 # Message formatting and channel routing
├── group-queue.ts            # Per-chat FIFO processing queue
└── types.ts                  # TypeScript interfaces

groups/
├── global/CLAUDE.md          # Your personality prompt (who Anton IS)
└── main/CLAUDE.md            # Main group config

scripts/
└── seed-contacts.ts          # Pre-seed contact memories into Mem0
```

## Customization

### Personality

Edit `groups/global/CLAUDE.md` to define how Anton responds. This is the system prompt that shapes all of Anton's replies. Write it as if describing yourself — your texting style, your tone, what you'd say and wouldn't say.

### Contact Seeding

Edit `scripts/seed-contacts.ts` to add your contacts with facts Anton should know about them. Memories are stored with `infer: false` so they're saved exactly as written.

## Tech Stack

- **WhatsApp**: [Baileys](https://github.com/WhiskeySockets/Baileys) — connects to your actual WhatsApp account
- **Memory**: [Mem0 Platform](https://mem0.ai) — persistent per-contact memories and profiles
- **Intelligence**: [Claude](https://anthropic.com) — Haiku for retrieval, Sonnet for responses
- **Database**: SQLite (via better-sqlite3) — local message storage
- **Dashboard**: Node.js HTTP server with SSE — zero external dependencies

## License

MIT
