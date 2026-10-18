import { useCallback, useEffect, useState } from "react";
import type { ChangeEvent, KeyboardEvent as ReactKeyboardEvent } from "react";
import styled from "styled-components";
import { depths, s } from "@shared/styles";
import Button from "~/components/Button";
import { client } from "~/utils/ApiClient";

/** A single message in the conversation, as stored on the client. */
interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

/** The response envelope returned by the `/richard.chat` endpoint. */
interface ChatResponse {
  data: {
    answer: string;
  };
}

/**
 * Floating chat panel that talks to the Richard agent through the Outline
 * server proxy. Mounted once in the authenticated layout.
 */
export function RichardChat() {
  const [isOpen, setIsOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [listElement, setListElement] = useState<HTMLDivElement | null>(null);

  const handleToggle = useCallback(() => {
    setIsOpen((open) => !open);
  }, []);

  const handleClose = useCallback(() => {
    setIsOpen(false);
  }, []);

  const handleChange = useCallback(
    (event: ChangeEvent<HTMLTextAreaElement>) => {
      setInput(event.target.value);
    },
    []
  );

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

  // Keep the latest message in view as the conversation grows.
  useEffect(() => {
    if (listElement) {
      listElement.scrollTop = listElement.scrollHeight;
    }
  }, [listElement, messages, isSending]);

  const send = useCallback(async (history: ChatMessage[]) => {
    setIsSending(true);
    try {
      const response = await client.post<ChatResponse>("/richard.chat", {
        messages: history.map((message) => ({
          role: message.role,
          content: message.content,
        })),
      });
      setMessages([
        ...history,
        { role: "assistant", content: response.data.answer },
      ]);
    } catch (err) {
      setMessages([
        ...history,
        {
          role: "assistant",
          content: err instanceof Error ? err.message : "Algo salió mal.",
        },
      ]);
    } finally {
      setIsSending(false);
    }
  }, []);

  const handleSubmit = useCallback(() => {
    const content = input.trim();
    if (!content || isSending) {
      return;
    }

    const history: ChatMessage[] = [...messages, { role: "user", content }];
    setMessages(history);
    setInput("");
    void send(history);
  }, [input, isSending, messages, send]);

  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        handleSubmit();
      }
    },
    [handleSubmit]
  );

  return (
    <>
      <ToggleButton
        type="button"
        aria-label="Hablar con Richard"
        aria-expanded={isOpen}
        onClick={handleToggle}
      >
        <span aria-hidden="true">🤖</span>
      </ToggleButton>
      {isOpen && (
        <Panel role="dialog" aria-label="Richard">
          <PanelHeader>
            <PanelTitle>Richard</PanelTitle>
            <CloseButton
              type="button"
              aria-label="Cerrar chat"
              onClick={handleClose}
            >
              <span aria-hidden="true">×</span>
            </CloseButton>
          </PanelHeader>
          <Messages ref={setListElement} role="log" aria-live="polite">
            {messages.length === 0 && !isSending && (
              <EmptyHint>
                Escribí tu consulta para empezar a hablar con Richard.
              </EmptyHint>
            )}
            {messages.map((message, index) => (
              <Bubble key={index} $role={message.role}>
                {message.content}
              </Bubble>
            ))}
            {isSending && <Bubble $role="assistant">Pensando…</Bubble>}
          </Messages>
          <Composer>
            <Textarea
              aria-label="Mensaje para Richard"
              placeholder="Escribí un mensaje…"
              rows={2}
              value={input}
              onChange={handleChange}
              onKeyDown={handleKeyDown}
            />
            <Button
              type="button"
              onClick={handleSubmit}
              disabled={isSending || input.trim() === ""}
            >
              Enviar
            </Button>
          </Composer>
        </Panel>
      )}
    </>
  );
}

const ToggleButton = styled.button`
  position: fixed;
  inset-block-end: 20px;
  inset-inline-end: 20px;
  z-index: ${depths.overlay};
  display: flex;
  align-items: center;
  justify-content: center;
  width: 48px;
  height: 48px;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: ${s("accent")};
  color: ${s("accentText")};
  font-size: 22px;
  line-height: 1;
  cursor: var(--pointer);
  box-shadow: rgba(0, 0, 0, 0.2) 0 2px 8px;

  &:focus-visible {
    outline: 2px solid ${s("inputBorderFocused")};
    outline-offset: 2px;
  }
`;

const Panel = styled.div`
  position: fixed;
  inset-block-end: 80px;
  inset-inline-end: 20px;
  z-index: ${depths.overlay};
  display: flex;
  flex-direction: column;
  width: 380px;
  max-width: calc(100vw - 40px);
  height: 60vh;
  max-height: 640px;
  overflow: hidden;
  background: ${s("background")};
  border: 1px solid ${s("divider")};
  border-radius: 12px;
  box-shadow: rgba(0, 0, 0, 0.25) 0 8px 32px;
`;

const PanelHeader = styled.header`
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid ${s("divider")};
`;

const PanelTitle = styled.h2`
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  color: ${s("text")};
`;

const CloseButton = styled.button`
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: 0;
  border-radius: 6px;
  background: none;
  color: ${s("textSecondary")};
  font-size: 20px;
  line-height: 1;
  cursor: var(--pointer);

  &:hover {
    background: ${s("backgroundSecondary")};
  }

  &:focus-visible {
    outline: 2px solid ${s("inputBorderFocused")};
    outline-offset: 2px;
  }
`;

const Messages = styled.div`
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 16px;
  overflow-y: auto;
`;

const Bubble = styled.div<{ $role: "user" | "assistant" }>`
  align-self: ${(props) =>
    props.$role === "user" ? "flex-end" : "flex-start"};
  max-width: 85%;
  padding: 8px 12px;
  border-radius: 10px;
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
`;

const EmptyHint = styled.p`
  margin: 0;
  color: ${s("textTertiary")};
  font-size: 13px;
  text-align: center;
`;

const Composer = styled.div`
  display: flex;
  align-items: flex-end;
  gap: 8px;
  padding: 12px 16px;
  border-top: 1px solid ${s("divider")};
`;

const Textarea = styled.textarea`
  flex: 1;
  min-height: 40px;
  max-height: 120px;
  padding: 8px 10px;
  border: 1px solid ${s("inputBorder")};
  border-radius: 8px;
  background: ${s("background")};
  color: ${s("text")};
  font-family: inherit;
  font-size: 14px;
  line-height: 1.4;
  resize: none;
  outline: none;

  &:focus {
    border-color: ${s("inputBorderFocused")};
  }

  &::placeholder {
    color: ${s("placeholder")};
  }
`;
