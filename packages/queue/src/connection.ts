import {Redis} from "ioredis";

export function createRedisConnection() {
  return new Redis({
    host: "localhost",
    port: 6379,
    maxRetriesPerRequest: null,
  });
}