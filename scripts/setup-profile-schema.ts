/**
 * Setup Mem0 User Profile Schema for Anton
 *
 * Run once to configure what structured information Mem0 extracts
 * about each contact from conversations.
 *
 * Usage: npx tsx scripts/setup-profile-schema.ts
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';

// Read API key from .env
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

const profileSchema = {
  name: {
    type: 'string',
    description: 'Full name of the contact',
  },
  relationship: {
    type: 'string',
    description: 'How this person relates to Chaithanya (e.g., colleague at Mem0, college friend, family, gym buddy)',
  },
  how_they_met: {
    type: 'string',
    description: 'How and when Chaithanya met this person',
  },
  profession: {
    type: 'string',
    description: 'What they do for work, their role, company',
  },
  interests: {
    type: 'array',
    items: { type: 'string' },
    description: 'Hobbies, interests, things they enjoy talking about',
  },
  communication_style: {
    type: 'string',
    description: 'How they communicate — formal, casual, emoji-heavy, brief, detailed, humor style',
  },
  current_life_events: {
    type: 'string',
    description: 'What is going on in their life right now — projects, challenges, celebrations',
  },
  shared_experiences: {
    type: 'array',
    items: { type: 'string' },
    description: 'Notable shared experiences, trips, projects, or memories with Chaithanya',
  },
  preferences: {
    type: 'object',
    description: 'Known preferences — food, music, travel, tech stack, etc.',
  },
  important_dates: {
    type: 'object',
    description: 'Birthdays, anniversaries, or other significant dates',
  },
  emotional_notes: {
    type: 'string',
    description: 'Emotional context — what they are going through, sensitivities, support they might need',
  },
};

async function setupProfileSchema() {
  console.log('Setting up Mem0 user profile schema for Anton...\n');

  const resp = await fetch(`${MEM0_API_HOST}/v1/user-profile/settings/`, {
    method: 'POST',
    headers: {
      'Authorization': `Token ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      schema: profileSchema,
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    console.error(`Failed to set profile schema: ${resp.status}`);
    console.error(text);
    process.exit(1);
  }

  const result = await resp.json();
  console.log('Profile schema configured successfully!');
  console.log(JSON.stringify(result, null, 2));
}

setupProfileSchema().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
