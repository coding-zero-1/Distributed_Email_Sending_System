import { config } from "dotenv";
import { resolve } from "node:path";

if (!process.env.PORT && !process.env.DATABASE_URL) {
  config({ path: resolve(import.meta.dirname, "../../../.env") });
  if (!process.env.DATABASE_URL) {
    config({ path: resolve(process.cwd(), ".env") });
  }
}

const { default: app } = await import("./app.js");

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`API running on http://localhost:${PORT}`);
});
