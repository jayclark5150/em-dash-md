#!/usr/bin/env node

import admin from 'firebase-admin';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Initialize Firebase Admin SDK
const serviceAccountPath = process.env.SERVICE_ACCOUNT_KEY_PATH || join(__dirname, 'service-account-key.json');
let serviceAccount;

try {
  const keyContent = readFileSync(serviceAccountPath, 'utf8');
  serviceAccount = JSON.parse(keyContent);
} catch (err) {
  console.error(`Failed to load service account key from ${serviceAccountPath}:`, err.message);
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  projectId: serviceAccount.project_id
});

const db = admin.firestore();
const auth = admin.auth();

// In-memory store for tool definitions (MCP spec)
const tools = [
  {
    name: 'search_documents',
    description: 'Search em-dash documents by title, content, or tags. Returns matching documents with snippets.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query (searches title and content)'
        },
        limit: {
          type: 'number',
          description: 'Max results (default 10)',
          default: 10
        },
        tag: {
          type: 'string',
          description: 'Optional: filter by tag'
        }
      },
      required: ['query']
    }
  },
  {
    name: 'get_document',
    description: 'Fetch a specific em-dash document by ID or title. Returns full content.',
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'Document ID (Firestore doc ID)'
        },
        title: {
          type: 'string',
          description: 'Document title (will search for exact match)'
        }
      }
    }
  },
  {
    name: 'create_document',
    description: 'Create a new em-dash document with title and markdown content.',
    inputSchema: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'Document title (include .md extension)'
        },
        content: {
          type: 'string',
          description: 'Markdown content'
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional tags for organization'
        }
      },
      required: ['title', 'content']
    }
  },
  {
    name: 'list_recent',
    description: 'List recently updated em-dash documents (user\'s own documents only).',
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: 'Number of docs to return (default 20, max 100)',
          default: 20
        }
      }
    }
  },
  {
    name: 'update_document',
    description: 'Update an existing em-dash document\'s content.',
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'Document ID'
        },
        content: {
          type: 'string',
          description: 'New markdown content'
        },
        title: {
          type: 'string',
          description: 'Optional: new title'
        }
      },
      required: ['id', 'content']
    }
  }
];

// Tool implementations
async function searchDocuments(userId, query, limit = 10, tag = null) {
  let q = db.collection('documents').where('userId', '==', userId);

  if (tag) {
    q = q.where('tags', 'array-contains', tag);
  }

  const snap = await q.limit(limit * 2).get(); // Fetch more, then filter locally

  const results = snap.docs
    .map(doc => {
      const data = doc.data();
      const titleMatch = data.title.toLowerCase().includes(query.toLowerCase());
      const contentMatch = data.content.toLowerCase().includes(query.toLowerCase());

      if (titleMatch || contentMatch) {
        let snippet = data.content;
        if (contentMatch) {
          const idx = data.content.toLowerCase().indexOf(query.toLowerCase());
          const start = Math.max(0, idx - 50);
          const end = Math.min(data.content.length, idx + query.length + 50);
          snippet = (start > 0 ? '...' : '') + data.content.slice(start, end) + (end < data.content.length ? '...' : '');
        }

        return {
          id: doc.id,
          title: data.title,
          snippet,
          createdAt: data.createdAt,
          updatedAt: data.updatedAt,
          tags: data.tags || [],
          score: titleMatch ? 2 : 1 // Boost title matches
        };
      }
      return null;
    })
    .filter(r => r !== null)
    .sort((a, b) => {
      // Sort by score, then by update date
      if (b.score !== a.score) return b.score - a.score;
      return b.updatedAt.toMillis() - a.updatedAt.toMillis();
    })
    .slice(0, limit)
    .map(({ score, ...rest }) => rest); // Remove score from output

  return results;
}

async function getDocument(userId, id, title) {
  if (id) {
    const snap = await db.collection('documents').doc(id).get();
    if (!snap.exists) return null;

    const data = snap.data();
    if (data.userId !== userId) return null; // Security: only own docs

    return {
      id: snap.id,
      ...data
    };
  }

  if (title) {
    const snap = await db.collection('documents')
      .where('userId', '==', userId)
      .where('title', '==', title)
      .limit(1)
      .get();

    if (snap.empty) return null;
    const doc = snap.docs[0];
    return {
      id: doc.id,
      ...doc.data()
    };
  }

  return null;
}

async function createDocument(userId, title, content, tags = []) {
  if (!title.endsWith('.md')) {
    title = title + '.md';
  }

  const now = admin.firestore.Timestamp.now();
  const docRef = db.collection('documents').doc();

  await docRef.set({
    userId,
    title,
    content,
    tags,
    createdAt: now,
    updatedAt: now
  });

  return {
    id: docRef.id,
    title,
    content,
    tags,
    createdAt: now,
    updatedAt: now,
    message: `Document created: ${title}`
  };
}

async function listRecent(userId, limit = 20) {
  limit = Math.min(limit, 100);

  const snap = await db.collection('documents')
    .where('userId', '==', userId)
    .orderBy('updatedAt', 'desc')
    .limit(limit)
    .get();

  return snap.docs.map(doc => ({
    id: doc.id,
    title: doc.data().title,
    updatedAt: doc.data().updatedAt,
    tags: doc.data().tags || [],
    wordCount: doc.data().content.split(/\s+/).length
  }));
}

async function updateDocument(userId, id, content, title) {
  const snap = await db.collection('documents').doc(id).get();
  if (!snap.exists) return { error: 'Document not found' };

  const data = snap.data();
  if (data.userId !== userId) return { error: 'Unauthorized' };

  const updates = {
    content,
    updatedAt: admin.firestore.Timestamp.now()
  };

  if (title) {
    if (!title.endsWith('.md')) title = title + '.md';
    updates.title = title;
  }

  await db.collection('documents').doc(id).update(updates);

  return {
    id,
    message: `Document updated: ${data.title}`,
    ...updates
  };
}

// MCP Protocol Handler
async function handleToolCall(toolName, toolInput, userId) {
  try {
    switch (toolName) {
      case 'search_documents':
        return {
          type: 'text',
          text: JSON.stringify(
            await searchDocuments(userId, toolInput.query, toolInput.limit, toolInput.tag),
            null,
            2
          )
        };

      case 'get_document':
        const doc = await getDocument(userId, toolInput.id, toolInput.title);
        return {
          type: 'text',
          text: doc ? JSON.stringify(doc, null, 2) : 'Document not found'
        };

      case 'create_document':
        return {
          type: 'text',
          text: JSON.stringify(
            await createDocument(userId, toolInput.title, toolInput.content, toolInput.tags),
            null,
            2
          )
        };

      case 'list_recent':
        return {
          type: 'text',
          text: JSON.stringify(
            await listRecent(userId, toolInput.limit),
            null,
            2
          )
        };

      case 'update_document':
        return {
          type: 'text',
          text: JSON.stringify(
            await updateDocument(userId, toolInput.id, toolInput.content, toolInput.title),
            null,
            2
          )
        };

      default:
        return { type: 'text', text: `Unknown tool: ${toolName}` };
    }
  } catch (error) {
    return {
      type: 'text',
      text: `Error: ${error.message}`
    };
  }
}

// Main MCP Server Loop (stdio)
process.stdin.setEncoding('utf8');

let inputBuffer = '';

process.stdin.on('data', async (chunk) => {
  inputBuffer += chunk;

  // Process complete JSON objects
  let newlineIdx;
  while ((newlineIdx = inputBuffer.indexOf('\n')) !== -1) {
    const line = inputBuffer.slice(0, newlineIdx);
    inputBuffer = inputBuffer.slice(newlineIdx + 1);

    if (!line.trim()) continue;

    try {
      const request = JSON.parse(line);

      // For now, we assume Claude passes userId in the request
      // In production, this would come from auth context
      const userId = request.userId || 'demo-user';

      let response;

      if (request.method === 'tools/list') {
        response = {
          jsonrpc: '2.0',
          id: request.id,
          result: { tools }
        };
      } else if (request.method === 'tools/call') {
        const result = await handleToolCall(
          request.params.name,
          request.params.arguments,
          userId
        );
        response = {
          jsonrpc: '2.0',
          id: request.id,
          result: {
            content: [result]
          }
        };
      } else {
        response = {
          jsonrpc: '2.0',
          id: request.id,
          error: { code: -32601, message: 'Method not found' }
        };
      }

      process.stdout.write(JSON.stringify(response) + '\n');
    } catch (err) {
      console.error('Error processing request:', err.message);
    }
  }
});

process.stdin.on('end', () => {
  process.exit(0);
});

console.error('[em-dash MCP Server] Started. Listening on stdio...');
