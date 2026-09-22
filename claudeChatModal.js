/**
 * Claude Chat Modal for em-dash-md
 * Provides a modal interface for searching and creating documents with Claude
 */

class ClaudeChatModal {
  constructor(apiKey, mcpServerUrl = 'https://mcp-server-1074234800313.europe-west1.run.app') {
    this.apiKey = apiKey;
    this.mcpServerUrl = mcpServerUrl;
    this.conversationHistory = [];
    this.requestId = 1;
    this.isWaitingForResponse = false;

    this.createModal();
    this.attachEventListeners();
  }

  createModal() {
    // Create modal HTML
    const modalHTML = `
      <div id="claude-chat-modal" class="modal-backdrop">
        <div class="claude-chat-container">
          <div class="claude-chat-header">
            <h3>Ask Claude</h3>
            <button class="claude-chat-close" id="claude-chat-close-btn">✕</button>
          </div>

          <div class="claude-chat-messages" id="claude-chat-messages">
            <div class="claude-message welcome">
              <p><strong>Claude Assistant</strong></p>
              <p>Hi! I can help you search and manage your em-dash documents. Try asking:</p>
              <ul>
                <li>"Search for documents about RDS farm"</li>
                <li>"Create a document called 'Notes.md' with content about..."</li>
                <li>"List my recent documents"</li>
              </ul>
            </div>
          </div>

          <div class="claude-chat-input-area">
            <input
              type="text"
              id="claude-chat-input"
              class="claude-chat-input"
              placeholder="Ask Claude to search or create documents…"
              autocomplete="off"
            />
            <button id="claude-chat-send-btn" class="claude-chat-send-btn" title="Send (Enter)">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                <path d="M1.5 1.5a.5.5 0 0 1 .707 0l11 11a.5.5 0 0 1-.707.707l-11-11a.5.5 0 0 1 0-.707Z"/>
                <path d="M8 2a.5.5 0 0 1 .5.5v10a.5.5 0 0 1-1 0v-10A.5.5 0 0 1 8 2Z"/>
              </svg>
            </button>
          </div>
        </div>
      </div>
    `;

    // Insert modal into DOM if not already present
    if (!document.getElementById('claude-chat-modal')) {
      const div = document.createElement('div');
      div.innerHTML = modalHTML;
      document.body.appendChild(div.firstElementChild);
    }
  }

  attachEventListeners() {
    const closeBtn = document.getElementById('claude-chat-close-btn');
    const sendBtn = document.getElementById('claude-chat-send-btn');
    const input = document.getElementById('claude-chat-input');
    const modal = document.getElementById('claude-chat-modal');

    closeBtn.addEventListener('click', () => this.closeModal());
    sendBtn.addEventListener('click', () => this.sendMessage());
    input.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') this.sendMessage();
    });

    // Close modal when clicking backdrop
    modal.addEventListener('click', (e) => {
      if (e.target === modal) this.closeModal();
    });
  }

  openModal() {
    const modal = document.getElementById('claude-chat-modal');
    modal.style.display = 'flex';
  }

  closeModal() {
    const modal = document.getElementById('claude-chat-modal');
    modal.style.display = 'none';
  }

  async sendMessage() {
    const input = document.getElementById('claude-chat-input');
    const message = input.value.trim();

    if (!message || this.isWaitingForResponse) return;

    // Add user message to chat
    this.addMessage('user', message);
    input.value = '';

    // Set waiting state
    this.isWaitingForResponse = true;
    this.addMessage('assistant', '⏳ Processing...');

    try {
      // Call Claude API
      const response = await this.callClaudeAPI(message);

      // Remove the "Processing..." message
      this.removeLastMessage();

      // Add Claude's response
      this.addMessage('assistant', response);

      // Extract any tool calls Claude wants to make
      await this.handleToolCalls(message);
    } catch (error) {
      this.removeLastMessage();
      this.addMessage('assistant', `❌ Error: ${error.message}`);
      console.error('Claude Chat Error:', error);
    } finally {
      this.isWaitingForResponse = false;
    }
  }

  async callClaudeAPI(userMessage) {
    // Add to conversation history
    this.conversationHistory.push({
      role: 'user',
      content: userMessage
    });

    const systemPrompt = `You are a helpful assistant for the em-dash markdown editor. You help users search, create, and manage their markdown documents.

Available tools (via MCP server at ${this.mcpServerUrl}):
1. search_documents(query, limit, tag) - Search documents
2. get_document(id or title) - Fetch a specific document
3. create_document(title, content, tags) - Create a new document
4. list_recent(limit) - List recently updated documents
5. update_document(id, content, title) - Update a document

When the user asks to search, create, or list documents, tell them you'll search their documents and call the appropriate MCP tool.`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 1024,
        system: systemPrompt,
        messages: this.conversationHistory
      })
    });

    if (!response.ok) {
      throw new Error(`Claude API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    const assistantMessage = data.content[0].text;

    // Add to conversation history
    this.conversationHistory.push({
      role: 'assistant',
      content: assistantMessage
    });

    return assistantMessage;
  }

  async handleToolCalls(userMessage) {
    // Detect if Claude should call MCP tools based on the user's message
    const messageLower = userMessage.toLowerCase();

    if (messageLower.includes('search')) {
      const query = userMessage.replace(/search|for|documents|about/gi, '').trim();
      if (query) {
        await this.callMCPTool('search_documents', { query, limit: 10 });
      }
    } else if (messageLower.includes('create') || messageLower.includes('new')) {
      // This would require more user input, so we just prompt
      this.addMessage('assistant', 'To create a document, please provide the title and content.');
    } else if (messageLower.includes('list') || messageLower.includes('recent')) {
      await this.callMCPTool('list_recent', { limit: 10 });
    }
  }

  async callMCPTool(toolName, args) {
    try {
      const request = {
        jsonrpc: '2.0',
        id: this.requestId++,
        method: 'tools/call',
        params: {
          name: toolName,
          arguments: args
        }
      };

      const response = await fetch(`${this.mcpServerUrl}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(request)
      });

      if (!response.ok) {
        throw new Error(`MCP server error: ${response.status}`);
      }

      const data = await response.json();

      if (data.result && data.result.content) {
        const resultText = data.result.content[0].text;
        const results = JSON.parse(resultText);

        if (results.length > 0) {
          this.addMessage('assistant', this.formatResults(toolName, results));
        } else {
          this.addMessage('assistant', `No results found for ${toolName}.`);
        }
      }
    } catch (error) {
      this.addMessage('assistant', `❌ Tool call failed: ${error.message}`);
      console.error('MCP Tool Error:', error);
    }
  }

  formatResults(toolName, results) {
    if (toolName === 'search_documents') {
      if (results.length === 0) return 'No documents found matching your search.';

      let output = `Found ${results.length} document(s):\n\n`;
      results.forEach(doc => {
        output += `📄 <strong>${doc.title}</strong>\n`;
        if (doc.snippet) {
          output += `   "${doc.snippet.substring(0, 100)}…"\n`;
        }
        output += '\n';
      });
      return output;
    } else if (toolName === 'list_recent') {
      if (results.length === 0) return 'No recent documents found.';

      let output = `Recent documents:\n\n`;
      results.forEach(doc => {
        output += `📄 ${doc.title} (${doc.wordCount} words)\n`;
      });
      return output;
    }

    return JSON.stringify(results, null, 2);
  }

  addMessage(role, content) {
    const messagesDiv = document.getElementById('claude-chat-messages');
    const messageEl = document.createElement('div');
    messageEl.className = `claude-message ${role}`;

    if (role === 'user') {
      messageEl.innerHTML = `<p><strong>You</strong></p><p>${this.escapeHTML(content)}</p>`;
    } else {
      messageEl.innerHTML = `<p><strong>Claude</strong></p><p>${content}</p>`;
    }

    messagesDiv.appendChild(messageEl);
    messagesDiv.scrollTop = messagesDiv.scrollHeight;
  }

  removeLastMessage() {
    const messagesDiv = document.getElementById('claude-chat-messages');
    const messages = messagesDiv.querySelectorAll('.claude-message');
    if (messages.length > 0) {
      messages[messages.length - 1].remove();
    }
  }

  escapeHTML(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
}

// Initialize and export
window.ClaudeChatModal = ClaudeChatModal;
