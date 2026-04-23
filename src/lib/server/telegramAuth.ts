import crypto from "node:crypto";
import type { NextRequest } from "next/server";

type ParsedInitData = {
  [key: string]: string;
};

function parseInitData(initData: string) {
  const params = new URLSearchParams(initData);
  const data: ParsedInitData = {};
  params.forEach((value, key) => {
    data[key] = value;
  });
  return data;
}

function computeHash(data: ParsedInitData, botToken: string) {
  const secret = crypto.createHmac("sha256", "WebAppData").update(botToken).digest();
  const dataCheckString = Object.entries(data)
    .filter(([key]) => key !== "hash")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

  return crypto.createHmac("sha256", secret).update(dataCheckString).digest("hex");
}

function getTelegramIdFromInitData(initData: string, botToken: string) {
  const parsed = parseInitData(initData);
  const suppliedHash = parsed.hash;
  if (!suppliedHash) {
    throw new Error("Missing Telegram hash in initData");
  }

  const expectedHash = computeHash(parsed, botToken);
  if (expectedHash !== suppliedHash) {
    throw new Error("Invalid Telegram initData signature");
  }

  const userRaw = parsed.user;
  if (!userRaw) {
    throw new Error("Missing Telegram user in initData");
  }

  const user = JSON.parse(userRaw) as { id?: number };
  if (!user.id) {
    throw new Error("Telegram user id is missing");
  }

  return String(user.id);
}

export function getRequestTelegramId(request: NextRequest) {
  const isDevelopment = process.env.NODE_ENV === "development";
  const devBrowserMode = process.env.DEV_BROWSER_MODE === "true";

  if (!isDevelopment && devBrowserMode) {
    throw new Error("DEV_BROWSER_MODE is only allowed in development");
  }

  if (isDevelopment && devBrowserMode) {
    const devTelegramId = process.env.DEV_TELEGRAM_ID;
    if (!devTelegramId) {
      throw new Error("DEV_BROWSER_MODE is enabled but DEV_TELEGRAM_ID is missing");
    }
    return devTelegramId;
  }

  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) {
    throw new Error("Missing TELEGRAM_BOT_TOKEN");
  }

  const initData = request.headers.get("x-telegram-init-data");
  if (!initData) {
    throw new Error("Missing Telegram initData header");
  }

  return getTelegramIdFromInitData(initData, botToken);
}
