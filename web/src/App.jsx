import { useState } from 'react';

const ERROR_MESSAGE = "The copilot couldn't answer just now. Please try again.";
// Reload-and-remember is the C2 demo moment: the agent's memory lives in CockroachDB, not
// in this tab, so all this needs to persist client-side is which conversation to continue.
const CONVERSATION_ID_STORAGE_KEY = 'cafe-copilot:conversationId';

// Shown as clickable chips only while the chat is empty — a running start for a new owner
// who doesn't yet know what the copilot can do.
const SUGGESTED_QUESTIONS = [
  'How was yesterday?',
  'Why was the drawer short on July 4th?',
  'Draft a purchase order for milk and coffee beans',
];

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

  async function sendChatRequest(text) {
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

      setMessages((prev) => [
        ...prev,
        { id: createId(), role: 'assistant', text: data.reply, draft: data.draft ?? null },
      ]);
    } catch {
      setError(ERROR_MESSAGE);
    } finally {
      setIsSending(false);
    }
  }

  function sendMessage(event) {
    event.preventDefault();
    const text = input.trim();
    if (!text || isSending) return;
    sendChatRequest(text);
  }

  function sendSuggestedQuestion(question) {
    if (isSending) return;
    sendChatRequest(question);
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
              <div className="message__stack">
                <span className="message__bubble">{message.text}</span>
                {message.draft && <DraftCard draft={message.draft} />}
              </div>
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

        {messages.length === 0 && !isSending && (
          <div className="suggestions" aria-label="Suggested questions">
            {SUGGESTED_QUESTIONS.map((question) => (
              <button
                key={question}
                type="button"
                className="suggestions__chip"
                onClick={() => sendSuggestedQuestion(question)}
              >
                {question}
              </button>
            ))}
          </div>
        )}

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

// Renders a draft artifact (currently only purchase orders) the agent returned alongside
// its reply. Drafts are never submitted automatically — this card is just "saved for your
// review", matching the copilot's read-only relationship with the POS.
function DraftCard({ draft }) {
  const items = Array.isArray(draft.items) ? draft.items : [];
  return (
    <div className="draft-card">
      <p className="draft-card__title">Purchase order draft</p>
      {draft.supplier && <p className="draft-card__supplier">Supplier: {draft.supplier}</p>}
      <ul className="draft-card__items">
        {items.map((item, index) => (
          <li key={`${item.name}-${index}`}>
            {item.quantity}
            {item.unit ? ` ${item.unit}` : ''} — {item.name}
          </li>
        ))}
      </ul>
      {draft.notes && <p className="draft-card__notes">{draft.notes}</p>}
      <p className="draft-card__status">Saved for your review — nothing has been ordered.</p>
    </div>
  );
}
