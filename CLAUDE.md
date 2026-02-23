# Anton

AI digital twin on WhatsApp powered by Mem0 + Claude.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Orchestrator: state, message loop, agent invocation |
| `src/anton-agent.ts` | The brain: deep retrieval + Claude response + Mem0 storage |
| `src/deep-retrieval-agent.ts` | Agentic multi-hop memory retrieval (Haiku + tools) |
| `src/mem0-client.ts` | Mem0 Platform API client |
| `src/dashboard.ts` | Web dashboard with live feed (SSE) |
| `src/channels/whatsapp.ts` | WhatsApp connection via Baileys |
| `src/db.ts` | SQLite operations |
| `groups/global/CLAUDE.md` | Owner personality prompt |

## Development

```bash
npm run dev          # Run with hot reload
npm run build        # Compile TypeScript
npm run seed         # Seed contact memories
```

Dashboard: http://localhost:3420
