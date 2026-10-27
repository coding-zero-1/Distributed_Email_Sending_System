import nodemailer from "nodemailer";
import { config } from "dotenv";
import { resolve } from "node:path";

// Load .env only when we need credentials (skip when test transport is active)
if (!process.env.GMAIL_USER && process.env.MAIL_TRANSPORT !== "test") {
  config({ path: resolve(import.meta.dirname, "../../../.env") });
}

function createMailer() {
  // Use a JSON transport when testing
  if (process.env.MAIL_TRANSPORT === "test") {
    console.log(
      "[mailer] MAIL_TRANSPORT=test — using JSON transport. No real emails will be sent.",
    );
    return nodemailer.createTransport({ jsonTransport: true });
  }

  const gmailUser = process.env.GMAIL_USER;
  const gmailAppPassword = process.env.GMAIL_APP_PASSWORD;

  if (!gmailUser || !gmailAppPassword) {
    throw new Error(
      "GMAIL_USER and GMAIL_APP_PASSWORD must be configured " +
        "(or set MAIL_TRANSPORT=test for load testing)",
    );
  }

  return nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: gmailUser,
      pass: gmailAppPassword,
    },
  });
}

export const mailer = createMailer();