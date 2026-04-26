import { NextResponse, type NextRequest } from "next/server";

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

const DEFAULT_THIRSTY_AFTER_HOURS = 6;
const DEFAULT_OVERDUE_AFTER_HOURS = 12;
const MIN_THIRSTY_AFTER_HOURS = 6;
const MIN_OVERDUE_AFTER_HOURS = 12;
const MIN_GAP_BETWEEN_THRESHOLDS_HOURS = 6;
const MAX_PLANTS_PER_REQUEST = 8;

type RoomRow = {
  id: string;
  name: string;
  background_path: string | null;
};

type RoomPlantDetection = {
  plant_name: string;
  species: string | null;
  marker_x: number;
  marker_y: number;
  thirsty_after_hours: number;
  overdue_after_hours: number;
};

type CreatedRoomPlant = {
  plant_id: string;
  plant_name: string;
  species: string | null;
  marker_x: number;
  marker_y: number;
};

type AiDetectStatus =
  | "ok"
  | "no_plants"
  | "disabled_missing_api_key"
  | "request_failed"
  | "invalid_response";

function isMissingAiRateLimitRpc(message: string) {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("could not find the function public.api_register_ai_photo_request") ||
    normalized.includes("function public.api_register_ai_photo_request")
  );
}

function extractJsonObject(raw: string): string | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    return null;
  }
  return raw.slice(start, end + 1);
}

function normalizeWateringThresholds(thirstyRaw: number, overdueRaw: number) {
  const parsedThirsty =
    Number.isFinite(thirstyRaw) && thirstyRaw > 0
      ? Number(thirstyRaw.toFixed(2))
      : DEFAULT_THIRSTY_AFTER_HOURS;
  const thirstyAfterHours = Math.max(parsedThirsty, MIN_THIRSTY_AFTER_HOURS);

  const parsedOverdue =
    Number.isFinite(overdueRaw) && overdueRaw > 0
      ? Number(overdueRaw.toFixed(2))
      : DEFAULT_OVERDUE_AFTER_HOURS;
  const overdueAfterHours = Math.max(
    parsedOverdue,
    MIN_OVERDUE_AFTER_HOURS,
    thirstyAfterHours + MIN_GAP_BETWEEN_THRESHOLDS_HOURS,
  );

  return { thirstyAfterHours, overdueAfterHours };
}

function normalizeCoordinate(value: number) {
  if (!Number.isFinite(value)) {
    return 0.5;
  }
  return Math.min(1, Math.max(0, value));
}

function normalizeDetectionsInput(value: unknown) {
  if (!Array.isArray(value)) {
    return [] as RoomPlantDetection[];
  }
  return value
    .slice(0, MAX_PLANTS_PER_REQUEST)
    .map((item) => {
      const row = item as {
        plant_name?: unknown;
        species?: unknown;
        marker_x?: unknown;
        marker_y?: unknown;
        thirsty_after_hours?: unknown;
        overdue_after_hours?: unknown;
      };
      const plantName = typeof row.plant_name === "string" ? row.plant_name.trim() : "";
      if (!plantName) {
        return null;
      }
      const species =
        typeof row.species === "string" && row.species.trim() ? row.species.trim() : null;
      const markerX = normalizeCoordinate(Number(row.marker_x));
      const markerY = normalizeCoordinate(Number(row.marker_y));
      const { thirstyAfterHours, overdueAfterHours } = normalizeWateringThresholds(
        Number(row.thirsty_after_hours),
        Number(row.overdue_after_hours),
      );
      return {
        plant_name: plantName,
        species,
        marker_x: markerX,
        marker_y: markerY,
        thirsty_after_hours: thirstyAfterHours,
        overdue_after_hours: overdueAfterHours,
      };
    })
    .filter((item): item is RoomPlantDetection => item != null);
}

async function createPlantsAndMarkers(
  rpcAny: (fn: string, args?: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }>,
  telegramId: string,
  roomId: string,
  detections: RoomPlantDetection[],
) {
  const created: CreatedRoomPlant[] = [];
  for (const detection of detections) {
    const { data: createdPlantData, error: createPlantError } = await rpcAny("api_create_plant", {
      p_telegram_id: telegramId,
      p_room_id: roomId,
      p_name: detection.plant_name,
      p_species: detection.species,
      p_status: "healthy",
      p_thirsty_after_hours: detection.thirsty_after_hours,
      p_overdue_after_hours: detection.overdue_after_hours,
    });
    if (createPlantError) {
      throw new Error(createPlantError.message);
    }
    const createdPlantRow = Array.isArray(createdPlantData) ? createdPlantData[0] : createdPlantData;
    const plantId = String((createdPlantRow as { id?: unknown } | null)?.id ?? "");
    if (!plantId) {
      throw new Error("Plant create response missing id");
    }

    const { error: upsertMarkerError } = await rpcAny("api_upsert_marker", {
      p_telegram_id: telegramId,
      p_room_id: roomId,
      p_plant_id: plantId,
      p_x: detection.marker_x,
      p_y: detection.marker_y,
    });
    if (upsertMarkerError) {
      throw new Error(upsertMarkerError.message);
    }

    created.push({
      plant_id: plantId,
      plant_name: detection.plant_name,
      species: detection.species,
      marker_x: detection.marker_x,
      marker_y: detection.marker_y,
    });
  }
  return created;
}

async function detectRoomPlantsWithAiStudio(
  imageBytes: ArrayBuffer,
  mimeType: string,
): Promise<{ status: AiDetectStatus; plants: RoomPlantDetection[]; errorMessage?: string }> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return { status: "disabled_missing_api_key", plants: [], errorMessage: "Missing GEMINI_API_KEY" };
  }

  const base64Image = Buffer.from(imageBytes).toString("base64");
  const prompt = [
    "You are an indoor plant recognition assistant.",
    "Analyze this room photo and detect visible potted plants/flowers.",
    "Return ONLY strict JSON with shape:",
    "{",
    '  "plants": [',
    "    {",
    '      "plant_name": "string",',
    '      "species": "string or null",',
    '      "marker_x": "number 0..1",',
    '      "marker_y": "number 0..1",',
    '      "thirsty_after_hours": "number >= 6 (hours)",',
    '      "overdue_after_hours": "number >= thirsty_after_hours + 6 (hours)"',
    "    }",
    "  ]",
    "}",
    `Return at most ${MAX_PLANTS_PER_REQUEST} plants.`,
    "Coordinates marker_x and marker_y must point near each plant's center in normalized image space.",
    "If no plants are visible, return an empty plants array.",
    "Use conservative indoor defaults when uncertain.",
    `Never return thirsty_after_hours below ${MIN_THIRSTY_AFTER_HOURS}.`,
    `Never return overdue_after_hours below ${MIN_OVERDUE_AFTER_HOURS}.`,
    `Keep overdue_after_hours at least ${MIN_GAP_BETWEEN_THRESHOLDS_HOURS} hours later than thirsty_after_hours.`,
  ].join("\n");

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(apiKey)}`,
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
          temperature: 0.15,
          responseMimeType: "application/json",
        },
      }),
    },
  );

  if (!response.ok) {
    const body = await response.text();
    let errorMessage = `HTTP ${response.status}`;
    try {
      const parsed = JSON.parse(body) as { error?: { message?: string } };
      const detail = parsed.error?.message?.trim();
      if (detail) {
        errorMessage = detail;
      }
    } catch {
      const compact = body.replace(/\s+/g, " ").trim().slice(0, 220);
      if (compact) {
        errorMessage = compact;
      }
    }
    return { status: "request_failed", plants: [], errorMessage };
  }

  const payload = (await response.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const rawText =
    payload.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("\n") ?? "";
  const jsonText = extractJsonObject(rawText) ?? rawText;

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return {
      status: "invalid_response",
      plants: [],
      errorMessage: "Model returned non-JSON payload",
    };
  }

  const candidatePlants = (parsed as { plants?: unknown }).plants;
  if (!Array.isArray(candidatePlants)) {
    return {
      status: "invalid_response",
      plants: [],
      errorMessage: "Missing plants array in AI response",
    };
  }

  const normalizedPlants: RoomPlantDetection[] = candidatePlants
    .slice(0, MAX_PLANTS_PER_REQUEST)
    .map((item) => {
      const row = item as {
        plant_name?: unknown;
        species?: unknown;
        marker_x?: unknown;
        marker_y?: unknown;
        thirsty_after_hours?: unknown;
        overdue_after_hours?: unknown;
      };
      const plantName = typeof row.plant_name === "string" ? row.plant_name.trim() : "";
      const species =
        typeof row.species === "string" && row.species.trim() ? row.species.trim() : null;
      const markerX = normalizeCoordinate(Number(row.marker_x));
      const markerY = normalizeCoordinate(Number(row.marker_y));
      const { thirstyAfterHours, overdueAfterHours } = normalizeWateringThresholds(
        Number(row.thirsty_after_hours),
        Number(row.overdue_after_hours),
      );
      return {
        plant_name: plantName,
        species,
        marker_x: markerX,
        marker_y: markerY,
        thirsty_after_hours: thirstyAfterHours,
        overdue_after_hours: overdueAfterHours,
      };
    })
    .filter((item) => item.plant_name.length > 0);

  if (normalizedPlants.length === 0) {
    return { status: "no_plants", plants: [] };
  }
  return { status: "ok", plants: normalizedPlants };
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
        source: "rooms_analyze",
        telegramId: telegramIdForLog,
        profileId: profileIdForLog,
        endpoint: request.nextUrl.pathname,
        action: "analyzeRoomPlants",
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
    const supabaseAdmin = getSupabaseAdmin();
    type RpcResponse = { data: unknown; error: { message: string } | null };
    const rpcAny = supabaseAdmin.rpc.bind(supabaseAdmin) as unknown as (
      fn: string,
      args?: Record<string, unknown>,
    ) => Promise<RpcResponse>;

    const body = (await request.json()) as { roomId?: unknown; mode?: unknown; detections?: unknown };
    const roomIdRaw = body.roomId;
    const roomId = typeof roomIdRaw === "string" ? roomIdRaw.trim() : "";
    const mode = body.mode === "create" ? "create" : "preview";
    if (!roomId) {
      statusCode = 400;
      return NextResponse.json({ error: "Missing roomId" }, { status: 400 });
    }

    const { error: aiRateError } = await rpcAny("api_register_ai_photo_request", {
      p_telegram_id: String(telegramId),
    });
    if (aiRateError) {
      if (isMissingAiRateLimitRpc(aiRateError.message)) {
        console.warn("[rooms-analyze] missing ai rate limit RPC, continuing without limit", {
          message: aiRateError.message,
        });
      } else {
        statusCode = 429;
        await logRateLimitHit({
          source: "rooms_analyze",
          telegramId: telegramIdForLog,
          profileId: profileIdForLog,
          endpoint: request.nextUrl.pathname,
          action: "analyzeRoomPlants",
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

    const { data: imageBlob, error: downloadError } = await supabaseAdmin.storage
      .from("rooms")
      .download(room.background_path);
    if (downloadError || !imageBlob) {
      statusCode = 400;
      return NextResponse.json(
        { error: downloadError?.message ?? "Failed to read room image" },
        { status: 400 },
      );
    }

    const imageBytes = await imageBlob.arrayBuffer();
    const imageMimeType = imageBlob.type || "image/jpeg";
    let detections = normalizeDetectionsInput(body.detections);
    let aiStatus: AiDetectStatus = "ok";
    let aiError: string | null = null;

    if (mode === "preview" || detections.length === 0) {
      const aiResult = await detectRoomPlantsWithAiStudio(imageBytes, imageMimeType);
      aiStatus = aiResult.status;
      aiError = aiResult.errorMessage ?? null;
      detections = aiResult.plants;
    }

    if (aiStatus !== "ok" || detections.length === 0) {
      return NextResponse.json({
        data: {
          ai_status: detections.length === 0 && aiStatus === "ok" ? "no_plants" : aiStatus,
          ai_error: aiError,
          detections,
          created: [],
          created_count: 0,
        },
      });
    }

    if (mode === "preview") {
      return NextResponse.json({
        data: {
          ai_status: "ok" as const,
          ai_error: null,
          detections,
          created: [],
          created_count: 0,
        },
      });
    }

    const created = await createPlantsAndMarkers(rpcAny, telegramId, roomId, detections);

    return NextResponse.json({
      data: {
        ai_status: "ok" as const,
        ai_error: null,
        detections,
        created,
        created_count: created.length,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Analyze room plants failed";
    statusCode = 400;
    errorMessage = message;
    if (isLikelyRateLimitError(message)) {
      await logRateLimitHit({
        source: "rooms_analyze",
        telegramId: telegramIdForLog,
        profileId: profileIdForLog,
        endpoint: request.nextUrl.pathname,
        action: "analyzeRoomPlants",
        message,
        ipHash,
        userAgentHash,
      });
    }
    await logSecurityEvent({
      eventType: "rooms_analyze_error",
      severity: "warning",
      source: "rooms_analyze",
      telegramId: telegramIdForLog,
      profileId: profileIdForLog,
      endpoint: request.nextUrl.pathname,
      action: "analyzeRoomPlants",
      details: { message },
      ipHash,
      userAgentHash,
    });
    return NextResponse.json({ error: message }, { status: 400 });
  } finally {
    await logApiRequestEvent({
      source: "rooms_analyze",
      endpoint: request.nextUrl.pathname,
      action: "analyzeRoomPlants",
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
