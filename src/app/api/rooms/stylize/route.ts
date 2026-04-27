import { NextResponse, type NextRequest } from "next/server";

import {
  buildRoomStylizationPrompt,
  type RoomStylizationPlant,
  type RoomStylizationPreset,
} from "@/lib/server/roomStylizationPrompt";
import { getSupabaseAdmin } from "@/lib/server/supabaseAdmin";
import { getRequestTelegramId } from "@/lib/server/telegramAuth";
import {
  assertNotBlocked,
  getRequestClientHashes,
  isLikelyRateLimitError,
  logApiRequestEvent,
  logRateLimitHit,
  logSecurityEvent,
  resolveProfileByTelegramId,
} from "@/lib/server/adminSecurity";

type RoomRow = {
  id: string;
  name: string;
  background_path: string | null;
  background_url: string | null;
  stylized_background_path?: string | null;
};

type PlantRow = {
  id: string;
  name: string;
};

type MarkerRow = {
  plant_id: string;
  x: number;
  y: number;
};

type GeminiImagePart = {
  text?: string;
  inlineData?: {
    mimeType?: string;
    data?: string;
  };
  inline_data?: {
    mime_type?: string;
    data?: string;
  };
};

function isMissingAiRateLimitRpc(message: string) {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("could not find the function public.api_register_ai_photo_request") ||
    normalized.includes("function public.api_register_ai_photo_request")
  );
}

function asRoomId(value: unknown) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("Missing roomId");
  }
  const roomId = value.trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(roomId)) {
    throw new Error("Invalid roomId");
  }
  return roomId;
}

function asStylizationPreset(value: unknown): RoomStylizationPreset {
  if (value === "soft" || value === "medium" || value === "strong") {
    return value;
  }
  return "strong";
}

function buildOutputPath(roomId: string) {
  return `stylized-rooms/${roomId}/${Date.now()}-cartoon.png`;
}

function getCartoonImageProvider(): "openrouter" | "gemini" {
  const raw = process.env.CARTOON_IMAGE_PROVIDER?.trim().toLowerCase();
  if (raw === "openrouter" || raw === "gemini") {
    return raw;
  }
  return process.env.OPENROUTER_API_KEY?.trim() ? "openrouter" : "gemini";
}

function parseDataUrlToBuffer(dataUrl: string): { bytes: Buffer; mimeType: string } | null {
  const match = /^data:([^;]+);base64,(.+)$/i.exec(dataUrl.trim());
  if (!match) {
    return null;
  }
  const mimeType = match[1]?.trim() || "image/png";
  const b64 = match[2]?.trim();
  if (!b64) {
    return null;
  }
  return { bytes: Buffer.from(b64, "base64"), mimeType };
}

async function fetchImageUrlToBuffer(url: string): Promise<{ bytes: Buffer; mimeType: string }> {
  const response = await fetch(url);
  if (!response.ok) {
    const text = await response.text();
    const compact = text.replace(/\s+/g, " ").trim().slice(0, 180);
    throw new Error(`Failed to download image URL (${response.status}). ${compact}`);
  }
  const mimeType = response.headers.get("content-type")?.split(";")[0]?.trim() || "image/png";
  const arrayBuffer = await response.arrayBuffer();
  return { bytes: Buffer.from(arrayBuffer), mimeType };
}

type OpenRouterImageEntry = {
  type?: string;
  image_url?: { url?: string };
  imageUrl?: { url?: string };
};

function extractFirstImageFromOpenRouterMessage(message: {
  images?: OpenRouterImageEntry[];
}): { kind: "buffer"; bytes: Buffer; mimeType: string } | { kind: "url"; url: string } | null {
  const images = message.images;
  if (!Array.isArray(images) || images.length === 0) {
    return null;
  }
  let remoteUrl: string | null = null;
  for (const image of images) {
    const url = image.image_url?.url ?? image.imageUrl?.url;
    if (!url) {
      continue;
    }
    if (url.startsWith("data:")) {
      const parsed = parseDataUrlToBuffer(url);
      if (parsed) {
        return { kind: "buffer", ...parsed };
      }
      continue;
    }
    if (url.startsWith("http://") || url.startsWith("https://")) {
      remoteUrl = url;
    }
  }
  return remoteUrl ? { kind: "url", url: remoteUrl } : null;
}

function parseOpenRouterModalities(): string[] {
  const raw = process.env.OPENROUTER_CARTOON_MODALITIES?.trim();
  if (raw) {
    const parts = raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (parts.length > 0) {
      return parts;
    }
  }
  return ["image", "text"];
}

function readSourceImageSize(imageBytes: ArrayBuffer): { width: number; height: number } | null {
  const buffer = Buffer.from(imageBytes);
  if (buffer.length < 24) {
    return null;
  }

  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  ) {
    return {
      width: buffer.readUInt32BE(16),
      height: buffer.readUInt32BE(20),
    };
  }

  if (buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < buffer.length) {
      while (offset < buffer.length && buffer[offset] === 0xff) {
        offset += 1;
      }
      const marker = buffer[offset];
      offset += 1;
      if (marker === 0xd9 || marker === 0xda) {
        break;
      }
      if (offset + 2 > buffer.length) {
        break;
      }
      const segmentLength = buffer.readUInt16BE(offset);
      if (segmentLength < 2 || offset + segmentLength > buffer.length) {
        break;
      }
      const isStartOfFrame =
        marker != null &&
        marker >= 0xc0 &&
        marker <= 0xcf &&
        marker !== 0xc4 &&
        marker !== 0xc8 &&
        marker !== 0xcc;
      if (isStartOfFrame && offset + 7 < buffer.length) {
        return {
          height: buffer.readUInt16BE(offset + 3),
          width: buffer.readUInt16BE(offset + 5),
        };
      }
      offset += segmentLength;
    }
  }

  if (buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") {
    const chunk = buffer.toString("ascii", 12, 16);
    if (chunk === "VP8X" && buffer.length >= 30) {
      return {
        width: 1 + buffer.readUIntLE(24, 3),
        height: 1 + buffer.readUIntLE(27, 3),
      };
    }
    if (chunk === "VP8 " && buffer.length >= 30) {
      return {
        width: buffer.readUInt16LE(26) & 0x3fff,
        height: buffer.readUInt16LE(28) & 0x3fff,
      };
    }
    if (chunk === "VP8L" && buffer.length >= 25) {
      const bits = buffer.readUInt32LE(21);
      return {
        width: (bits & 0x3fff) + 1,
        height: ((bits >> 14) & 0x3fff) + 1,
      };
    }
  }

  return null;
}

function chooseOpenRouterAspectRatio(imageBytes: ArrayBuffer): string | null {
  const dimensions = readSourceImageSize(imageBytes);
  if (!dimensions || dimensions.width <= 0 || dimensions.height <= 0) {
    return null;
  }

  const sourceRatio = dimensions.width / dimensions.height;
  const supported = ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"];
  let best = supported[0];
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of supported) {
    const [width, height] = candidate.split(":").map(Number);
    if (!width || !height) {
      continue;
    }
    const distance = Math.abs(Math.log(sourceRatio / (width / height)));
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

async function stylizeRoomWithOpenRouter(
  imageBytes: ArrayBuffer,
  mimeType: string,
  plants: RoomStylizationPlant[],
  preset: RoomStylizationPreset,
): Promise<{ bytes: Buffer; mimeType: string }> {
  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("OpenRouter is not configured (missing OPENROUTER_API_KEY).");
  }

  const model =
    process.env.OPENROUTER_CARTOON_MODEL?.trim() ||
    process.env.OPENROUTER_IMAGE_MODEL?.trim() ||
    "google/gemini-2.5-flash-image";
  const baseUrl =
    process.env.OPENROUTER_BASE_URL?.trim() || "https://openrouter.ai/api/v1/chat/completions";

  const prompt = buildRoomStylizationPrompt(plants, preset);
  const safeMime = mimeType && mimeType.trim() ? mimeType.trim() : "image/jpeg";
  const dataUrl = `data:${safeMime};base64,${Buffer.from(imageBytes).toString("base64")}`;

  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
  const referer = process.env.OPENROUTER_HTTP_REFERER?.trim() || process.env.OPENROUTER_SITE_URL?.trim();
  if (referer) {
    headers["HTTP-Referer"] = referer;
  }
  const title =
    process.env.OPENROUTER_X_OPENROUTER_TITLE?.trim() ||
    process.env.OPENROUTER_APP_NAME?.trim() ||
    process.env.OPENROUTER_X_TITLE?.trim();
  if (title) {
    headers["X-OpenRouter-Title"] = title;
  }

  const temperatureRaw = process.env.OPENROUTER_CARTOON_TEMPERATURE?.trim();
  const temperature =
    temperatureRaw && Number.isFinite(Number(temperatureRaw)) ? Number(temperatureRaw) : 0.2;

  const aspectRatio =
    process.env.OPENROUTER_CARTOON_ASPECT_RATIO?.trim() || chooseOpenRouterAspectRatio(imageBytes);
  const imageSize = process.env.OPENROUTER_CARTOON_IMAGE_SIZE?.trim();
  const imageConfig =
    aspectRatio || imageSize
      ? {
          ...(aspectRatio ? { aspect_ratio: aspectRatio } : {}),
          ...(imageSize ? { image_size: imageSize } : {}),
        }
      : undefined;

  const modalitiesPrimary = parseOpenRouterModalities();
  const modalitiesFallback =
    modalitiesPrimary.includes("image") && modalitiesPrimary.includes("text") ? (["image"] as const) : null;

  async function callOpenRouter(modalities: string[]) {
    const body: Record<string, unknown> = {
      model,
      temperature,
      modalities,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            {
              type: "image_url",
              image_url: { url: dataUrl },
            },
          ],
        },
      ],
    };
    if (imageConfig && Object.keys(imageConfig).length > 0) {
      body.image_config = imageConfig;
    }
    return fetch(baseUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  }

  let response = await callOpenRouter(modalitiesPrimary);
  if (!response.ok) {
    const errText = await response.text();
    let detail = `HTTP ${response.status}`;
    try {
      const parsed = JSON.parse(errText) as { error?: { message?: string } };
      if (parsed.error?.message) {
        detail = parsed.error.message;
      }
    } catch {
      const compact = errText.replace(/\s+/g, " ").trim().slice(0, 220);
      if (compact) {
        detail = compact;
      }
    }
    throw new Error(`OpenRouter cartoon generation failed: ${detail}`);
  }

  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: unknown; images?: OpenRouterImageEntry[] } }>;
  };
  const message = payload.choices?.[0]?.message;
  if (!message) {
    throw new Error("OpenRouter returned no assistant message.");
  }

  let extracted = extractFirstImageFromOpenRouterMessage(message);
  if (!extracted && modalitiesFallback) {
    response = await callOpenRouter([...modalitiesFallback]);
    if (!response.ok) {
      const errText = await response.text();
      const compact = errText.replace(/\s+/g, " ").trim().slice(0, 220);
      throw new Error(
        `OpenRouter cartoon retry failed (${response.status}). ${compact || "Unknown error"}`,
      );
    }
    const retryPayload = (await response.json()) as {
      choices?: Array<{ message?: { images?: OpenRouterImageEntry[] } }>;
    };
    const retryMessage = retryPayload.choices?.[0]?.message;
    if (retryMessage) {
      extracted = extractFirstImageFromOpenRouterMessage(retryMessage);
    }
  }

  if (extracted?.kind === "buffer") {
    console.info("[rooms-stylize] openrouter image ok", { model, modalities: modalitiesPrimary });
    return { bytes: extracted.bytes, mimeType: extracted.mimeType };
  }
  if (extracted?.kind === "url") {
    const downloaded = await fetchImageUrlToBuffer(extracted.url);
    console.info("[rooms-stylize] openrouter image url ok", { model });
    return downloaded;
  }

  const contentText =
    typeof message.content === "string"
      ? message.content
      : Array.isArray(message.content)
        ? message.content.map((part) => (typeof part === "object" && part && "text" in part ? String((part as { text?: string }).text ?? "") : "")).join(" ")
        : "";
  const compactContent = contentText.replace(/\s+/g, " ").trim().slice(0, 220);
  throw new Error(
    compactContent
      ? `OpenRouter returned no image. Assistant text: ${compactContent}`
      : "OpenRouter returned no image in message.images.",
  );
}

async function stylizeRoomWithAiStudio(
  imageBytes: ArrayBuffer,
  mimeType: string,
  plants: RoomStylizationPlant[],
  preset: RoomStylizationPreset,
) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("AI is disabled on server (missing GEMINI_API_KEY).");
  }

  const configuredModel = process.env.GEMINI_IMAGE_MODEL?.trim();
  const modelsToTry = [
    configuredModel,
    "gemini-2.5-flash-image",
    "gemini-2.0-flash-preview-image-generation",
  ].filter((value, index, array): value is string => Boolean(value) && array.indexOf(value) === index);
  const base64Image = Buffer.from(imageBytes).toString("base64");
  const prompt = buildRoomStylizationPrompt(plants, preset);
  let response: Response | null = null;
  let selectedModel: string | null = null;
  const failedModels: Array<{ model: string; message: string }> = [];
  let lastErrorMessage = "AI image generation failed.";

  for (const model of modelsToTry) {
    const candidateResponse = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                { text: prompt },
                {
                  inline_data: {
                    mime_type: mimeType || "image/jpeg",
                    data: base64Image,
                  },
                },
              ],
            },
          ],
          generationConfig: {
            responseModalities: ["IMAGE", "TEXT"],
          },
        }),
      },
    );

    if (candidateResponse.ok) {
      response = candidateResponse;
      selectedModel = model;
      break;
    }

    const body = await candidateResponse.text();
    let message = `AI image generation failed with HTTP ${candidateResponse.status}`;
    try {
      const parsed = JSON.parse(body) as { error?: { message?: string } };
      if (parsed.error?.message) {
        message = parsed.error.message;
      }
    } catch {
      const compact = body.replace(/\s+/g, " ").trim().slice(0, 220);
      if (compact) {
        message = compact;
      }
    }

    const normalized = message.toLowerCase();
    const retryableModelError =
      normalized.includes("not found for api version") || normalized.includes("not supported for generatecontent");
    lastErrorMessage = `${message} (model: ${model})`;
    failedModels.push({ model, message });
    if (!retryableModelError) {
      throw new Error(lastErrorMessage);
    }
  }

  if (!response) {
    throw new Error(lastErrorMessage);
  }

  console.info("[rooms-stylize] image model selected", {
    selectedModel,
    failedModelsCount: failedModels.length,
    failedModels: failedModels.map((item) => ({
      model: item.model,
      message: item.message.slice(0, 180),
    })),
  });

  const payload = (await response.json()) as {
    candidates?: Array<{ content?: { parts?: GeminiImagePart[] } }>;
  };
  const parts = payload.candidates?.[0]?.content?.parts ?? [];
  for (const part of parts) {
    const data = part.inlineData?.data ?? part.inline_data?.data;
    if (data) {
      return {
        bytes: Buffer.from(data, "base64"),
        mimeType: part.inlineData?.mimeType ?? part.inline_data?.mime_type ?? "image/png",
      };
    }
  }

  const text = parts
    .map((part) => part.text ?? "")
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  throw new Error(text ? `AI returned text instead of an image: ${text.slice(0, 220)}` : "AI returned no image.");
}

async function stylizeRoomCartoonImage(
  imageBytes: ArrayBuffer,
  mimeType: string,
  plants: RoomStylizationPlant[],
  preset: RoomStylizationPreset,
) {
  const provider = getCartoonImageProvider();
  if (provider === "openrouter") {
    return stylizeRoomWithOpenRouter(imageBytes, mimeType, plants, preset);
  }
  return stylizeRoomWithAiStudio(imageBytes, mimeType, plants, preset);
}

async function createSignedRoomUrls(room: RoomRow) {
  const supabaseAdmin = getSupabaseAdmin();
  const paths = [room.background_path, room.stylized_background_path].filter(
    (path): path is string => typeof path === "string" && path.trim().length > 0,
  );
  const uniquePaths = [...new Set(paths)];
  const signedByPath = new Map<string, string>();

  if (uniquePaths.length > 0) {
    const { data, error } = await supabaseAdmin.storage.from("rooms").createSignedUrls(uniquePaths, 60 * 15);
    if (error) {
      throw new Error(error.message);
    }
    for (const item of data ?? []) {
      if (item.path && item.signedUrl) {
        signedByPath.set(item.path, item.signedUrl);
      }
    }
  }

  return {
    ...room,
    signed_background_url: room.background_path ? signedByPath.get(room.background_path) ?? null : null,
    signed_stylized_background_url: room.stylized_background_path
      ? signedByPath.get(room.stylized_background_path) ?? null
      : null,
  };
}

export async function POST(request: NextRequest) {
  const startedAt = Date.now();
  let statusCode = 200;
  let blocked = false;
  let errorMessage: string | null = null;
  let telegramIdForLog: string | null = null;
  let profileIdForLog: string | null = null;
  const { ipHash, userAgentHash } = getRequestClientHashes(request);

  try {
    const telegramId = getRequestTelegramId(request);
    telegramIdForLog = String(telegramId);
    const profile = await resolveProfileByTelegramId(String(telegramId));
    profileIdForLog = profile.profileId;
    const blockState = await assertNotBlocked(String(telegramId));
    if (blockState.isBlocked) {
      blocked = true;
      statusCode = 403;
      await logSecurityEvent({
        eventType: "blocked_request_denied",
        severity: "warning",
        source: "rooms_stylize",
        telegramId: telegramIdForLog,
        profileId: profileIdForLog,
        endpoint: request.nextUrl.pathname,
        action: "stylizeRoomImage",
        details: {
          blockType: blockState.blockType,
          reason: blockState.reason,
          endsAt: blockState.endsAt,
        },
        ipHash,
        userAgentHash,
      });
      return NextResponse.json(
        { error: blockState.reason ?? "Your account is blocked. Please contact support." },
        { status: 403 },
      );
    }

    const body = (await request.json()) as { roomId?: unknown; force?: unknown; preset?: unknown };
    const roomId = asRoomId(body.roomId);
    const force = body.force === true;
    const preset = asStylizationPreset(body.preset);
    const supabaseAdmin = getSupabaseAdmin();
    type RpcResponse = { data: unknown; error: { message: string } | null };
    const rpcAny = supabaseAdmin.rpc.bind(supabaseAdmin) as unknown as (
      fn: string,
      args?: Record<string, unknown>,
    ) => Promise<RpcResponse>;

    const { data: roomsData, error: roomsError } = await rpcAny("api_list_rooms", {
      p_telegram_id: telegramId,
    });
    if (roomsError) {
      statusCode = 400;
      return NextResponse.json({ error: roomsError.message }, { status: 400 });
    }

    const rooms = Array.isArray(roomsData) ? (roomsData as RoomRow[]) : [];
    const room = rooms.find((row) => row.id === roomId);
    if (!room) {
      statusCode = 404;
      return NextResponse.json({ error: "Room not found" }, { status: 404 });
    }
    if (!room.background_path) {
      statusCode = 400;
      return NextResponse.json({ error: "Room has no photo. Upload room image first." }, { status: 400 });
    }

    const existingStylizedPath =
      typeof room.stylized_background_path === "string" && room.stylized_background_path.trim()
        ? room.stylized_background_path.trim()
        : null;

    if (!force && existingStylizedPath) {
      console.info("[rooms-stylize] skip generation (already has stylized path)", { roomId });
      const data = await createSignedRoomUrls(room);
      return NextResponse.json({ data });
    }

    const { error: aiRateError } = await rpcAny("api_register_ai_photo_request", {
      p_telegram_id: String(telegramId),
    });
    if (aiRateError) {
      if (isMissingAiRateLimitRpc(aiRateError.message)) {
        console.warn("[rooms-stylize] missing ai rate limit RPC, continuing without limit", {
          message: aiRateError.message,
        });
      } else {
        statusCode = 429;
        await logRateLimitHit({
          source: "rooms_stylize",
          telegramId: telegramIdForLog,
          profileId: profileIdForLog,
          endpoint: request.nextUrl.pathname,
          action: "stylizeRoomImage",
          message: aiRateError.message,
          limitName: "api_register_ai_photo_request",
          ipHash,
          userAgentHash,
        });
        return NextResponse.json({ error: aiRateError.message }, { status: 429 });
      }
    }

    const { error: cartoonLimitError } = await rpcAny("api_register_room_cartoon_generation", {
      p_telegram_id: String(telegramId),
    });
    if (cartoonLimitError) {
      statusCode = 429;
      await logRateLimitHit({
        source: "rooms_stylize",
        telegramId: telegramIdForLog,
        profileId: profileIdForLog,
        endpoint: request.nextUrl.pathname,
        action: "stylizeRoomImage",
        message: cartoonLimitError.message,
        limitName: "api_register_room_cartoon_generation",
        ipHash,
        userAgentHash,
      });
      return NextResponse.json({ error: cartoonLimitError.message }, { status: 429 });
    }

    const { data: detailsData, error: detailsError } = await rpcAny("api_room_details", {
      p_telegram_id: telegramId,
      p_room_id: roomId,
    });
    if (detailsError) {
      statusCode = 400;
      return NextResponse.json({ error: detailsError.message }, { status: 400 });
    }

    const details = detailsData as { plants?: PlantRow[]; markers?: MarkerRow[] } | null;
    const plants = details?.plants ?? [];
    const markers = details?.markers ?? [];
    const promptPlants = markers
      .map((marker) => {
        const plant = plants.find((item) => item.id === marker.plant_id);
        if (!plant) {
          return null;
        }
        return {
          name: plant.name,
          x: Number(marker.x),
          y: Number(marker.y),
        };
      })
      .filter((item): item is RoomStylizationPlant => item != null);

    const { data: sourceImage, error: downloadError } = await supabaseAdmin.storage
      .from("rooms")
      .download(room.background_path);
    if (downloadError || !sourceImage) {
      statusCode = 400;
      return NextResponse.json(
        { error: downloadError?.message ?? "Failed to read room image" },
        { status: 400 },
      );
    }

    const generated = await stylizeRoomCartoonImage(
      await sourceImage.arrayBuffer(),
      sourceImage.type || "image/jpeg",
      promptPlants,
      preset,
    );
    const stylizedPath = buildOutputPath(roomId);
    if (force && existingStylizedPath && existingStylizedPath !== stylizedPath) {
      const { error: removeError } = await supabaseAdmin.storage.from("rooms").remove([existingStylizedPath]);
      if (removeError) {
        console.warn("[rooms-stylize] failed to remove previous stylized room image", {
          roomId,
          path: existingStylizedPath,
          message: removeError.message,
        });
      }
    }
    const { error: uploadError } = await supabaseAdmin.storage
      .from("rooms")
      .upload(stylizedPath, generated.bytes, {
        upsert: true,
        contentType: generated.mimeType,
      });
    if (uploadError) {
      statusCode = 400;
      return NextResponse.json({ error: uploadError.message }, { status: 400 });
    }

    const db = supabaseAdmin as unknown as {
      from: (table: string) => {
        update: (values: Record<string, unknown>) => {
          eq: (column: string, value: string) => Promise<{ error: { message: string } | null }>;
        };
      };
    };
    const { error: updateError } = await db
      .from("rooms")
      .update({ stylized_background_path: stylizedPath })
      .eq("id", roomId);
    if (updateError) {
      statusCode = 400;
      return NextResponse.json({ error: updateError.message }, { status: 400 });
    }

    const data = await createSignedRoomUrls({
      ...room,
      stylized_background_path: stylizedPath,
    });
    return NextResponse.json({ data });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Stylize room image failed";
    statusCode = statusCode === 200 ? 400 : statusCode;
    errorMessage = message;
    if (isLikelyRateLimitError(message)) {
      await logRateLimitHit({
        source: "rooms_stylize",
        telegramId: telegramIdForLog,
        profileId: profileIdForLog,
        endpoint: request.nextUrl.pathname,
        action: "stylizeRoomImage",
        message,
        ipHash,
        userAgentHash,
      });
    }
    await logSecurityEvent({
      eventType: "rooms_stylize_error",
      severity: "warning",
      source: "rooms_stylize",
      telegramId: telegramIdForLog,
      profileId: profileIdForLog,
      endpoint: request.nextUrl.pathname,
      action: "stylizeRoomImage",
      details: { message },
      ipHash,
      userAgentHash,
    });
    return NextResponse.json({ error: message }, { status: statusCode });
  } finally {
    await logApiRequestEvent({
      source: "rooms_stylize",
      endpoint: request.nextUrl.pathname,
      action: "stylizeRoomImage",
      method: request.method,
      statusCode,
      durationMs: Date.now() - startedAt,
      telegramId: telegramIdForLog,
      profileId: profileIdForLog,
      isBlocked: blocked,
      errorMessage,
      ipHash,
      userAgentHash,
    });
  }
}
