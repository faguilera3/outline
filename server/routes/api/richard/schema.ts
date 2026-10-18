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
        text: z.string().optional(),
      })
      .nullish(),
  }),
});

export type RichardChatReq = z.infer<typeof RichardChatSchema>;
