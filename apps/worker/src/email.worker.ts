import { Worker } from "bullmq";
import { createRedisConnection } from "@repo/queue";
import { mailer } from "./mailer.js";

const worker = new Worker(
  "email",
  async (job) => {
    console.log(`Processing email job ${job.id}`);

    const { to, subject, text } = job.data;

    const info = await mailer.sendMail({
      from: process.env.GMAIL_USER,
      to,
      subject,
      text,
    });

    console.log(`Email sent for job ${job.id}`);
    console.log(`Message ID: ${info.messageId}`);

    return {
      messageId: info.messageId,
    };
  },
  {
    connection: createRedisConnection(),
    concurrency: 1,
  },
);

worker.on("completed", (job) => {
  console.log(`Job ${job.id} completed`);
});

worker.on("failed", (job, error) => {
  console.error(`Job ${job?.id} failed`);
  console.error(error);
});

console.log("Email worker started");