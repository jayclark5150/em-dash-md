/**
 * Claude Integration for em-dash-md
 * Initializes Claude modal and adds button to header
 *
 * Setup:
 * 1. Add this script to index.html after claudeChatModal.js
 * 2. Set API key via: localStorage.setItem('claude_api_key', 'sk-...')
 *    OR in environment variable: window.CLAUDE_API_KEY
 * 3. Update MCP_SERVER_URL if deployed to different endpoint
 */

(function initializeClaudeIntegration() {
  // Configuration
  const MCP_SERVER_URL = 'https://mcp-server-1074234800313.europe-west1.run.app';

  // Get API key from localStorage or environment variable
  function getApiKey() {
    // Try localStorage first (persistent across sessions)
    let apiKey = localStorage.getItem('claude_api_key');
    if (apiKey) return apiKey;

    // Try window variable (can be set by parent app)
    if (window.CLAUDE_API_KEY) return window.CLAUDE_API_KEY;

    // Try environment variable via process.env (build-time)
    if (typeof process !== 'undefined' && process.env && process.env.REACT_APP_CLAUDE_API_KEY) {
      return process.env.REACT_APP_CLAUDE_API_KEY;
    }

    return null;
  }

  // Initialize Claude modal
  function initializeClaudeModal() {
    const apiKey = getApiKey();

    if (!apiKey) {
      console.warn('Claude API key not found. Set it via localStorage.setItem("claude_api_key", "YOUR_KEY")');
      // Still create modal but show prompt for API key
      window.claudeModal = new ClaudeChatModal('', MCP_SERVER_URL);
      window.claudeModalReady = true;
      return;
    }

    window.claudeModal = new ClaudeChatModal(apiKey, MCP_SERVER_URL);
    window.claudeModalReady = true;
  }

  // Create and add Claude button to header
  function addClaudeButtonToHeader() {
    // Wait for DOM to be ready
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', addButton);
    } else {
      addButton();
    }

    function addButton() {
      // Try to find header buttons container
      let buttonContainer = document.getElementById('header-buttons');

      // If not found, try common alternatives
      if (!buttonContainer) {
        buttonContainer = document.querySelector('[data-id="header-buttons"]');
      }
      if (!buttonContainer) {
        buttonContainer = document.querySelector('.header-buttons');
      }
      if (!buttonContainer) {
        buttonContainer = document.querySelector('header');
      }

      if (!buttonContainer) {
        console.warn('Could not find header to add Claude button. Add manually or adjust selector.');
        return;
      }

      // Create Claude button
      const claudeBtn = document.createElement('button');
      claudeBtn.id = 'claude-chat-btn';
      claudeBtn.className = 'header-btn claude-btn';
      claudeBtn.title = 'Ask Claude (Search, create, manage documents)';
      claudeBtn.innerHTML = `
        <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor" style="margin-right: 4px;">
          <path d="M10 0C4.48 0 0 4.48 0 10s4.48 10 10 10 10-4.48 10-10S15.52 0 10 0zm3.5 9c.83 0 1.5-.67 1.5-1.5S14.33 5 13.5 5 12 5.67 12 6.5s.67 1.5 1.5 1.5zm-7 0c.83 0 1.5-.67 1.5-1.5S7.33 5 6.5 5 5 5.67 5 6.5 5.67 8 6.5 8zm3.5 6.5c-2.33 0-4.31-1.46-5.11-3.5h10.22c-.8 2.04-2.78 3.5-5.11 3.5z"/>
        </svg>
        Ask Claude
      `;

      claudeBtn.addEventListener('click', () => {
        if (window.claudeModal) {
          window.claudeModal.openModal();
        }
      });

      // Insert button into header
      buttonContainer.appendChild(claudeBtn);
    }
  }

  // Main initialization flow
  function initialize() {
    // Load CSS if not already loaded
    if (!document.querySelector('link[href*="claude-chat.css"]')) {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = './claude-chat.css'; // Adjust path if needed
      document.head.appendChild(link);
    }

    // Initialize modal
    initializeClaudeModal();

    // Add button to header
    addClaudeButtonToHeader();

    // Make functions available globally for manual API key setup
    window.setClaudeApiKey = function(key) {
      localStorage.setItem('claude_api_key', key);
      if (window.claudeModal) {
        window.claudeModal.apiKey = key;
      }
      console.log('Claude API key set successfully');
    };

    window.clearClaudeApiKey = function() {
      localStorage.removeItem('claude_api_key');
      if (window.claudeModal) {
        window.claudeModal.apiKey = '';
      }
      console.log('Claude API key cleared');
    };

    window.setMcpServerUrl = function(url) {
      if (window.claudeModal) {
        window.claudeModal.mcpServerUrl = url;
      }
      console.log('MCP server URL updated:', url);
    };

    console.log('Claude integration initialized');
    console.log('Available commands:');
    console.log('  - setClaudeApiKey("sk-..."): Set API key');
    console.log('  - clearClaudeApiKey(): Clear API key');
    console.log('  - setMcpServerUrl("https://..."): Change MCP server');
  }

  // Initialize when DOM is ready or immediately if already loaded
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initialize);
  } else {
    initialize();
  }
})();
