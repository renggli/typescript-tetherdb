import type { TableRow } from 'tetherdb/server';

const now = Date.now();

/**
 * Initial community category rows.
 */
export const communityRows: TableRow[] = [
  {
    id: 'general',
    data: {
      id: 'general',
      name: 'General',
      icon: '💬',
      description: 'Everyday chatter, introductions, and broad discussions',
      createdAt: now - 3600000 * 24,
    },
  },
  {
    id: 'tech',
    data: {
      id: 'tech',
      name: 'Technology',
      icon: '💻',
      description: 'Hardware, software, web architecture, and databases',
      createdAt: now - 3600000 * 20,
    },
  },
  {
    id: 'ideas',
    data: {
      id: 'ideas',
      name: 'Ideas & Projects',
      icon: '💡',
      description: 'Show off what you are building and brainstorm new concepts',
      createdAt: now - 3600000 * 18,
    },
  },
  {
    id: 'questions',
    data: {
      id: 'questions',
      name: 'Community',
      icon: '👥',
      description:
        'Discussions, questions, and ideas from community contributors',
      createdAt: now - 3600000 * 12,
    },
  },
];

/**
 * Initial forum post and reply rows.
 */
export const postRows: TableRow[] = [
  // Post 1: Welcome
  {
    id: 'post_welcome',
    userName: 'alice',
    data: {
      community: 'general',
      title: 'Welcome to TetherForum! 🚀 Unified Recursive Posts',
      content:
        'TetherForum is a real-time discussion platform built on TetherDB. It showcases reactive secondary indexes and real-time WebSocket synchronization across multiple users.\n\nNotice that everything is a Post! Top-level posts have no parentId, while comments and nested replies simply reference their parentId.\n\nTry opening another tab, signing in as Alice, Bob, or Charlie, and upvoting or replying in real time!',
      createdAt: now - 3600000 * 24,
      updatedAt: now - 3600000 * 24,
    },
  },
  {
    id: 'post_welcome_reply_1',
    userName: 'alice',
    data: {
      community: 'general',
      parentId: 'post_welcome',
      content:
        'Sync works instantly! Comments are just child posts in the same table.',
      createdAt: now - 3600000 * 23,
      updatedAt: now - 3600000 * 23,
    },
  },
  {
    id: 'post_welcome_nested_1',
    userName: 'charlie',
    data: {
      community: 'general',
      parentId: 'post_welcome_reply_1',
      content:
        'And nested replies just point to their parent reply post. Beautiful and clean!',
      createdAt: now - 3600000 * 22,
      updatedAt: now - 3600000 * 22,
    },
  },
  {
    id: 'post_welcome_reply_2',
    userName: 'bob',
    data: {
      community: 'general',
      parentId: 'post_welcome',
      content:
        'And it works offline too — changes queue locally in IndexedDB and flush upon reconnecting.',
      createdAt: now - 3600000 * 21,
      updatedAt: now - 3600000 * 21,
    },
  },

  // Post 2: Dark mode
  {
    id: 'post_darkmode',
    userName: 'alice',
    data: {
      community: 'tech',
      title: 'Why do programmers prefer dark mode? 🦇',
      content:
        'Because light attracts bugs.\n\nAlso because the green glow of terminal text at 3:14 AM is the only spectrum of visible radiation my exhausted soul can absorb without throwing an unhandled runtime error.',
      createdAt: now - 3600000 * 18,
      updatedAt: now - 3600000 * 18,
    },
  },
  {
    id: 'post_darkmode_reply_1',
    userName: 'bob',
    data: {
      community: 'tech',
      parentId: 'post_darkmode',
      content:
        'I tried light mode once in 2021. My compiler refused to build out of pure respect for my retinas.',
      createdAt: now - 3600000 * 17,
      updatedAt: now - 3600000 * 17,
    },
  },
  {
    id: 'post_darkmode_nested_1',
    userName: 'charlie',
    data: {
      community: 'tech',
      parentId: 'post_darkmode_reply_1',
      content:
        'People who code in light mode are either absolute superheroes or working on a laptop directly on a sunny beach.',
      createdAt: now - 3600000 * 16,
      updatedAt: now - 3600000 * 16,
    },
  },
  {
    id: 'post_darkmode_nested_2',
    userName: 'alice',
    data: {
      community: 'tech',
      parentId: 'post_darkmode_nested_1',
      content:
        'Who codes at the beach?! The sand gets between the Cherry MX switches!',
      createdAt: now - 3600000 * 15,
      updatedAt: now - 3600000 * 15,
    },
  },
  {
    id: 'post_darkmode_reply_2',
    userName: 'charlie',
    data: {
      community: 'tech',
      parentId: 'post_darkmode',
      content:
        'There are two hard problems in computer science: cache invalidation, naming things, and picking a syntax highlighter theme.',
      createdAt: now - 3600000 * 14,
      updatedAt: now - 3600000 * 14,
    },
  },

  // Post 3: Microservices vs SQLite
  {
    id: 'post_sqlite',
    userName: 'bob',
    data: {
      community: 'tech',
      title:
        'I replaced our entire microservices fleet with a single SQLite file and sync engine',
      content:
        'We had 47 Kubernetes pods, 3 Kafka clusters, and a monthly cloud bill higher than the GDP of a small island nation.\n\nNow we have TetherDB and a 4MB local file in each browser. Query latency dropped to 0.1ms because physics. The DevOps team is looking at me like I committed a crime, but our users have never been happier.',
      createdAt: now - 3600000 * 10,
      updatedAt: now - 3600000 * 10,
    },
  },
  {
    id: 'post_sqlite_reply_1',
    userName: 'alice',
    data: {
      community: 'tech',
      parentId: 'post_sqlite',
      content:
        'How do you handle multi-device sync and conflicting writes when users go offline?',
      createdAt: now - 3600000 * 9,
      updatedAt: now - 3600000 * 9,
    },
  },
  {
    id: 'post_sqlite_reply_2',
    userName: 'charlie',
    data: {
      community: 'tech',
      parentId: 'post_sqlite',
      content:
        'Wait until your compliance officer finds out the database is literally on the user’s phone.',
      createdAt: now - 3600000 * 8,
      updatedAt: now - 3600000 * 8,
    },
  },
  {
    id: 'post_sqlite_reply_3',
    userName: 'alice',
    data: {
      community: 'tech',
      parentId: 'post_sqlite_reply_1',
      content:
        'Deterministic LWW with client timestamps + outbox reconciliation handles this out of the box!',
      createdAt: now - 3600000 * 7,
      updatedAt: now - 3600000 * 7,
    },
  },

  // Post 4: Smart Toaster
  {
    id: 'post_toaster',
    userName: 'charlie',
    data: {
      community: 'ideas',
      title: 'Startup Pitch: Smart Toaster powered by Edge AI 🍞',
      content:
        'Pitch: An IoT toaster that uses edge machine learning to predict when you want breakfast, but works 100% offline so you don’t starve when your home broadband drops.\n\nFeatures:\n- On-device crumb analytics\n- Decentralized toast synchronization with family members\n- P2P temperature mesh networking',
      createdAt: now - 3600000 * 5,
      updatedAt: now - 3600000 * 5,
    },
  },
  {
    id: 'post_toaster_reply_1',
    userName: 'bob',
    data: {
      community: 'ideas',
      parentId: 'post_toaster',
      content: 'Will it support zero-knowledge toast proofs for privacy?',
      createdAt: now - 3600000 * 4,
      updatedAt: now - 3600000 * 4,
    },
  },
  {
    id: 'post_toaster_nested_1',
    userName: 'charlie',
    data: {
      community: 'ideas',
      parentId: 'post_toaster_reply_1',
      content: 'Of course. End-to-end encrypted crumb telemetry.',
      createdAt: now - 3600000 * 3.5,
      updatedAt: now - 3600000 * 3.5,
    },
  },
  {
    id: 'post_toaster_reply_2',
    userName: 'bob',
    data: {
      community: 'ideas',
      parentId: 'post_toaster',
      content: 'Shut up and take my money. Can it run Doom on the display?',
      createdAt: now - 3600000 * 3,
      updatedAt: now - 3600000 * 3,
    },
  },
  {
    id: 'post_toaster_nested_2',
    userName: 'alice',
    data: {
      community: 'ideas',
      parentId: 'post_toaster_reply_2',
      content:
        'If the microcontroller has at least 8KB of RAM, somebody will port Doom to the toast display within 48 hours.',
      createdAt: now - 3600000 * 2.5,
      updatedAt: now - 3600000 * 2.5,
    },
  },

  // Post 5: Init debugging
  {
    id: 'post_init_bug',
    userName: 'alice',
    data: {
      community: 'questions',
      title:
        'Is it normal to spend 4 hours debugging only to realize you forgot to call .init()?',
      content:
        'Asking for a friend. The friend is me. \n\nI rewrote my state machine, questioned the laws of quantum mechanics, and began researching goat farming before noticing line 42 was missing `await client.init()`.',
      createdAt: now - 3600000 * 2,
      updatedAt: now - 3600000 * 2,
    },
  },
  {
    id: 'post_init_reply_1',
    userName: 'charlie',
    data: {
      community: 'questions',
      parentId: 'post_init_bug',
      content: 'One of us! One of us! 🐑',
      createdAt: now - 3600000 * 1.5,
      updatedAt: now - 3600000 * 1.5,
    },
  },
  {
    id: 'post_init_reply_2',
    userName: 'bob',
    data: {
      community: 'questions',
      parentId: 'post_init_bug',
      content:
        'Next week: spending 6 hours debugging a missing semicolon in a CSS variable name.',
      createdAt: now - 3600000 * 1,
      updatedAt: now - 3600000 * 1,
    },
  },
  {
    id: 'post_init_nested_1',
    userName: 'alice',
    data: {
      community: 'questions',
      parentId: 'post_init_reply_2',
      content: "Please don't speak that curse into existence.",
      createdAt: now - 3600000 * 0.5,
      updatedAt: now - 3600000 * 0.5,
    },
  },
];

/**
 * Initial forum vote rows.
 */
export const voteRows: TableRow[] = [
  // Votes for Welcome Thread
  {
    id: 'vote_post_welcome_alice',
    userName: 'alice',
    data: {
      targetId: 'post_welcome',
      value: 1,
      createdAt: now - 3600000 * 24,
    },
  },
  {
    id: 'vote_post_welcome_bob',
    userName: 'bob',
    data: {
      targetId: 'post_welcome',
      value: 1,
      createdAt: now - 3600000 * 22,
    },
  },
  {
    id: 'vote_post_welcome_charlie',
    userName: 'charlie',
    data: {
      targetId: 'post_welcome',
      value: 1,
      createdAt: now - 3600000 * 21,
    },
  },
  {
    id: 'vote_post_welcome_reply_1_bob',
    userName: 'bob',
    data: {
      targetId: 'post_welcome_reply_1',
      value: 1,
      createdAt: now - 3600000 * 22.5,
    },
  },
  {
    id: 'vote_post_welcome_nested_1_alice',
    userName: 'alice',
    data: {
      targetId: 'post_welcome_nested_1',
      value: 1,
      createdAt: now - 3600000 * 21.5,
    },
  },
  {
    id: 'vote_post_welcome_nested_1_bob',
    userName: 'bob',
    data: {
      targetId: 'post_welcome_nested_1',
      value: 1,
      createdAt: now - 3600000 * 21,
    },
  },
  {
    id: 'vote_post_welcome_reply_2_alice',
    userName: 'alice',
    data: {
      targetId: 'post_welcome_reply_2',
      value: 1,
      createdAt: now - 3600000 * 20.5,
    },
  },

  // Votes for Dark Mode Thread
  {
    id: 'vote_post_darkmode_alice',
    userName: 'alice',
    data: {
      targetId: 'post_darkmode',
      value: 1,
      createdAt: now - 3600000 * 18,
    },
  },
  {
    id: 'vote_post_darkmode_charlie',
    userName: 'charlie',
    data: {
      targetId: 'post_darkmode',
      value: 1,
      createdAt: now - 3600000 * 16,
    },
  },
  {
    id: 'vote_post_darkmode_reply_1_alice',
    userName: 'alice',
    data: {
      targetId: 'post_darkmode_reply_1',
      value: 1,
      createdAt: now - 3600000 * 16.5,
    },
  },
  {
    id: 'vote_post_darkmode_reply_1_charlie',
    userName: 'charlie',
    data: {
      targetId: 'post_darkmode_reply_1',
      value: 1,
      createdAt: now - 3600000 * 16,
    },
  },
  {
    id: 'vote_post_darkmode_nested_1_bob',
    userName: 'bob',
    data: {
      targetId: 'post_darkmode_nested_1',
      value: 1,
      createdAt: now - 3600000 * 15.5,
    },
  },
  {
    id: 'vote_post_darkmode_nested_2_bob',
    userName: 'bob',
    data: {
      targetId: 'post_darkmode_nested_2',
      value: 1,
      createdAt: now - 3600000 * 14.8,
    },
  },
  {
    id: 'vote_post_darkmode_nested_2_charlie',
    userName: 'charlie',
    data: {
      targetId: 'post_darkmode_nested_2',
      value: 1,
      createdAt: now - 3600000 * 14.5,
    },
  },
  {
    id: 'vote_post_darkmode_reply_2_alice',
    userName: 'alice',
    data: {
      targetId: 'post_darkmode_reply_2',
      value: 1,
      createdAt: now - 3600000 * 13.5,
    },
  },

  // Votes for SQLite Microservices Thread (Controversial)
  {
    id: 'vote_post_sqlite_bob',
    userName: 'bob',
    data: {
      targetId: 'post_sqlite',
      value: 1,
      createdAt: now - 3600000 * 10,
    },
  },
  {
    id: 'vote_post_sqlite_alice',
    userName: 'alice',
    data: {
      targetId: 'post_sqlite',
      value: 1,
      createdAt: now - 3600000 * 9,
    },
  },
  {
    id: 'vote_post_sqlite_charlie',
    userName: 'charlie',
    data: {
      targetId: 'post_sqlite',
      value: -1,
      createdAt: now - 3600000 * 8,
    },
  },
  {
    id: 'vote_post_sqlite_reply_1_bob',
    userName: 'bob',
    data: {
      targetId: 'post_sqlite_reply_1',
      value: 1,
      createdAt: now - 3600000 * 8.5,
    },
  },
  {
    id: 'vote_post_sqlite_reply_2_alice',
    userName: 'alice',
    data: {
      targetId: 'post_sqlite_reply_2',
      value: 1,
      createdAt: now - 3600000 * 7.5,
    },
  },
  {
    id: 'vote_post_sqlite_reply_3_bob',
    userName: 'bob',
    data: {
      targetId: 'post_sqlite_reply_3',
      value: 1,
      createdAt: now - 3600000 * 6.8,
    },
  },
  {
    id: 'vote_post_sqlite_reply_3_charlie',
    userName: 'charlie',
    data: {
      targetId: 'post_sqlite_reply_3',
      value: 1,
      createdAt: now - 3600000 * 6.5,
    },
  },

  // Votes for Smart Toaster Thread (Mixed / Polarized)
  {
    id: 'vote_post_toaster_charlie',
    userName: 'charlie',
    data: {
      targetId: 'post_toaster',
      value: 1,
      createdAt: now - 3600000 * 5,
    },
  },
  {
    id: 'vote_post_toaster_bob',
    userName: 'bob',
    data: {
      targetId: 'post_toaster',
      value: 1,
      createdAt: now - 3600000 * 4.5,
    },
  },
  {
    id: 'vote_post_toaster_alice',
    userName: 'alice',
    data: {
      targetId: 'post_toaster',
      value: -1,
      createdAt: now - 3600000 * 4,
    },
  },
  {
    id: 'vote_post_toaster_reply_1_charlie',
    userName: 'charlie',
    data: {
      targetId: 'post_toaster_reply_1',
      value: 1,
      createdAt: now - 3600000 * 3.8,
    },
  },
  {
    id: 'vote_post_toaster_nested_1_bob',
    userName: 'bob',
    data: {
      targetId: 'post_toaster_nested_1',
      value: 1,
      createdAt: now - 3600000 * 3.4,
    },
  },
  {
    id: 'vote_post_toaster_reply_2_alice',
    userName: 'alice',
    data: {
      targetId: 'post_toaster_reply_2',
      value: 1,
      createdAt: now - 3600000 * 2.8,
    },
  },
  {
    id: 'vote_post_toaster_reply_2_charlie',
    userName: 'charlie',
    data: {
      targetId: 'post_toaster_reply_2',
      value: 1,
      createdAt: now - 3600000 * 2.7,
    },
  },
  {
    id: 'vote_post_toaster_nested_2_bob',
    userName: 'bob',
    data: {
      targetId: 'post_toaster_nested_2',
      value: 1,
      createdAt: now - 3600000 * 2.3,
    },
  },
  {
    id: 'vote_post_toaster_nested_2_charlie',
    userName: 'charlie',
    data: {
      targetId: 'post_toaster_nested_2',
      value: 1,
      createdAt: now - 3600000 * 2.2,
    },
  },

  // Votes for Init Bug Thread (Universally Upvoted)
  {
    id: 'vote_post_init_bug_alice',
    userName: 'alice',
    data: {
      targetId: 'post_init_bug',
      value: 1,
      createdAt: now - 3600000 * 2,
    },
  },
  {
    id: 'vote_post_init_bug_charlie',
    userName: 'charlie',
    data: {
      targetId: 'post_init_bug',
      value: 1,
      createdAt: now - 3600000 * 1.5,
    },
  },
  {
    id: 'vote_post_init_bug_bob',
    userName: 'bob',
    data: {
      targetId: 'post_init_bug',
      value: 1,
      createdAt: now - 3600000 * 1,
    },
  },
  {
    id: 'vote_post_init_reply_1_alice',
    userName: 'alice',
    data: {
      targetId: 'post_init_reply_1',
      value: 1,
      createdAt: now - 3600000 * 1.4,
    },
  },
  {
    id: 'vote_post_init_reply_1_bob',
    userName: 'bob',
    data: {
      targetId: 'post_init_reply_1',
      value: 1,
      createdAt: now - 3600000 * 1.3,
    },
  },
  {
    id: 'vote_post_init_reply_2_alice',
    userName: 'alice',
    data: {
      targetId: 'post_init_reply_2',
      value: 1,
      createdAt: now - 3600000 * 0.9,
    },
  },
  {
    id: 'vote_post_init_reply_2_charlie',
    userName: 'charlie',
    data: {
      targetId: 'post_init_reply_2',
      value: 1,
      createdAt: now - 3600000 * 0.8,
    },
  },
  {
    id: 'vote_post_init_nested_1_bob',
    userName: 'bob',
    data: {
      targetId: 'post_init_nested_1',
      value: 1,
      createdAt: now - 3600000 * 0.4,
    },
  },
];

/**
 * Initial user accounts.
 */
export const forumUsers = [
  { userName: 'alice', password: 'password123' },
  { userName: 'bob', password: 'password123' },
  { userName: 'charlie', password: 'password123' },
];
