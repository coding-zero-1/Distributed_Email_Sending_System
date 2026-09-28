import { Worker } from "bullmq";
import { createRedisConnection } from "@repo/queue";

const worker = new Worker(
  "email",
  async (job) => {
    console.log("Processing email job");

    console.log("Job ID:", job.id);
    console.log("Job name:", job.name);
    console.log("Job data:", job.data);

    return {
      success: true,
    };
  },
  {
    connection: createRedisConnection(),
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