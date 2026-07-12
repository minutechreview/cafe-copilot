import { useState } from 'react';

const ERROR_MESSAGE = "The copilot couldn't answer just now. Please try again.";
// Reload-and-remember is the C2 demo moment: the agent's memory lives in CockroachDB, not
// in this tab, so all this needs to persist client-side is which conversation to continue.
const CONVERSATION_ID_STORAGE_KEY = 'cafe-copilot:conversationId';

function createId() {
  return typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `id-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function readStoredConversationId() {
  try {
    return window.localStorage.getItem(CONVERSATION_ID_STORAGE_KEY) || null;
  } catch {
    // Private browsing / storage disabled — fall back to a fresh conversation each load.
    return null;
  }
}

function storeConversationId(id) {
  try {
    window.localStorage.setItem(CONVERSATION_ID_STORAGE_KEY, id);
  } catch {
    // Nothing we can do if storage is unavailable; the chat still works for this tab.
  }
}

export default function App() {
  // Null (not a freshly generated id) until either localStorage or the server hands us a
  // real conversation id — the server is the source of truth for when a conversation exists.
  const [conversationId, setConversationId] = useState(readStoredConversationId);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState(null);

  async function sendMessage(event) {
    event.preventDefault();
    const text = input.trim();
    if (!text || isSending) return;

    const userMessage = { id: createId(), role: 'user', text };
    setMessages((prev) => [...prev, userMessage]);
    setInput('');
    setError(null);
    setIsSending(true);

    try {
      const response = await fetch('/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, conversationId }),
      });

      const data = await response.json().catch(() => null);

      if (!response.ok || !data?.reply) {
        throw new Error(data?.error || ERROR_MESSAGE);
      }

      if (data.conversationId && data.conversationId !== conversationId) {
        setConversationId(data.conversationId);
        storeConversationId(data.conversationId);
      }

      setMessages((prev) => [...prev, { id: createId(), role: 'assistant', text: data.reply }]);
    } catch {
      setError(ERROR_MESSAGE);
    } finally {
      setIsSending(false);
    }
  }

  return (
    <div className="page">
      <header className="header">
        <h1>Cafe Copilot</h1>
        <p>Ask about your cafe&apos;s day-to-day — plain answers, no jargon.</p>
      </header>

      <main className="chat">
        <ul className="message-list">
          {messages.map((message) => (
            <li key={message.id} className={`message message--${message.role}`}>
              <span className="message__bubble">{message.text}</span>
            </li>
          ))}
          {isSending && (
            <li className="message message--assistant">
              <span className="message__bubble message__bubble--typing" aria-live="polite">
                Thinking…
              </span>
            </li>
          )}
        </ul>

        {error && (
          <div className="error-banner" role="alert">
            {error}
          </div>
        )}

        <form className="composer" onSubmit={sendMessage}>
          <input
            type="text"
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder="Ask something, e.g. How was today?"
            disabled={isSending}
            aria-label="Message"
          />
          <button type="submit" disabled={isSending || !input.trim()}>
            Send
          </button>
        </form>
      </main>
    </div>
  );
}
