import {
  CheckmarkIcon,
  CloseIcon,
  CopyIcon,
  HistoryIcon,
  PlusIcon,
  SparklesIcon,
  TrashIcon,
  WarningIcon,
} from "outline-icons";
import { darken } from "polished";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent, KeyboardEvent as ReactKeyboardEvent } from "react";
import styled, { keyframes } from "styled-components";
import type { DefaultTheme } from "styled-components";
import { depths, s } from "@shared/styles";
import Button from "~/components/Button";
import useStores from "~/hooks/useStores";
import { client } from "~/utils/ApiClient";

/** A single message in a conversation, as stored on the client. */
interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  /** Whether the message represents a failed request, styled apart. */
  isError?: boolean;
}

/** A persisted conversation between the user and Richard. */
interface Conversation {
  id: string;
  title: string;
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
}

/** The document the user is viewing, forwarded alongside the conversation. */
interface ChatDocumentContext {
  title: string;
  documentId: string;
}

/** A starter prompt offered on the empty state of the panel. */
interface Suggestion {
  label: string;
  prompt: string;
}

/** Which surface the panel is currently showing. */
type ChatView = "chat" | "history";

/** The response envelope returned by the `/richard.chat` endpoint. */
interface ChatStartResponse {
  data: {
    jobId: string;
  };
}

/** The lifecycle state of an asynchronous chat job. */
type RichardJobStatus = "pending" | "done" | "error";

/** The response envelope returned by the `/richard.job` endpoint. */
interface ChatJobResponse {
  data: {
    status: RichardJobStatus;
    answer: string | null;
    error: string | null;
    elapsedMs: number;
  };
}

/** How often the client polls the job endpoint, in milliseconds. */
const POLL_INTERVAL = 2000;

/** How long the client waits for the job before showing a timeout, in ms. */
const POLL_TIMEOUT = 16 * 60 * 1000;

/** Fallback message shown when a request fails without a usable error. */
const GENERIC_ERROR = "Algo salió mal.";

/** Local storage key holding the serialized conversation list. */
const CONVERSATIONS_STORAGE_KEY = "richard-chat-conversations";

/** Local storage key holding the id of the conversation in view. */
const ACTIVE_CONVERSATION_STORAGE_KEY = "richard-chat-active-id";

/** How many conversations are kept before the oldest are discarded. */
const MAX_CONVERSATIONS = 20;

/** How many characters of the first user message become the chat title. */
const TITLE_MAX_LENGTH = 40;

/** Title given to a conversation without a user message yet. */
const EMPTY_TITLE = "Conversación nueva";

/** Maximum height of the composer textarea, roughly six lines. */
const TEXTAREA_MAX_HEIGHT = 144;

/** Starter prompts shown when a conversation is still empty. */
const SUGGESTIONS: Suggestion[] = [
  { label: "Resumime este documento", prompt: "Resumime este documento" },
  {
    label: "Listame los pendientes de esta nota",
    prompt: "Listame los pendientes de esta nota",
  },
  { label: "Buscame en mis notas sobre …", prompt: "Buscame en mis notas sobre " },
];

/**
 * Returns a user-facing message for an unknown error thrown by the API client.
 *
 * @param err the thrown error.
 * @returns the error message, or a generic fallback.
 */
function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : GENERIC_ERROR;
}

/**
 * Builds a reasonably unique id without a server round-trip.
 *
 * @returns a short id combining a timestamp and random suffix.
 */
function createId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Creates an empty conversation ready to receive messages.
 *
 * @returns a fresh conversation with an automatic placeholder title.
 */
function createConversation(): Conversation {
  const now = Date.now();
  return {
    id: createId(),
    title: EMPTY_TITLE,
    messages: [],
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Narrows an unknown value to a stored chat message.
 *
 * @param value the parsed value.
 * @returns whether the value is a valid message.
 */
function isChatMessage(value: unknown): value is ChatMessage {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const message = value as Record<string, unknown>;
  return (
    (message.role === "user" || message.role === "assistant") &&
    typeof message.content === "string"
  );
}

/**
 * Narrows an unknown value to a stored conversation.
 *
 * @param value the parsed value.
 * @returns whether the value is a valid conversation.
 */
function isConversation(value: unknown): value is Conversation {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const conversation = value as Record<string, unknown>;
  return (
    typeof conversation.id === "string" &&
    typeof conversation.title === "string" &&
    typeof conversation.createdAt === "number" &&
    typeof conversation.updatedAt === "number" &&
    Array.isArray(conversation.messages) &&
    conversation.messages.every(isChatMessage)
  );
}

/**
 * Reads the persisted conversations, tolerating absent or corrupted storage.
 *
 * @returns the stored conversations, or an empty array.
 */
function loadConversations(): Conversation[] {
  if (typeof window === "undefined") {
    return [];
  }
  try {
    const raw = window.localStorage.getItem(CONVERSATIONS_STORAGE_KEY);
    if (!raw) {
      return [];
    }
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter(isConversation);
  } catch {
    return [];
  }
}

/**
 * Keeps at most {@link MAX_CONVERSATIONS} conversations, newest first.
 *
 * @param conversations the conversations to trim.
 * @returns the newest conversations, capped by count.
 */
function trimConversations(conversations: Conversation[]): Conversation[] {
  return [...conversations]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_CONVERSATIONS);
}

/**
 * Derives a short title from the first user message of a conversation.
 *
 * @param messages the conversation messages.
 * @returns the trimmed title, or the placeholder title when unnamed.
 */
function titleFromMessages(messages: ChatMessage[]): string {
  const firstUser = messages.find((message) => message.role === "user");
  if (!firstUser) {
    return EMPTY_TITLE;
  }
  const trimmed = firstUser.content.trim().replace(/\s+/g, " ");
  if (!trimmed) {
    return EMPTY_TITLE;
  }
  return trimmed.length > TITLE_MAX_LENGTH
    ? `${trimmed.slice(0, TITLE_MAX_LENGTH)}…`
    : trimmed;
}

/**
 * Formats a timestamp as a brief relative label in Spanish.
 *
 * @param timestamp the moment to describe, in milliseconds.
 * @returns a short relative label.
 */
function formatRelativeTime(timestamp: number): string {
  const minutes = Math.floor((Date.now() - timestamp) / 60000);
  if (minutes < 1) {
    return "ahora";
  }
  if (minutes < 60) {
    return `hace ${minutes} min`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `hace ${hours} h`;
  }
  const days = Math.floor(hours / 24);
  if (days < 7) {
    return `hace ${days} d`;
  }
  return new Date(timestamp).toLocaleDateString();
}

/**
 * Resolves the conversation to open on mount, preferring the persisted id.
 *
 * @param conversations the already loaded conversations to validate against.
 * @returns the id of the conversation to make active.
 */
function resolveInitialActiveId(conversations: Conversation[]): string {
  if (typeof window !== "undefined") {
    try {
      const stored = window.localStorage.getItem(ACTIVE_CONVERSATION_STORAGE_KEY);
      if (stored && conversations.some((c) => c.id === stored)) {
        return stored;
      }
    } catch {
      // Fall through to the most recently updated conversation.
    }
  }
  return trimConversations(conversations)[0].id;
}

/**
 * Floating chat panel that talks to the Richard agent through the Outline
 * server proxy. Keeps a client-side history of conversations in local storage.
 * Mounted once in the authenticated layout.
 *
 * @returns the floating chat button and its panel.
 */
export function RichardChat() {
  const { documents } = useStores();
  const [isOpen, setIsOpen] = useState(false);
  const [view, setView] = useState<ChatView>("chat");
  const [conversations, setConversations] = useState<Conversation[]>(() => {
    const stored = loadConversations();
    return stored.length > 0 ? trimConversations(stored) : [createConversation()];
  });
  const [activeId, setActiveId] = useState<string>(() =>
    resolveInitialActiveId(conversations)
  );
  const [input, setInput] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const [jobConversationId, setJobConversationId] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);
  const [listElement, setListElement] = useState<HTMLDivElement | null>(null);
  const [textareaElement, setTextareaElement] = useState<HTMLTextAreaElement | null>(
    null
  );
  const startedAtRef = useRef<number | null>(null);

  const activeConversation = useMemo(
    () =>
      conversations.find((conversation) => conversation.id === activeId) ??
      trimConversations(conversations)[0],
    [conversations, activeId]
  );

  const sortedConversations = useMemo(
    () => trimConversations(conversations),
    [conversations]
  );

  const handleToggle = useCallback(() => {
    setIsOpen((open) => !open);
  }, []);

  const handleClose = useCallback(() => {
    setIsOpen(false);
    setView("chat");
  }, []);

  const handleToggleHistory = useCallback(() => {
    setView((current) => (current === "history" ? "chat" : "history"));
  }, []);

  const handleChange = useCallback((event: ChangeEvent<HTMLTextAreaElement>) => {
    setInput(event.target.value);
  }, []);

  // Persist the conversation list so the thread survives a page reload.
  useEffect(() => {
    try {
      window.localStorage.setItem(
        CONVERSATIONS_STORAGE_KEY,
        JSON.stringify(conversations)
      );
    } catch {
      // Ignore quota or privacy-mode failures; the chat still works in-session.
    }
  }, [conversations]);

  // Persist which conversation was in view, so reloads resume the same thread.
  useEffect(() => {
    try {
      window.localStorage.setItem(ACTIVE_CONVERSATION_STORAGE_KEY, activeId);
    } catch {
      // Ignore storage failures; the panel still works for this session.
    }
  }, [activeId]);

  // Forget the transient "copied" confirmation when switching conversation.
  useEffect(() => {
    setCopiedIndex(null);
  }, [activeId]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        handleClose();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, handleClose]);

  // Move focus to the composer when the panel opens or returns to the thread.
  useEffect(() => {
    if (isOpen && view === "chat" && textareaElement) {
      textareaElement.focus();
    }
  }, [isOpen, view, textareaElement]);

  // Grow the textarea with its content, up to a handful of lines.
  useEffect(() => {
    if (!textareaElement) {
      return;
    }
    textareaElement.style.height = "auto";
    const nextHeight = Math.min(
      textareaElement.scrollHeight,
      TEXTAREA_MAX_HEIGHT
    );
    textareaElement.style.height = `${nextHeight}px`;
  }, [textareaElement, input]);

  const appendAssistant = useCallback(
    (conversationId: string, content: string, isError = false) => {
      const message: ChatMessage = { role: "assistant", content, isError };
      setConversations((current) =>
        current.map((conversation) =>
          conversation.id === conversationId
            ? {
                ...conversation,
                messages: [...conversation.messages, message],
                updatedAt: Date.now(),
              }
            : conversation
        )
      );
    },
    []
  );

  const finishJob = useCallback(() => {
    setJobId(null);
    setJobConversationId(null);
    setIsSending(false);
    startedAtRef.current = null;
  }, []);

  const isThinkingHere =
    isSending && jobConversationId === activeConversation.id;

  // Keep the latest message in view as the conversation grows.
  useEffect(() => {
    if (listElement) {
      listElement.scrollTop = listElement.scrollHeight;
    }
  }, [listElement, activeConversation, isThinkingHere]);

  const startJob = useCallback(
    async (
      history: ChatMessage[],
      documentContext: ChatDocumentContext | null,
      conversationId: string
    ) => {
      setIsSending(true);
      setElapsed(0);
      setJobConversationId(conversationId);
      startedAtRef.current = Date.now();
      try {
        const response = await client.post<ChatStartResponse>("/richard.chat", {
          messages: history.map((message) => ({
            role: message.role,
            content: message.content,
          })),
          documentContext,
        });
        setJobId(response.data.jobId);
      } catch (err) {
        appendAssistant(conversationId, getErrorMessage(err), true);
        finishJob();
      }
    },
    [appendAssistant, finishJob]
  );

  // Poll the job endpoint until it settles, the panel closes, or it times out.
  // The answer is written back to the conversation that launched the job, so
  // switching threads mid-flight never mixes a reply into the wrong chat.
  useEffect(() => {
    if (!isOpen || !jobId || !jobConversationId) {
      return;
    }

    let cancelled = false;
    let timer: number | undefined;

    const poll = async () => {
      if (cancelled) {
        return;
      }

      const startedAt = startedAtRef.current;
      if (startedAt !== null && Date.now() - startedAt > POLL_TIMEOUT) {
        appendAssistant(
          jobConversationId,
          "Richard tardó más de 16 minutos. Puede que el cambio ya esté hecho: revisá el documento, o probá de nuevo.",
          true
        );
        finishJob();
        return;
      }

      try {
        const response = await client.get<ChatJobResponse>("/richard.job", {
          id: jobId,
        });
        if (cancelled) {
          return;
        }

        const { status, answer, error } = response.data;
        if (status === "done") {
          appendAssistant(jobConversationId, answer ?? "", false);
          finishJob();
          return;
        }
        if (status === "error") {
          appendAssistant(jobConversationId, error ?? GENERIC_ERROR, true);
          finishJob();
          return;
        }
        timer = window.setTimeout(poll, POLL_INTERVAL);
      } catch (err) {
        if (cancelled) {
          return;
        }
        appendAssistant(jobConversationId, getErrorMessage(err), true);
        finishJob();
      }
    };

    timer = window.setTimeout(poll, POLL_INTERVAL);

    return () => {
      cancelled = true;
      if (timer !== undefined) {
        window.clearTimeout(timer);
      }
    };
  }, [isOpen, jobId, jobConversationId, appendAssistant, finishJob]);

  // Track the elapsed seconds while a job is in flight, for the wait label.
  useEffect(() => {
    if (!isOpen || !jobId) {
      return;
    }

    const interval = window.setInterval(() => {
      if (startedAtRef.current !== null) {
        setElapsed(Math.floor((Date.now() - startedAtRef.current) / 1000));
      }
    }, 1000);

    return () => window.clearInterval(interval);
  }, [isOpen, jobId]);

  const handleSubmit = useCallback(() => {
    const content = input.trim();
    if (!content || isSending) {
      return;
    }

    const conversationId = activeConversation.id;
    const userMessage: ChatMessage = { role: "user", content };

    // The full history is resent on every turn because the server derives the
    // session from the first message of the list: sending only the latest
    // turns would start a brand new session instead of continuing this one.
    const history: ChatMessage[] = [...activeConversation.messages, userMessage];

    setConversations((current) =>
      current.map((conversation) =>
        conversation.id === conversationId
          ? {
              ...conversation,
              title: titleFromMessages(history),
              messages: history,
              updatedAt: Date.now(),
            }
          : conversation
      )
    );

    // Read the active document at send time, not during render, so the panel
    // is not subscribed to document changes.
    const active = documents.active;
    const documentContext: ChatDocumentContext | null = active
      ? { title: active.title, documentId: active.id }
      : null;

    setInput("");
    void startJob(history, documentContext, conversationId);
  }, [input, isSending, activeConversation, documents, startJob]);

  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        handleSubmit();
      }
    },
    [handleSubmit]
  );

  const handleSuggestion = useCallback(
    (prompt: string) => {
      setInput(prompt);
      textareaElement?.focus();
    },
    [textareaElement]
  );

  const handleCopy = useCallback(async (index: number, content: string) => {
    try {
      await navigator.clipboard.writeText(content);
      setCopiedIndex(index);
      window.setTimeout(() => {
        setCopiedIndex((current) => (current === index ? null : current));
      }, 1600);
    } catch {
      // The clipboard is unavailable outside a secure context; stay silent.
    }
  }, []);

  const handleNewChat = useCallback(() => {
    setView("chat");
    setInput("");

    // Reuse the current thread if it is already blank, so "New chat" pressed
    // twice does not pile up empty conversations.
    if (activeConversation.messages.length === 0) {
      return;
    }

    const conversation = createConversation();
    setConversations((current) =>
      trimConversations([conversation, ...current])
    );
    setActiveId(conversation.id);
  }, [activeConversation]);

  const handleSelectConversation = useCallback((id: string) => {
    setActiveId(id);
    setView("chat");
  }, []);

  const handleDeleteConversation = useCallback(
    (id: string) => {
      const remaining = conversations.filter(
        (conversation) => conversation.id !== id
      );

      if (remaining.length === 0) {
        const conversation = createConversation();
        setConversations([conversation]);
        setActiveId(conversation.id);
        return;
      }

      setConversations(remaining);

      if (activeId === id) {
        setActiveId(trimConversations(remaining)[0].id);
      }
    },
    [conversations, activeId]
  );

  const messages = activeConversation.messages;
  const showEmpty = messages.length === 0 && !isThinkingHere;
  const hasHistory = sortedConversations.some(
    (conversation) => conversation.messages.length > 0
  );

  return (
    <>
      <ToggleButton
        type="button"
        aria-label="Hablar con Richard"
        aria-expanded={isOpen}
        onClick={handleToggle}
      >
        <SparklesIcon size={24} />
      </ToggleButton>
      {isOpen && (
        <Panel role="dialog" aria-label="Richard">
          <PanelHeader>
            <HeaderIdentity>
              <HeaderIcon aria-hidden="true">
                <SparklesIcon size={18} />
              </HeaderIcon>
              <PanelTitle>Richard</PanelTitle>
            </HeaderIdentity>
            <HeaderActions>
              <IconButton
                type="button"
                aria-label="Nuevo chat"
                title="Nuevo chat"
                onClick={handleNewChat}
              >
                <PlusIcon size={18} />
              </IconButton>
              <IconButton
                type="button"
                aria-label="Historial de conversaciones"
                title="Historial de conversaciones"
                aria-pressed={view === "history"}
                onClick={handleToggleHistory}
              >
                <HistoryIcon size={18} />
              </IconButton>
              <IconButton
                type="button"
                aria-label="Cerrar chat"
                title="Cerrar chat"
                onClick={handleClose}
              >
                <CloseIcon size={18} />
              </IconButton>
            </HeaderActions>
          </PanelHeader>

          {view === "history" ? (
            <HistoryList aria-label="Conversaciones anteriores">
              {!hasHistory && (
                <HistoryEmpty>
                  Todavía no tenés conversaciones guardadas. Van a aparecer acá a
                  medida que charles con Richard.
                </HistoryEmpty>
              )}
              {sortedConversations
                .filter((conversation) => conversation.messages.length > 0)
                .map((conversation) => (
                  <HistoryItem
                    key={conversation.id}
                    $active={conversation.id === activeConversation.id}
                  >
                    <HistorySelect
                      type="button"
                      onClick={() => handleSelectConversation(conversation.id)}
                      aria-label={`Abrir conversación: ${conversation.title}`}
                    >
                      <HistoryTitle>{conversation.title}</HistoryTitle>
                      <HistoryMeta>
                        {formatRelativeTime(conversation.updatedAt)}
                      </HistoryMeta>
                    </HistorySelect>
                    <HistoryDelete
                      type="button"
                      aria-label={`Borrar conversación: ${conversation.title}`}
                      onClick={() => handleDeleteConversation(conversation.id)}
                    >
                      <TrashIcon size={15} />
                    </HistoryDelete>
                  </HistoryItem>
                ))}
            </HistoryList>
          ) : (
            <>
              <Messages
                ref={setListElement}
                role="log"
                aria-live="polite"
                aria-busy={isThinkingHere}
              >
                {showEmpty && (
                  <EmptyState>
                    <EmptyIcon aria-hidden="true">
                      <SparklesIcon size={22} />
                    </EmptyIcon>
                    <EmptyTitle>¿En qué te ayudo?</EmptyTitle>
                    <EmptyText>
                      Escribí una consulta o arrancá con una de estas ideas.
                    </EmptyText>
                    <SuggestionList>
                      {SUGGESTIONS.map((suggestion) => (
                        <SuggestionChip
                          key={suggestion.label}
                          type="button"
                          onClick={() => handleSuggestion(suggestion.prompt)}
                        >
                          {suggestion.label}
                        </SuggestionChip>
                      ))}
                    </SuggestionList>
                  </EmptyState>
                )}
                {messages.map((message, index) => (
                  <MessageRow key={index} $role={message.role}>
                    <MessageBubble $role={message.role} $error={message.isError}>
                      {message.role === "assistant" && (
                        <MessageRole>
                          <SparklesIcon size={13} />
                          Richard
                        </MessageRole>
                      )}
                      {message.isError ? (
                        <ErrorLine>
                          <WarningIcon size={15} />
                          <MessageText>{message.content}</MessageText>
                        </ErrorLine>
                      ) : (
                        <MessageText>{message.content}</MessageText>
                      )}
                    </MessageBubble>
                    {message.role === "assistant" && !message.isError && (
                      <CopyButton
                        type="button"
                        aria-label={
                          copiedIndex === index ? "Copiado" : "Copiar respuesta"
                        }
                        onClick={() => handleCopy(index, message.content)}
                      >
                        {copiedIndex === index ? (
                          <>
                            <CheckmarkIcon size={14} />
                            Copiado
                          </>
                        ) : (
                          <CopyIcon size={14} />
                        )}
                      </CopyButton>
                    )}
                  </MessageRow>
                ))}
                {isThinkingHere && (
                  <MessageRow $role="assistant">
                    <MessageBubble $role="assistant">
                      <MessageRole>
                        <SparklesIcon size={13} />
                        Richard
                      </MessageRole>
                      <ThinkingLine>
                        <Dots aria-hidden="true">
                          <Dot $delay={0} />
                          <Dot $delay={160} />
                          <Dot $delay={320} />
                        </Dots>
                        <ThinkingSeconds>{elapsed}s</ThinkingSeconds>
                      </ThinkingLine>
                      {elapsed >= 30 && (
                        <ThinkingHint>
                          Si tengo que buscar en internet o editar un documento,
                          puede tardar varios minutos.
                        </ThinkingHint>
                      )}
                    </MessageBubble>
                  </MessageRow>
                )}
              </Messages>
              <Composer>
                <Textarea
                  ref={setTextareaElement}
                  aria-label="Mensaje para Richard"
                  placeholder="Escribí un mensaje…"
                  rows={1}
                  value={input}
                  onChange={handleChange}
                  onKeyDown={handleKeyDown}
                />
                <ComposerFooter>
                  <ShortcutHint>Ctrl/Cmd + Enter para enviar</ShortcutHint>
                  <Button
                    type="button"
                    onClick={handleSubmit}
                    disabled={isSending || input.trim() === ""}
                  >
                    Enviar
                  </Button>
                </ComposerFooter>
              </Composer>
            </>
          )}
        </Panel>
      )}
    </>
  );
}

const panelEnter = keyframes`
  from {
    opacity: 0;
    transform: translateY(8px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
`;

const buttonEnter = keyframes`
  from {
    opacity: 0;
    transform: scale(0.8);
  }
  to {
    opacity: 1;
    transform: scale(1);
  }
`;

const dotPulse = keyframes`
  0%,
  80%,
  100% {
    opacity: 0.25;
    transform: translateY(0);
  }
  40% {
    opacity: 1;
    transform: translateY(-2px);
  }
`;

const themedScrollbar = (props: { theme: DefaultTheme }): string => `
  scrollbar-width: thin;
  scrollbar-color: ${props.theme.divider} transparent;

  &::-webkit-scrollbar {
    width: 8px;
  }

  &::-webkit-scrollbar-track {
    background: transparent;
  }

  &::-webkit-scrollbar-thumb {
    background: ${props.theme.divider};
    border-radius: 8px;
  }

  &::-webkit-scrollbar-thumb:hover {
    background: ${props.theme.scrollbarThumb};
  }
`;

const ToggleButton = styled.button`
  position: fixed;
  inset-block-end: 20px;
  inset-inline-end: 20px;
  z-index: ${depths.overlay};
  display: flex;
  align-items: center;
  justify-content: center;
  width: 52px;
  height: 52px;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: ${s("accent")};
  color: ${s("accentText")};
  cursor: var(--pointer);
  box-shadow: rgba(0, 0, 0, 0.2) 0 2px 8px;
  animation: ${buttonEnter} 200ms cubic-bezier(0.16, 1, 0.3, 1);
  transition: transform 140ms ease-out, box-shadow 140ms ease-out,
    background 140ms ease-out;

  &:hover {
    background: ${(props) => darken(0.05, props.theme.accent)};
    box-shadow: rgba(0, 0, 0, 0.25) 0 4px 12px;
  }

  &:active {
    transform: scale(0.94);
  }

  &:focus-visible {
    outline: 2px solid ${s("inputBorderFocused")};
    outline-offset: 3px;
  }

  @media (prefers-reduced-motion: reduce) {
    animation: none;
    transition: none;
  }
`;

const Panel = styled.div`
  position: fixed;
  inset-block-end: 84px;
  inset-inline-end: 20px;
  z-index: ${depths.overlay};
  display: flex;
  flex-direction: column;
  width: 400px;
  max-width: calc(100vw - 40px);
  height: 62vh;
  max-height: 660px;
  overflow: hidden;
  background: ${s("background")};
  border: 1px solid ${s("divider")};
  border-radius: 14px;
  box-shadow: rgba(0, 0, 0, 0.25) 0 8px 32px;
  animation: ${panelEnter} 180ms cubic-bezier(0.16, 1, 0.3, 1);

  @media (prefers-reduced-motion: reduce) {
    animation: none;
  }
`;

const PanelHeader = styled.header`
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 14px 12px 16px;
  border-bottom: 1px solid ${s("divider")};
`;

const HeaderIdentity = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
`;

const HeaderIcon = styled.span`
  display: flex;
  align-items: center;
  color: ${s("accent")};
`;

const PanelTitle = styled.h2`
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  color: ${s("text")};
`;

const HeaderActions = styled.div`
  display: flex;
  align-items: center;
  gap: 2px;
`;

const IconButton = styled.button`
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  padding: 0;
  border: 0;
  border-radius: 6px;
  background: none;
  color: ${s("textSecondary")};
  cursor: var(--pointer);
  transition: background 120ms ease-out, color 120ms ease-out;

  &:hover {
    background: ${s("backgroundSecondary")};
    color: ${s("text")};
  }

  &:active {
    transform: scale(0.94);
  }

  &[aria-pressed="true"] {
    background: ${s("backgroundSecondary")};
    color: ${s("accent")};
  }

  &:focus-visible {
    outline: 2px solid ${s("inputBorderFocused")};
    outline-offset: 2px;
  }

  &:disabled {
    color: ${s("textTertiary")};
    cursor: default;
  }
`;

const Messages = styled.div`
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 18px 16px;
  overflow-y: auto;
  ${themedScrollbar}

  &::selection {
    background: ${s("accent")};
    color: ${s("accentText")};
  }
`;

const EmptyState = styled.div`
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 24px 8px;
  text-align: center;
`;

const EmptyIcon = styled.span`
  display: flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  margin-bottom: 4px;
  border-radius: 50%;
  background: ${s("backgroundSecondary")};
  color: ${s("accent")};
`;

const EmptyTitle = styled.p`
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  color: ${s("text")};
`;

const EmptyText = styled.p`
  margin: 0;
  max-width: 240px;
  font-size: 13px;
  line-height: 1.5;
  color: ${s("textSecondary")};
`;

const SuggestionList = styled.div`
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 8px;
  margin-top: 12px;
`;

const SuggestionChip = styled.button`
  padding: 6px 12px;
  border: 1px solid ${s("divider")};
  border-radius: 999px;
  background: none;
  color: ${s("text")};
  font-size: 12px;
  cursor: var(--pointer);
  transition: background 120ms ease-out, border-color 120ms ease-out;

  &:hover {
    background: ${s("backgroundSecondary")};
    border-color: ${s("inputBorderFocused")};
  }

  &:active {
    transform: scale(0.97);
  }

  &:focus-visible {
    outline: 2px solid ${s("inputBorderFocused")};
    outline-offset: 2px;
  }
`;

const CopyButton = styled.button`
  display: flex;
  align-items: center;
  gap: 4px;
  margin-top: 3px;
  padding: 2px 6px;
  border: 0;
  border-radius: 6px;
  background: none;
  color: ${s("textSecondary")};
  font-size: 11px;
  cursor: var(--pointer);
  opacity: 0;
  transition: opacity 120ms ease-out, background 120ms ease-out,
    color 120ms ease-out;

  &:hover {
    background: ${s("backgroundSecondary")};
    color: ${s("text")};
  }

  &:active {
    transform: scale(0.96);
  }

  &:focus-visible {
    opacity: 1;
    outline: 2px solid ${s("inputBorderFocused")};
    outline-offset: 2px;
  }
`;

const MessageRow = styled.div<{ $role: "user" | "assistant" }>`
  display: flex;
  flex-direction: column;
  align-self: ${(props) =>
    props.$role === "user" ? "flex-end" : "flex-start"};
  align-items: ${(props) =>
    props.$role === "user" ? "flex-end" : "flex-start"};
  max-width: 85%;

  &:hover ${CopyButton},
  &:focus-within ${CopyButton} {
    opacity: 1;
  }
`;

const MessageBubble = styled.div<{
  $role: "user" | "assistant";
  $error?: boolean;
}>`
  max-width: 100%;
  padding: 9px 12px;
  border: 1px solid transparent;
  border-radius: 12px;
  font-size: 14px;
  line-height: 1.5;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  background: ${(props) =>
    props.$role === "user"
      ? props.theme.accent
      : props.theme.backgroundSecondary};
  color: ${(props) =>
    props.$role === "user" ? props.theme.accentText : props.theme.text};

  ${(props) => props.$error && `border-color: ${props.theme.danger};`}

  &::selection {
    background: ${s("accent")};
    color: ${s("accentText")};
  }

  ${(props) =>
    props.$role === "user" &&
    `&::selection {
      background: ${props.theme.accentText};
      color: ${props.theme.accent};
    }`}
`;

const MessageRole = styled.span`
  display: flex;
  align-items: center;
  gap: 4px;
  margin-bottom: 5px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.02em;
  text-transform: uppercase;
  color: ${s("textSecondary")};
`;

const MessageText = styled.span`
  font-size: 14px;
  line-height: 1.5;
`;

const ErrorLine = styled.span`
  display: flex;
  align-items: flex-start;
  gap: 6px;

  svg {
    flex-shrink: 0;
    margin-top: 2px;
    color: ${s("danger")};
    fill: ${s("danger")};
  }
`;

const ThinkingLine = styled.div`
  display: flex;
  align-items: center;
  gap: 10px;
`;

const Dots = styled.span`
  display: inline-flex;
  align-items: center;
  gap: 4px;
`;

const Dot = styled.span<{ $delay: number }>`
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: ${s("textSecondary")};
  animation: ${dotPulse} 1200ms ease-in-out infinite;
  animation-delay: ${(props) => props.$delay}ms;

  @media (prefers-reduced-motion: reduce) {
    animation: none;
  }
`;

const ThinkingSeconds = styled.span`
  font-size: 12px;
  color: ${s("textSecondary")};
  font-variant-numeric: tabular-nums;
`;

const ThinkingHint = styled.p`
  margin: 8px 0 0;
  font-size: 12px;
  line-height: 1.45;
  color: ${s("textSecondary")};
`;

const HistoryList = styled.ul`
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 0;
  padding: 14px 12px;
  list-style: none;
  overflow-y: auto;
  ${themedScrollbar}
`;

const HistoryEmpty = styled.li`
  padding: 24px 12px;
  color: ${s("textSecondary")};
  font-size: 13px;
  line-height: 1.5;
  text-align: center;
`;

const HistoryItem = styled.li<{ $active: boolean }>`
  display: flex;
  align-items: center;
  gap: 2px;
  border: 1px solid
    ${(props) =>
      props.$active ? props.theme.inputBorderFocused : "transparent"};
  border-radius: 8px;
  background: ${(props) =>
    props.$active ? props.theme.backgroundSecondary : "transparent"};
  transition: background 120ms ease-out;

  &:hover {
    background: ${s("backgroundSecondary")};
  }
`;

const HistorySelect = styled.button`
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 9px 10px;
  border: 0;
  border-radius: 8px;
  background: none;
  text-align: start;
  cursor: var(--pointer);

  &:focus-visible {
    outline: 2px solid ${s("inputBorderFocused")};
    outline-offset: -2px;
  }
`;

const HistoryTitle = styled.span`
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-size: 13px;
  font-weight: 500;
  color: ${s("text")};
`;

const HistoryMeta = styled.span`
  font-size: 11px;
  color: ${s("textSecondary")};
`;

const HistoryDelete = styled.button`
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 30px;
  height: 30px;
  margin-inline-end: 4px;
  padding: 0;
  border: 0;
  border-radius: 6px;
  background: none;
  color: ${s("textSecondary")};
  cursor: var(--pointer);

  &:hover {
    background: ${s("divider")};
    color: ${s("text")};
  }

  &:active {
    transform: scale(0.94);
  }

  &:focus-visible {
    outline: 2px solid ${s("inputBorderFocused")};
    outline-offset: 2px;
  }
`;

const Composer = styled.div`
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 16px 14px;
  border-top: 1px solid ${s("divider")};
`;

const Textarea = styled.textarea`
  width: 100%;
  min-height: 40px;
  max-height: ${TEXTAREA_MAX_HEIGHT}px;
  padding: 8px 10px;
  border: 1px solid ${s("inputBorder")};
  border-radius: 8px;
  background: ${s("background")};
  color: ${s("text")};
  font-family: inherit;
  font-size: 14px;
  line-height: 1.5;
  resize: none;
  overflow-y: auto;
  outline: none;
  transition: border-color 120ms ease-out, box-shadow 120ms ease-out;
  ${themedScrollbar}

  &:focus {
    border-color: ${s("inputBorderFocused")};
  }

  &:focus-visible {
    outline: 2px solid ${s("inputBorderFocused")};
    outline-offset: 1px;
  }

  &::placeholder {
    color: ${s("placeholder")};
  }
`;

const ComposerFooter = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
`;

const ShortcutHint = styled.span`
  font-size: 11px;
  color: ${s("textSecondary")};
`;
