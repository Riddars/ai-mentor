import { readFileSync } from "node:fs";

export type SimMode = "manual" | "auto-approve" | "auto-block" | "offline";

const SIM_MODES: readonly SimMode[] = [
  "manual",
  "auto-approve",
  "auto-block",
  "offline",
];

// Кто выполняет разбор pull request: `simulate` — заглушка (режимы SimMode ниже),
// `provod` — реальный разбор языковой моделью через OpenAI-совместимый шлюз provod.ai.
export type Reviewer = "simulate" | "provod";

const REVIEWERS: readonly Reviewer[] = ["simulate", "provod"];

export interface Config {
  appId: string;
  privateKey: string;
  webhookSecret: string;
  reviewer: Reviewer;
  simMode: SimMode;
  simDelayMs: number;
  simAdminToken: string;
  provodApiKey?: string;
  provodModel: string;
  provodBaseUrl: string;
}

let cached: Config | null = null;

function loadPrivateKey(): string {
  const path = process.env.GITHUB_APP_PRIVATE_KEY_PATH;
  if (path) {
    return readFileSync(path, "utf8");
  }
  const base64 = process.env.GITHUB_APP_PRIVATE_KEY_BASE64;
  if (base64) {
    return Buffer.from(base64, "base64").toString("utf8");
  }
  throw new Error(
    "Missing private key: set GITHUB_APP_PRIVATE_KEY_PATH or GITHUB_APP_PRIVATE_KEY_BASE64",
  );
}

function parseSimMode(): SimMode {
  const raw = process.env.CURATOR_SIM_MODE ?? "manual";
  if (!SIM_MODES.includes(raw as SimMode)) {
    throw new Error(
      `Invalid CURATOR_SIM_MODE "${raw}", expected one of: ${SIM_MODES.join(", ")}`,
    );
  }
  return raw as SimMode;
}

function parseReviewer(): Reviewer {
  const raw = process.env.CURATOR_REVIEWER ?? "simulate";
  if (!REVIEWERS.includes(raw as Reviewer)) {
    throw new Error(
      `Invalid CURATOR_REVIEWER "${raw}", expected one of: ${REVIEWERS.join(", ")}`,
    );
  }
  return raw as Reviewer;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function getConfig(): Config {
  if (cached) {
    return cached;
  }
  const reviewer = parseReviewer();
  const provodApiKey = process.env.PROVOD_API_KEY;
  if (reviewer === "provod" && !provodApiKey) {
    throw new Error(
      "CURATOR_REVIEWER=provod requires PROVOD_API_KEY to be set",
    );
  }

  cached = {
    appId: requireEnv("GITHUB_APP_ID"),
    privateKey: loadPrivateKey(),
    webhookSecret: requireEnv("GITHUB_WEBHOOK_SECRET"),
    reviewer,
    simMode: parseSimMode(),
    simDelayMs: Number(process.env.CURATOR_SIM_DELAY_MS ?? "8000"),
    simAdminToken: requireEnv("SIM_ADMIN_TOKEN"),
    provodApiKey,
    provodModel: process.env.PROVOD_MODEL ?? "deepseek/deepseek-v4-pro",
    provodBaseUrl: process.env.PROVOD_BASE_URL ?? "https://api.provod.ai/v1",
  };
  return cached;
}
