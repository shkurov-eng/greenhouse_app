import { NextResponse, type NextRequest } from "next/server";

import { getSupabaseAdmin } from "@/lib/server/supabaseAdmin";
import { getRequestTelegramId } from "@/lib/server/telegramAuth";

type SecureAction =
  | "bootstrap"
  | "joinHousehold"
  | "listHouseholds"
  | "createHousehold"
  | "setActiveHousehold"
  | "listRooms"
  | "createRoom"
  | "deleteRoom"
  | "listRoomDetails"
  | "createPlant"
  | "waterPlant"
  | "updatePlant"
  | "upsertMarker"
  | "createRoomImageSignedUrl";

type RequestBody = {
  action?: SecureAction;
  payload?: Record<string, unknown>;
};

function unwrapSingleRow<T>(data: unknown): T {
  if (Array.isArray(data)) {
    if (data.length === 0) {
      throw new Error("Expected a row but received an empty result");
    }
    return data[0] as T;
  }
  if (data == null) {
    throw new Error("Expected a row but received null");
  }
  return data as T;
}

function asString(value: unknown, fieldName: string) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Invalid ${fieldName}`);
  }
  return value.trim();
}

function asOptionalString(value: unknown) {
  if (value == null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new Error("Expected string");
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asPlantStatus(value: unknown) {
  if (value === "healthy" || value === "thirsty" || value === "overdue") {
    return value;
  }
  throw new Error("Invalid plant status");
}

function asUuid(value: unknown, fieldName: string) {
  const s = asString(value, fieldName);
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s)
  ) {
    throw new Error(`Invalid ${fieldName}`);
  }
  return s;
}

async function rpc(fn: string, params: Record<string, unknown>): Promise<unknown> {
  const supabaseAdmin = getSupabaseAdmin();
  type RpcResponse = { data: unknown; error: { message: string } | null };
  const rpcAny = supabaseAdmin.rpc.bind(supabaseAdmin) as unknown as (
    rpcName: string,
    rpcParams?: Record<string, unknown>,
  ) => Promise<RpcResponse>;
  const { data, error } = await rpcAny(fn, params);
  if (error) {
    throw new Error(error.message);
  }
  return data as unknown;
}

function roomsStoragePathFromLegacyPublicUrl(url: string): string | null {
  const marker = "/storage/v1/object/public/rooms/";
  const i = url.indexOf(marker);
  if (i === -1) {
    return null;
  }
  const tail = url.slice(i + marker.length).split("?")[0];
  if (!tail) {
    return null;
  }
  try {
    return decodeURIComponent(tail);
  } catch {
    return tail;
  }
}

function resolveRoomsStoragePath(room: Record<string, unknown>): string | null {
  const direct = room.background_path;
  if (typeof direct === "string" && direct.trim().length > 0) {
    return direct.trim();
  }
  const legacyUrl = room.background_url;
  if (typeof legacyUrl === "string" && legacyUrl.length > 0) {
    return roomsStoragePathFromLegacyPublicUrl(legacyUrl);
  }
  return null;
}

async function enrichRoomsWithSignedUrls(rows: Array<Record<string, unknown>>) {
  const supabaseAdmin = getSupabaseAdmin();
  const pathPerRow = rows.map((room) => resolveRoomsStoragePath(room));
  const uniquePaths = [...new Set(pathPerRow.filter((p): p is string => Boolean(p)))];

  if (uniquePaths.length === 0) {
    return rows.map((room) => ({
      ...room,
      signed_background_url: null,
    }));
  }

  const { data, error } = await supabaseAdmin.storage.from("rooms").createSignedUrls(uniquePaths, 60 * 15);
  if (error) {
    throw new Error(error.message);
  }

  const signedByPath = new Map<string, string>();
  for (const item of data ?? []) {
    if (item.path && item.signedUrl) {
      signedByPath.set(item.path, item.signedUrl);
    }
  }

  return rows.map((room, index) => {
    const path = pathPerRow[index];
    if (!path) {
      return { ...room, signed_background_url: null };
    }
    let signed = signedByPath.get(path) ?? null;
    if (!signed) {
      for (const [key, url] of signedByPath) {
        if (key === path) {
          signed = url;
          break;
        }
        try {
          if (decodeURIComponent(key) === path || key === decodeURIComponent(path)) {
            signed = url;
            break;
          }
        } catch {
          // ignore decode errors
        }
      }
    }
    return {
      ...room,
      signed_background_url: signed,
    };
  });
}

export async function POST(request: NextRequest) {
  let actionForLog = "unknown";
  const userAgent = request.headers.get("user-agent") ?? "";
  const hasInitDataHeader = Boolean(request.headers.get("x-telegram-init-data"));
  const isTelegramUserAgent = /telegram/i.test(userAgent);

  try {
    const telegramId = getRequestTelegramId(request);
    const body = (await request.json()) as RequestBody;
    const action = body.action;
    actionForLog = action ?? "unknown";
    const payload = body.payload ?? {};

    if (!action) {
      return NextResponse.json({ error: "Missing action" }, { status: 400 });
    }

    switch (action) {
      case "bootstrap": {
        const username = asOptionalString(payload.username);
        const result = await rpc("api_bootstrap_user", {
          p_telegram_id: telegramId,
          p_username: username,
        });
        const data = unwrapSingleRow<Record<string, unknown>>(result);
        return NextResponse.json({ data });
      }

      case "joinHousehold": {
        const inviteCode = asString(payload.inviteCode, "inviteCode").toUpperCase();
        const result = await rpc("api_join_household", {
          p_telegram_id: telegramId,
          p_invite_code: inviteCode,
        });
        const data = unwrapSingleRow<Record<string, unknown>>(result);
        return NextResponse.json({ data });
      }

      case "listHouseholds": {
        const raw = (await rpc("api_list_households", {
          p_telegram_id: telegramId,
        })) as Array<Record<string, unknown>> | null;
        const rows = raw ?? [];
        const data = rows.map((row) => ({
          household_id: String(row.household_id),
          household_name: String(row.household_name ?? ""),
          invite_code:
            row.invite_code == null || row.invite_code === ""
              ? null
              : String(row.invite_code),
          is_active: Boolean(row.is_active),
        }));
        return NextResponse.json({ data });
      }

      case "createHousehold": {
        const name = asOptionalString(payload.name);
        const result = await rpc("api_create_household", {
          p_telegram_id: telegramId,
          p_name: name,
        });
        const data = unwrapSingleRow<Record<string, unknown>>(result);
        return NextResponse.json({ data });
      }

      case "setActiveHousehold": {
        const householdId = asUuid(payload.householdId, "householdId");
        const result = await rpc("api_set_active_household", {
          p_telegram_id: telegramId,
          p_household_id: householdId,
        });
        const data = unwrapSingleRow<Record<string, unknown>>(result);
        return NextResponse.json({ data });
      }

      case "listRooms": {
        const rooms = (await rpc("api_list_rooms", {
          p_telegram_id: telegramId,
        })) as Array<Record<string, unknown>> | null;
        const data = await enrichRoomsWithSignedUrls(rooms ?? []);
        return NextResponse.json({ data });
      }

      case "createRoom": {
        const name = asString(payload.name, "name");
        const result = await rpc("api_create_room", {
          p_telegram_id: telegramId,
          p_name: name,
        });
        const room = unwrapSingleRow<Record<string, unknown>>(result);
        const [data] = await enrichRoomsWithSignedUrls([room]);
        return NextResponse.json({ data });
      }

      case "deleteRoom": {
        const roomId = asUuid(payload.roomId, "roomId");
        await rpc("api_delete_room", {
          p_telegram_id: telegramId,
          p_room_id: roomId,
        });
        return NextResponse.json({ data: { ok: true as const } });
      }

      case "listRoomDetails": {
        const roomId = asString(payload.roomId, "roomId");
        const data = await rpc("api_room_details", {
          p_telegram_id: telegramId,
          p_room_id: roomId,
        });
        return NextResponse.json({ data });
      }

      case "createPlant": {
        const roomId = asString(payload.roomId, "roomId");
        const name = asString(payload.name, "name");
        const species = asOptionalString(payload.species);
        const status = asPlantStatus(payload.status);
        const result = await rpc("api_create_plant", {
          p_telegram_id: telegramId,
          p_room_id: roomId,
          p_name: name,
          p_species: species,
          p_status: status,
        });
        const data = unwrapSingleRow<Record<string, unknown>>(result);
        return NextResponse.json({ data });
      }

      case "waterPlant": {
        const plantId = asString(payload.plantId, "plantId");
        const result = await rpc("api_water_plant", {
          p_telegram_id: telegramId,
          p_plant_id: plantId,
        });
        const data = unwrapSingleRow<Record<string, unknown>>(result);
        return NextResponse.json({ data });
      }

      case "updatePlant": {
        const plantId = asString(payload.plantId, "plantId");
        const name = asString(payload.name, "name");
        const species = asOptionalString(payload.species);
        const status = asPlantStatus(payload.status);
        const result = await rpc("api_update_plant", {
          p_telegram_id: telegramId,
          p_plant_id: plantId,
          p_name: name,
          p_species: species,
          p_status: status,
        });
        const data = unwrapSingleRow<Record<string, unknown>>(result);
        return NextResponse.json({ data });
      }

      case "upsertMarker": {
        const roomId = asString(payload.roomId, "roomId");
        const plantId = asString(payload.plantId, "plantId");
        const x = Number(payload.x);
        const y = Number(payload.y);
        if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) {
          return NextResponse.json({ error: "Invalid marker coordinates" }, { status: 400 });
        }
        const result = await rpc("api_upsert_marker", {
          p_telegram_id: telegramId,
          p_room_id: roomId,
          p_plant_id: plantId,
          p_x: x,
          p_y: y,
        });
        const data = unwrapSingleRow<Record<string, unknown>>(result);
        return NextResponse.json({ data });
      }

      case "createRoomImageSignedUrl": {
        const roomId = asString(payload.roomId, "roomId");
        const fileName = asString(payload.fileName, "fileName");
        const result = await rpc("api_prepare_room_image_upload", {
          p_telegram_id: telegramId,
          p_room_id: roomId,
          p_file_name: fileName,
        });
        const data = unwrapSingleRow<Record<string, unknown>>(result);
        return NextResponse.json({ data });
      }

      default:
        return NextResponse.json({ error: "Unsupported action" }, { status: 400 });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown secure API error";
    console.warn("[secure-api] request failed", {
      action: actionForLog,
      hasInitDataHeader,
      isTelegramUserAgent,
      method: request.method,
      path: request.nextUrl.pathname,
      message,
    });
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
