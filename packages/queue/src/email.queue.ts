import { Queue } from "bullmq";
import { createRedisConnection } from "./connection.js";

export const emailQueue = new Queue("email", {
  connection: createRedisConnection(),
});