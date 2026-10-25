import { z } from "zod";

export const emailJobSchema = z.object({
  to: z.email(),
  subject: z.string().min(1).max(200),
  text: z.string().min(1),
});

export type EmailJob = z.infer<typeof emailJobSchema>;