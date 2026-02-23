/**
 * Seed contact memories into Mem0.
 * Sends actual facts as plain paragraphs — no synthetic conversations.
 *
 * Usage: npx tsx scripts/seed-contacts.ts
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';

const envPath = resolve(import.meta.dirname, '..', '.env');
const envContent = readFileSync(envPath, 'utf-8');
const apiKey = envContent
  .split('\n')
  .find((l) => l.startsWith('mem0_API_KEY='))
  ?.split('=')[1]
  ?.trim();

if (!apiKey) {
  console.error('mem0_API_KEY not found in .env');
  process.exit(1);
}

const MEM0_API_HOST = 'https://api.mem0.ai';

interface Contact {
  phone: string;
  name: string;
  memories: string[];
}

const contacts: Contact[] = [
  {
    phone: '919950262900',
    name: 'Saket',
    memories: [
      'Saket is a colleague of Chaithanya who works at Mem0',
      'Saket always tries to gaslight others, but he is one of the best folks Chaithanya has ever worked with',
      'Saket is really smart and always there to help',
      'Saket is funny and has a lot of humor',
      'Saket is from Bihar',
      'Chaithanya and Saket recently had a trip to Singapore together',
    ],
  },
  {
    phone: '919990477114',
    name: 'Taranjeet',
    memories: [
      'Taranjeet is the founder and CEO of Mem0',
    ],
  },
  {
    phone: '15044256763',
    name: 'Deshraj',
    memories: [
      'Deshraj is one of the co-founders of Mem0',
      'Chaithanya really likes working with Deshraj',
      'Deshraj heads the entire engineering team at Mem0',
      'Deshraj likes playing cricket',
      'Chaithanya and Deshraj recently met in Goa for an offsite',
      'Chaithanya along with Deshraj, Soum Mill, and Agam have a daily sync every single day',
    ],
  },
  {
    phone: '918050740173',
    name: 'Chaithanya Kumar',
    memories: [
      'Chaithanya Kumar likes playing cricket',
      'Chaithanya is fond of running',
      'Chaithanya is currently training for an ICM marathon happening on the 22nd of August 2026',
      'Chaithanya\'s best friend is Ganesh',
      'Chaithanya is currently going through a crazy personal transformation to become the best human on the planet earth',
    ],
  },
];

async function ingestContact(contact: Contact): Promise<void> {
  const userId = `${contact.phone}@s.whatsapp.net`;
  console.log(`\nIngesting ${contact.name} (${userId}) — ${contact.memories.length} memories...`);

  for (let i = 0; i < contact.memories.length; i++) {
    const memory = contact.memories[i];
    console.log(`  [${i + 1}/${contact.memories.length}] ${memory}`);

    const resp = await fetch(`${MEM0_API_HOST}/v1/memories/`, {
      method: 'POST',
      headers: {
        Authorization: `Token ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messages: [{ role: 'user', content: memory }],
        user_id: userId,
        infer: false,
        metadata: { channel: 'whatsapp', source: 'seed' },
      }),
    });

    if (!resp.ok) {
      const text = await resp.text();
      console.error(`    FAILED: ${resp.status} — ${text}`);
      continue;
    }

    console.log(`    OK`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

async function main() {
  console.log('Seeding contact memories into Mem0...');

  for (const contact of contacts) {
    await ingestContact(contact);
    await new Promise((r) => setTimeout(r, 1000));
  }

  console.log('\nDone!');
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
