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

    const generated = await stylizeRoomWithAiStudio(
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
