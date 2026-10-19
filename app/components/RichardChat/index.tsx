import {
  CheckmarkIcon,
  CloseIcon,
  CopyIcon,
  SparklesIcon,
  WarningIcon,
} from "outline-icons";
import { darken } from "polished";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ChangeEvent, KeyboardEvent as ReactKeyboardEvent } from "react";
import styled, { keyframes } from "styled-components";
import type { DefaultTheme } from "styled-components";
import { depths, s } from "@shared/styles";
import Button from "~/components/Button";
import useStores from "~/hooks/useStores";
import { client } from "~/utils/ApiClient";

/** A single message in the conversation, as stored on the client. */
interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  /** Whether the message represents a failed request, styled apart. */
  isError?: boolean;
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
const POLL_TIMEOUT = 6 * 60 * 1000;

/** Fallback message shown when a request fails without a usable error. */
const GENERIC_ERROR = "Algo salió mal.";

/** Maximum height of the composer textarea, roughly six lines. */
const TEXTAREA_MAX_HEIGHT = 144;

/** Starter prompts shown while the conversation is still empty. */
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
 * Floating chat panel that talks to the Richard agent through the Outline
 * server proxy. Mounted once in the authenticated layout.
 *
 * @returns the floating chat button and its panel.
 */
export function RichardChat() {
  const { documents } = useStores();
  const [isOpen, setIsOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);
  const [listElement, setListElement] = useState<HTMLDivElement | null>(null);
  const [textareaElement, setTextareaElement] = useState<HTMLTextAreaElement | null>(
    null
  );
  const startedAtRef = useRef<number | null>(null);

  const handleToggle = useCallback(() => {
    setIsOpen((open) => !open);
  }, []);

  const handleClose = useCallback(() => {
    setIsOpen(false);
  }, []);

  const handleChange = useCallback((event: ChangeEvent<HTMLTextAreaElement>) => {
    setInput(event.target.value);
  }, []);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setIsOpen(false);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen]);

  // Move focus to the composer when the panel opens.
  useEffect(() => {
    if (isOpen && textareaElement) {
      textareaElement.focus();
    }
  }, [isOpen, textareaElement]);

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

  const appendAssistant = useCallback((content: string, isError = false) => {
    const message: ChatMessage = { role: "assistant", content, isError };
    setMessages((current) => [...current, message]);
  }, []);

  const finishJob = useCallback(() => {
    setJobId(null);
    setIsSending(false);
    startedAtRef.current = null;
  }, []);

  // Keep the latest message in view as the conversation grows.
  useEffect(() => {
    if (listElement) {
      listElement.scrollTop = listElement.scrollHeight;
    }
  }, [listElement, messages, isSending]);

  const startJob = useCallback(
    async (
      history: ChatMessage[],
      documentContext: ChatDocumentContext | null
    ) => {
      setIsSending(true);
      setElapsed(0);
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
        appendAssistant(getErrorMessage(err), true);
        finishJob();
      }
    },
    [appendAssistant, finishJob]
  );

  // Poll the job endpoint until it settles, the panel closes, or it times out.
  useEffect(() => {
    if (!isOpen || !jobId) {
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
        appendAssistant("Richard tardó demasiado en responder. Probá de nuevo.", true);
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
          appendAssistant(answer ?? "", false);
          finishJob();
          return;
        }
        if (status === "error") {
          appendAssistant(error ?? GENERIC_ERROR, true);
          finishJob();
          return;
        }
        timer = window.setTimeout(poll, POLL_INTERVAL);
      } catch (err) {
        if (cancelled) {
          return;
        }
        appendAssistant(getErrorMessage(err), true);
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
  }, [isOpen, jobId, appendAssistant, finishJob]);

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

    const history: ChatMessage[] = [...messages, { role: "user", content }];

    // Read the active document at send time, not during render, so the panel
    // is not subscribed to document changes.
    const active = documents.active;
    const documentContext: ChatDocumentContext | null = active
      ? { title: active.title, documentId: active.id }
      : null;

    setMessages(history);
    setInput("");
    void startJob(history, documentContext);
  }, [input, isSending, messages, documents, startJob]);

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

  const showEmpty = messages.length === 0 && !isSending;

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
                aria-label="Cerrar chat"
                title="Cerrar chat"
                onClick={handleClose}
              >
                <CloseIcon size={18} />
              </IconButton>
            </HeaderActions>
          </PanelHeader>
          <Messages
            ref={setListElement}
            role="log"
            aria-live="polite"
            aria-busy={isSending}
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
            {isSending && (
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
