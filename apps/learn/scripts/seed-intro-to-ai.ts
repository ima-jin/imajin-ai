/**
 * Seed script: Import intro-to-ai workshop as the first course
 * 
 * Usage: DATABASE_URL="..." npx tsx scripts/seed-intro-to-ai.ts
 * 
 * This creates:
 * - 1 course: "Intro to AI: A 3-Hour Workshop"
 * - 3 modules: Understanding, Using, Living With It
 * - Lessons from schedule + exercises
 */

import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { courses, modules, lessons } from '../src/db/schema';
import { readFileSync } from 'fs';
import { join } from 'path';

const CREATOR_DID = process.env.CREATOR_DID || 'did:imajin:ryan';

function generateId(prefix: string): string {
  const random = crypto.randomUUID().replace(/-/g, '').substring(0, 13);
  const timestamp = Date.now().toString(36);
  return `${prefix}_${timestamp}${random}`;
}

function readExercise(filename: string): string {
  try {
    return readFileSync(
      join(__dirname, '..', '..', '..', 'imajin-courses', 'intro-to-ai', 'exercises', filename),
      'utf-8'
    );
  } catch {
    return `*Exercise content: ${filename}*`;
  }
}

async function seed() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is required');
    process.exit(1);
  }

  const client = postgres(process.env.DATABASE_URL);
  const db = drizzle(client);

  // Ensure schema exists
  await client`CREATE SCHEMA IF NOT EXISTS learn`;

  console.log('Seeding intro-to-ai course...');

  // Create course
  const courseId = generateId('crs');
  await db.insert(courses).values({
    id: courseId,
    creatorDid: CREATOR_DID,
    title: 'Intro to AI: A 3-Hour Workshop',
    description: 'For people who want to understand AI — not fear it. No tech background required. By the end, you\'ll have a real conversation with AI, use it to write and think, and set it up for your life.',
    slug: 'intro-to-ai',
    price: 0,
    currency: 'CAD',
    visibility: 'public',
    tags: ['ai', 'beginner', 'workshop'],
    metadata: {
      duration: '3 hours',
      classSize: '12-20 people',
      audience: 'Anyone — no tech background required',
      requirements: 'Laptop/tablet with internet access',
    },
    status: 'published',
  });

  console.log(`  Course: ${courseId} (intro-to-ai)`);

  // Module 1: Understanding (Hour 1)
  const mod1Id = generateId('mod');
  await db.insert(modules).values({
    id: mod1Id,
    courseId,
    title: 'Understanding',
    description: 'Hour 1 — What AI is, what it\'s good at, what it\'s not.',
    sortOrder: 0,
  });

  const mod1Lessons = [
    {
      title: 'Opening: What Are You Afraid Of?',
      contentType: 'slide',
      content: '# What Are You Afraid Of?\n\nOpen discussion (15 minutes)\n\n- What have you heard about AI?\n- What worries you?\n- What are you curious about?\n\nNo wrong answers. Every fear is valid. Let\'s talk about them.',
      durationMinutes: 15,
    },
    {
      title: 'How It Works: Pattern Completion, Not Magic',
      contentType: 'slide',
      content: '# How AI Actually Works\n\nAI is pattern completion. It\'s read most of the internet and learned to predict what comes next.\n\n**What it IS:**\n- A very good pattern matcher\n- A writing/thinking assistant\n- A patient tutor that never judges\n\n**What it ISN\'T:**\n- Conscious or aware\n- Always right\n- Coming for your job (probably)\n- Skynet\n\nIt\'s a tool. A very powerful one. Let\'s learn to use it.',
      durationMinutes: 20,
    },
    {
      title: 'Good vs Bad: Where AI Excels and Fails',
      contentType: 'slide',
      content: '# Good vs Bad\n\n**AI is great at:**\n- Writing first drafts\n- Explaining complex topics simply\n- Brainstorming and thinking through problems\n- Summarizing long documents\n- Translating between languages\n- Coding and technical tasks\n\n**AI is bad at:**\n- Facts and dates (it "hallucinates")\n- Math (seriously)\n- Knowing what happened recently\n- Understanding YOUR specific situation\n- Replacing human judgment\n- Emotional support (it can listen, but it doesn\'t care)\n\n**The key insight:** Use it where it\'s strong. Verify where it\'s weak.',
      durationMinutes: 15,
    },
    {
      title: 'Q&A Buffer',
      contentType: 'markdown',
      content: '# Q&A\n\nTime to address any lingering questions from Hour 1.\n\nCommon questions:\n- "Is it safe?"\n- "Can it see my data?"\n- "Will it replace my job?"\n- "Should I be worried?"\n\nHonest answers only. If we don\'t know, we say so.',
      durationMinutes: 10,
    },
  ];

  for (let i = 0; i < mod1Lessons.length; i++) {
    await db.insert(lessons).values({
      id: generateId('lsn'),
      moduleId: mod1Id,
      ...mod1Lessons[i],
      sortOrder: i,
      metadata: {},
    });
  }

  console.log(`  Module 1: ${mod1Id} (Understanding) — ${mod1Lessons.length} lessons`);

  // Module 2: Using (Hour 2)
  const mod2Id = generateId('mod');
  await db.insert(modules).values({
    id: mod2Id,
    courseId,
    title: 'Using',
    description: 'Hour 2 — Hands-on exercises. Everyone opens ChatGPT.',
    sortOrder: 1,
  });

  const exerciseFiles = [
    '01-first-conversation.md',
    '02-write-something.md',
    '03-explain-something.md',
    '04-think-with-me.md',
  ];

  const mod2Lessons = [
    {
      title: 'Setup: Everyone Opens ChatGPT',
      contentType: 'slide',
      content: '# Let\'s Get Started\n\n1. Open your laptop or tablet\n2. Go to **chat.openai.com**\n3. Create a free account (or sign in if you have one)\n4. You should see a chat interface\n\nIf you get stuck, raise your hand. No judgment.\n\n*We\'re using ChatGPT because it\'s the most accessible. The same principles apply to Claude, Gemini, and others.*',
      durationMinutes: 10,
    },
    ...exerciseFiles.map((file, i) => ({
      title: `Exercise ${i + 1}: ${file.replace(/^\d+-/, '').replace('.md', '').replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}`,
      contentType: 'exercise',
      content: readExercise(file),
      durationMinutes: 15,
    })),
    {
      title: 'The Prompt: Why How You Ask Matters',
      contentType: 'slide',
      content: '# The Prompt Matters\n\nThe same question asked differently gets very different answers.\n\n**Vague:** "Tell me about dogs"\n**Better:** "I\'m adopting my first dog. I live in a small apartment and work from home. What breeds should I consider and why?"\n\n**The formula:**\n1. **Context** — Who you are, what situation\n2. **Task** — What you want it to do\n3. **Constraints** — Tone, length, format\n4. **Examples** — Show it what good looks like\n\nYou don\'t need to memorize this. Just be specific about what you need.',
      durationMinutes: 5,
    },
  ];

  for (let i = 0; i < mod2Lessons.length; i++) {
    await db.insert(lessons).values({
      id: generateId('lsn'),
      moduleId: mod2Id,
      ...mod2Lessons[i],
      sortOrder: i,
      metadata: mod2Lessons[i].contentType === 'exercise' ? { instructions: 'Follow the steps in the exercise content.' } : {},
    });
  }

  console.log(`  Module 2: ${mod2Id} (Using) — ${mod2Lessons.length} lessons`);

  // Module 3: Living With It (Hour 3)
  const mod3Id = generateId('mod');
  await db.insert(modules).values({
    id: mod3Id,
    courseId,
    title: 'Living With It',
    description: 'Hour 3 — Custom instructions, real talk about jobs, practice challenge.',
    sortOrder: 2,
  });

  const mod3Lessons = [
    {
      title: 'Your AI: Custom Instructions',
      contentType: 'exercise',
      content: readExercise('05-custom-instructions.md'),
      durationMinutes: 15,
    },
    {
      title: 'Real Stories: How People Like You Are Using It',
      contentType: 'slide',
      content: '# Real Stories\n\n**The retired teacher** uses it to write down family stories — AI helps her structure the memories and fill in details she describes verbally.\n\n**The small business owner** uses it to write emails, create social posts, and draft proposals. Saves 5-10 hours a week.\n\n**The student** uses it as a tutor that never gets annoyed. "Explain this again" works every time.\n\n**The anxious parent** uses it to research medical symptoms without spiraling — "explain this like I\'m worried but rational."\n\n**The creative** uses it to brainstorm, not to create. "Give me 20 bad ideas for this project" → finds 2 good ones.\n\nNotice: none of these people are "tech people."',
      durationMinutes: 15,
    },
    {
      title: 'The Job Talk: Honest Conversation',
      contentType: 'slide',
      content: '# The Job Talk\n\nLet\'s be honest about this.\n\n**What\'s true:**\n- AI will change how many jobs work\n- Some tasks will be automated\n- New roles will emerge\n- The transition will be uneven and sometimes unfair\n\n**What\'s also true:**\n- People who learn to use AI will be more valuable\n- Judgment, empathy, and relationship skills matter more\n- We\'re in the "learning to use the new tool" phase\n- You started that today\n\n**The best advice:**\n- Don\'t ignore it and hope it goes away\n- Don\'t panic and assume the worst\n- DO learn to use it for YOUR work\n- DO stay curious\n- DO talk to people in your field about how they\'re using it',
      durationMinutes: 15,
    },
    {
      title: 'What\'s Next: Resources & One-Week Challenge',
      contentType: 'markdown',
      content: '# What\'s Next\n\n## One-Week Practice Challenge\n\nEvery day this week, use AI for ONE thing:\n\n- **Monday:** Write an email you\'ve been putting off\n- **Tuesday:** Ask it to explain something you\'ve never understood\n- **Wednesday:** Use it to plan something (a meal, a trip, a project)\n- **Thursday:** Ask it to help you think through a decision\n- **Friday:** Get creative — write a poem, a story, a joke\n- **Weekend:** Show someone else what you learned today\n\n## Resources\n\n- **ChatGPT:** chat.openai.com (free tier is plenty)\n- **Claude:** claude.ai (great for longer conversations)\n- **Gemini:** gemini.google.com (integrated with Google)\n\n## Remember\n\n- Be specific in your prompts\n- Verify important facts\n- It\'s a tool, not an oracle\n- The more you use it, the better you get\n- You started today. That matters.',
      durationMinutes: 10,
    },
    {
      title: 'Closing Q&A',
      contentType: 'markdown',
      content: '# Final Questions\n\nAnything goes. No question is too basic.\n\nThank you for spending three hours learning something new. That takes courage.',
      durationMinutes: 5,
    },
  ];

  for (let i = 0; i < mod3Lessons.length; i++) {
    await db.insert(lessons).values({
      id: generateId('lsn'),
      moduleId: mod3Id,
      ...mod3Lessons[i],
      sortOrder: i,
      metadata: mod3Lessons[i].contentType === 'exercise' ? { instructions: 'Follow the steps in the exercise content.' } : {},
    });
  }

  console.log(`  Module 3: ${mod3Id} (Living With It) — ${mod3Lessons.length} lessons`);

  console.log('\n✅ Seed complete!');
  console.log(`   Course: intro-to-ai (${courseId})`);
  console.log(`   Modules: 3`);
  console.log(`   Lessons: ${mod1Lessons.length + mod2Lessons.length + mod3Lessons.length}`);

  await client.end();
}

seed().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
