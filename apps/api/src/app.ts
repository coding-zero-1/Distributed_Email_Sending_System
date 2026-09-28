import express,{type Express} from "express";
import { emailQueue } from "@repo/queue";

const app:Express = express();

app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
  });
});

app.post("/jobs", async (req, res, next) => {
  try {
    const { to, subject, text } = req.body;

    const job = await emailQueue.add("send-email", {
      to,
      subject,
      text,
    });

    res.status(202).json({
      jobId: job.id,
      status: "queued",
    });
  } catch (error) {
    next(error);
  }
});

export default app;