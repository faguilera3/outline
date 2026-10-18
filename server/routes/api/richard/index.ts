import Router from "@koa/router";
import { toError } from "@shared/utils/error";
import env from "@server/env";
import { InternalError } from "@server/errors";
import Logger from "@server/logging/Logger";
import auth from "@server/middlewares/authentication";
import { rateLimiter } from "@server/middlewares/rateLimiter";
import validate from "@server/middlewares/validate";
import { presentRichardAnswer } from "@server/presenters";
import type { APIContext } from "@server/types";
import fetch from "@server/utils/fetch";
import { RateLimiterStrategy } from "@server/utils/RateLimiter";
import * as T from "./schema";

const router = new Router();

/** The model identifier forwarded to the OpenAI-compatible endpoint. */
const RICHARD_MODEL = "hermes-agent";

/** Maximum number of characters of document text forwarded to the model. */
const MAX_DOCUMENT_CONTEXT_LENGTH = 8000;

/** How long to wait for the Richard agent to respond, in milliseconds. */
const REQUEST_TIMEOUT = 120000;

/** A message in the OpenAI chat format, including the server-injected system role. */
interface RichardMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** The optional document the user is currently viewing. */
interface DocumentContext {
  title?: string;
  text?: string;
}

/**
 * Builds the message list forwarded to the Richard agent, prepending a system
 * message describing the document the user is viewing when one is provided.
 *
 * @param messages the conversation history sent by the client.
 * @param documentContext the document the user is currently viewing, if any.
 * @returns the messages to forward to the agent.
 */
function buildMessages(
  messages: RichardMessage[],
  documentContext?: DocumentContext | null
): RichardMessage[] {
  if (!documentContext) {
    return messages;
  }

  const parts = [
    "You are Richard, the user's personal assistant embedded in their Outline wiki.",
    "You can read, search and edit documents using your tools.",
  ];

  const title = documentContext.title?.trim();
  if (title) {
    parts.push(`The user is currently viewing the document "${title}".`);
  }

  const text = documentContext.text?.trim();
  if (text) {
    parts.push(
      `Document content:\n\n${text.slice(0, MAX_DOCUMENT_CONTEXT_LENGTH)}`
    );
  }

  const systemMessage: RichardMessage = {
    role: "system",
    content: parts.join("\n\n"),
  };

  return [systemMessage, ...messages];
}

/**
 * Extracts the assistant answer from an OpenAI-compatible chat completion
 * payload, returning undefined when the shape is unexpected.
 *
 * @param payload the parsed response body from the agent.
 * @returns the assistant's reply, or undefined if it is missing.
 */
function extractAnswer(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null) {
    return undefined;
  }

  if (!("choices" in payload)) {
    return undefined;
  }

  const { choices } = payload;
  if (!Array.isArray(choices) || choices.length === 0) {
    return undefined;
  }

  const [choice] = choices;
  if (typeof choice !== "object" || choice === null || !("message" in choice)) {
    return undefined;
  }

  const { message } = choice;
  if (
    typeof message !== "object" ||
    message === null ||
    !("content" in message)
  ) {
    return undefined;
  }

  const { content } = message;
  return typeof content === "string" ? content : undefined;
}

router.post(
  "richard.chat",
  rateLimiter(RateLimiterStrategy.TwentyFivePerMinute),
  auth(),
  validate(T.RichardChatSchema),
  async (ctx: APIContext<T.RichardChatReq>) => {
    const { messages, documentContext } = ctx.input.body;
    const { user } = ctx.state.auth;

    if (!env.RICHARD_API_KEY) {
      throw InternalError("Richard chat integration is not configured");
    }

    const url = `${env.RICHARD_API_URL}/chat/completions`;
    let response;

    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${env.RICHARD_API_KEY}`,
        },
        body: JSON.stringify({
          model: RICHARD_MODEL,
          messages: buildMessages(messages, documentContext),
          stream: false,
        }),
        timeout: REQUEST_TIMEOUT,
        // The endpoint is operator-configured and typically lives on the
        // internal network, so private addresses are permitted for it.
        allowPrivateIPAddress: true,
      });
    } catch (err) {
      Logger.error("Richard chat request failed", toError(err), {
        userId: user.id,
        url,
      });
      throw InternalError("Unable to reach the Richard agent");
    }

    if (!response.ok) {
      Logger.error(
        "Richard chat request returned an error",
        new Error(`Richard agent responded with status ${response.status}`),
        { userId: user.id, url, status: response.status }
      );
      throw InternalError("The Richard agent returned an error");
    }

    const answer = extractAnswer(await response.json());
    if (!answer) {
      Logger.error(
        "Richard chat request returned an unexpected response",
        new Error("Missing choices[0].message.content in agent response"),
        { userId: user.id, url }
      );
      throw InternalError("The Richard agent returned an unexpected response");
    }

    ctx.body = {
      data: presentRichardAnswer(answer),
    };
  }
);

export default router;
