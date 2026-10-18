/**
 * Presents the answer returned by the Richard agent.
 *
 * @param answer the assistant's reply.
 * @returns the response payload for the chat endpoint.
 */
export default function presentRichardAnswer(answer: string) {
  return {
    answer,
  };
}
