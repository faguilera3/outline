import { randomUUID } from "node:crypto";
import Router from "@koa/router";
import { toError } from "@shared/utils/error";
import env from "@server/env";
import { InternalError, NotFoundError } from "@server/errors";
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
const REQUEST_TIMEOUT = 900000;

/** The same ceiling expressed in minutes, for user-facing messages. */
const REQUEST_TIMEOUT_MINUTES = Math.round(REQUEST_TIMEOUT / 60000);

/**
 * How long a job is kept in memory before it is swept, in milliseconds. Kept
 * comfortably above the request timeout so a job cannot disappear while the
 * client is still polling for its result.
 */
const JOB_RETENTION = 30 * 60 * 1000;

/** A message in the OpenAI chat format, including the server-injected system role. */
interface RichardMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** The optional document the user is currently viewing. */
interface DocumentContext {
  title?: string;
  documentId?: string;
  text?: string;
}

/** Lifecycle state of an asynchronous chat job. */
type RichardJobStatus = "pending" | "done" | "error";

/**
 * An asynchronous chat job, tracked in memory while the agent works and kept
 * afterwards so the client can collect the result through polling.
 */
interface RichardJob {
  id: string;
  userId: string;
  status: RichardJobStatus;
  answer: string | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

/** In-memory registry of pending and recently completed chat jobs. */
const jobs = new Map<string, RichardJob>();

/**
 * Removes jobs that have outlived the retention window so the in-memory
 * registry does not grow without bound. Called whenever a job is created.
 *
 * @param now the current timestamp, in milliseconds.
 */
function sweepJobs(now: number): void {
  for (const [id, job] of jobs) {
    if (now - job.createdAt > JOB_RETENTION) {
      jobs.delete(id);
    }
  }
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

  const documentId = documentContext.documentId?.trim();
  if (documentId) {
    parts.push(
      `That document's id is "${documentId}". Before answering or modifying it, read it with your Outline tools using that id instead of assuming its contents.`
    );
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

/**
 * Records a failure on the job and logs it with the surrounding context.
 *
 * @param job the job that failed.
 * @param message the user-facing error message to store.
 * @param err the underlying error, if any.
 * @param url the agent endpoint that was called.
 */
function failJob(
  job: RichardJob,
  message: string,
  err: unknown,
  url: string
): void {
  Logger.error("Richard chat request failed", toError(err || new Error(message)), {
    userId: job.userId,
    jobId: job.id,
    url,
  });
  job.status = "error";
  job.error = message;
  job.updatedAt = Date.now();
}

/**
 * Runs the agent request for a job, detached from the HTTP response, recording
 * the answer or the error on the job once it settles.
 *
 * @param job the job to run.
 * @param messages the conversation history to forward.
 * @param documentContext the document the user is currently viewing, if any.
 */
async function runJob(
  job: RichardJob,
  messages: RichardMessage[],
  documentContext?: DocumentContext | null
): Promise<void> {
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
    // A timeout means the agent may still be working and could have already
    // applied the change, so say that rather than reporting it as unreachable.
    const timedOut =
      err instanceof Error && /timeout/i.test(err.message);

    failJob(
      job,
      timedOut
        ? `Richard estuvo trabajando más de ${REQUEST_TIMEOUT_MINUTES} minutos y se cortó la espera. Puede que el cambio ya esté hecho: revisá el documento.`
        : "Unable to reach the Richard agent",
      err,
      url
    );
    return;
  }

  if (!response.ok) {
    failJob(
      job,
      "The Richard agent returned an error",
      new Error(`Richard agent responded with status ${response.status}`),
      url
    );
    return;
  }

  const answer = extractAnswer(await response.json());
  if (!answer) {
    failJob(
      job,
      "The Richard agent returned an unexpected response",
      new Error("Missing choices[0].message.content in agent response"),
      url
    );
    return;
  }

  job.status = "done";
  job.answer = answer;
  job.updatedAt = Date.now();
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

    const now = Date.now();
    sweepJobs(now);

    const job: RichardJob = {
      id: randomUUID(),
      userId: user.id,
      status: "pending",
      answer: null,
      error: null,
      createdAt: now,
      updatedAt: now,
    };
    jobs.set(job.id, job);

    // The agent request runs detached from the HTTP response so that a slow
    // reply cannot be cut off by an upstream proxy timeout. The client polls
    // for the result through `richard.job`.
    void runJob(job, messages, documentContext).catch((err) => {
      failJob(
        job,
        "The Richard agent returned an unexpected response",
        err,
        `${env.RICHARD_API_URL}/chat/completions`
      );
    });

    ctx.body = {
      data: {
        jobId: job.id,
      },
    };
  }
);

router.get(
  "richard.job",
  auth(),
  validate(T.RichardJobSchema),
  async (ctx: APIContext<T.RichardJobReq>) => {
    const { id } = ctx.input.query;
    const { user } = ctx.state.auth;

    const job = jobs.get(id);
    if (!job || job.userId !== user.id) {
      throw NotFoundError("Job not found");
    }

    ctx.body = {
      data: {
        status: job.status,
        ...(job.answer ? presentRichardAnswer(job.answer) : { answer: null }),
        error: job.error,
        elapsedMs: Date.now() - job.createdAt,
      },
    };
  }
);

export default router;
