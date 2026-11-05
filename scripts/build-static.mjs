import { mkdir } from "node:fs/promises";
import { buildPreview } from "./build-preview.mjs";

const directory = new URL("../dist/email-assistant/", import.meta.url);
await mkdir(directory, { recursive: true });
await buildPreview(new URL("index.html", directory));
console.log(
  "Built dist/email-assistant/index.html. Copy email-assistant/ into the existing hellokim.me Pages site to publish the offline demo.",
);
