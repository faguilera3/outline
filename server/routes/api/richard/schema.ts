import { z } from "zod";
import { BaseSchema } from "../schema";

export const RichardChatSchema = BaseSchema.extend({
  body: z.object({
    messages: z
      .array(
        z.object({
          role: z.enum(["user", "assistant"]),
          content: z.string(),
        })
      )
      .min(1, "messages must contain at least one message"),
    documentContext: z
      .object({
        title: z.string().optional(),
        documentId: z.string().optional(),
        text: z.string().optional(),
      })
      .nullish(),
  }),
});

export type RichardChatReq = z.infer<typeof RichardChatSchema>;

export const RichardJobSchema = BaseSchema.extend({
  query: z.object({
    /** Identifier of the asynchronous chat job to poll. */
    id: z.string().min(1, "id must not be empty"),
  }),
});

export type RichardJobReq = z.infer<typeof RichardJobSchema>;
