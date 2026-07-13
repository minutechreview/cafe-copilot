import { useState } from 'react';
import { formatAssistantText } from './format.js';

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

/**
 * Reads a fetch Response's body as Server-Sent Events, calling onEvent with the parsed JSON
 * payload of each `data: ` line as it arrives (not buffered — the caller gets each chunk as
 * soon as it's decoded). Events are separated by a blank line per the SSE wire format.
 */
async function readEventStream(response, onEvent) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let separatorIndex = buffer.indexOf('\n\n');
    while (separatorIndex !== -1) {
      const rawEvent = buffer.slice(0, separatorIndex);
      buffer = buffer.slice(separatorIndex + 2);
      const dataLine = rawEvent.split('\n').find((line) => line.startsWith('data:'));
      if (dataLine) {
        try {
          onEvent(JSON.parse(dataLine.slice('data:'.length).trim()));
        } catch {
          // A malformed event shouldn't take down the rest of the stream.
        }
      }
      separatorIndex = buffer.indexOf('\n\n');
    }
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

  function updateMessage(id, updater) {
    setMessages((prev) => prev.map((message) => (message.id === id ? updater(message) : message)));
  }

  async function sendChatRequest(text) {
    const userMessage = { id: createId(), role: 'user', text };
    const assistantMessageId = createId();
    // Placeholder assistant message, empty until the first delta arrives — that's what
    // drives the "typing" indicator vs. the growing text bubble (see the render below).
    const assistantMessage = { id: assistantMessageId, role: 'assistant', text: '', draft: null };

    setMessages((prev) => [...prev, userMessage, assistantMessage]);
    setInput('');
    setError(null);
    setIsSending(true);

    let sawAnyEvent = false;
    let sawError = false;

    try {
      const response = await fetch('/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, conversationId }),
      });

      if (!response.ok || !response.body) {
        throw new Error(ERROR_MESSAGE);
      }

      await readEventStream(response, (event) => {
        sawAnyEvent = true;
        if (event.type === 'delta') {
          updateMessage(assistantMessageId, (message) => ({ ...message, text: message.text + event.text }));
        } else if (event.type === 'draft') {
          updateMessage(assistantMessageId, (message) => ({ ...message, draft: event.draft }));
        } else if (event.type === 'done') {
          // The done event's reply is the authoritative final text — replaces whatever was
          // accumulated via deltas, so a dropped/out-of-order chunk can't leave the bubble
          // out of sync with what was actually saved to the conversation.
          updateMessage(assistantMessageId, (message) => ({ ...message, text: event.reply }));
          if (event.conversationId && event.conversationId !== conversationId) {
            setConversationId(event.conversationId);
            storeConversationId(event.conversationId);
          }
        } else if (event.type === 'error') {
          sawError = true;
          setError(event.message || ERROR_MESSAGE);
        }
      });

      if (!sawAnyEvent) {
        throw new Error(ERROR_MESSAGE);
      }
      if (sawError) {
        // Nothing useful streamed in — drop the empty placeholder rather than showing a
        // permanently blank bubble alongside the error banner.
        setMessages((prev) =>
          prev.filter((message) => message.id !== assistantMessageId || message.text || message.draft)
        );
      }
    } catch {
      setError(ERROR_MESSAGE);
      setMessages((prev) =>
        prev.filter((message) => message.id !== assistantMessageId || message.text || message.draft)
      );
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
                <MessageBubble message={message} />
                {message.draft && <DraftCard draft={message.draft} />}
              </div>
            </li>
          ))}
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

// User messages render as plain text (React escapes them automatically). Assistant messages
// go through formatAssistantText, which does its own HTML-escaping before applying any
// markdown-ish transform — see format.js for the security reasoning. A still-empty assistant
// message (no delta has arrived yet) shows a typing indicator instead of a blank bubble.
function MessageBubble({ message }) {
  if (message.role === 'user') {
    return <div className="message__bubble">{message.text}</div>;
  }
  if (!message.text) {
    return (
      <div className="message__bubble message__bubble--typing" aria-live="polite">
        Thinking…
      </div>
    );
  }
  return (
    <div
      className="message__bubble"
      dangerouslySetInnerHTML={{ __html: formatAssistantText(message.text) }}
    />
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
