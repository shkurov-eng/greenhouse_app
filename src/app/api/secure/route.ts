import { NextResponse, type NextRequest } from "next/server";

import { getSupabaseAdmin } from "@/lib/server/supabaseAdmin";
import { getRequestTelegramId } from "@/lib/server/telegramAuth";

type SecureAction =
  | "bootstrap"
  | "joinHousehold"
  | "listHouseholds"
  | "createHousehold"
  | "setActiveHousehold"
  | "deleteHousehold"
  | "renameHousehold"
  | "listRooms"
  | "createRoom"
  | "renameRoom"
  | "deleteRoom"
  | "listRoomDetails"
  | "createPlant"
  | "waterPlant"
  | "revertLastWatering"
  | "deletePlant"
  | "removePlantPhoto"
  | "updatePlant"
  | "upsertMarker"
  | "createRoomImageSignedUrl"
  | "listTasks"
  | "createTask"
  | "updateTaskStatus"
  | "deleteTask";

type RequestBody = {
  action?: SecureAction;
  payload?: Record<string, unknown>;
};

type DbError = { message: string } | null;
type DbWriteResult = Promise<{ error: DbError }>;
type DbSingleResult = Promise<{ data: unknown; error: DbError }>;

type SelectQueryBuilder = {
  eq: (column: string, value: string | number) => SelectQueryBuilder;
  is: (column: string, value: null) => SelectQueryBuilder;
  order: (column: string, options: { ascending: boolean }) => SelectQueryBuilder;
  limit: (count: number) => SelectQueryBuilder;
  maybeSingle: () => DbSingleResult;
};

type LooseTableApi = {
  from: (table: string) => {
    update: (values: Record<string, unknown>) => {
      eq: (column: string, value: string | number) => DbWriteResult;
    };
    insert: (values: Record<string, unknown>) => DbWriteResult;
    delete: () => {
      eq: (column: string, value: string | number) => DbWriteResult;
    };
    select: (columns: string) => SelectQueryBuilder;
  };
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

function asThresholdMinutes(value: unknown, fieldName: string) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`Invalid ${fieldName}`);
  }
  return n;
}

function asTaskStatus(value: unknown) {
  if (value === "open" || value === "done") {
    return value;
  }
  throw new Error("Invalid task status");
}

function asTaskPriority(value: unknown) {
  if (value === "low" || value === "normal" || value === "high") {
    return value;
  }
  throw new Error("Invalid task priority");
}

function asOptionalIsoDate(value: unknown, fieldName: string) {
  if (value == null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new Error(`Invalid ${fieldName}`);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const parsed = Date.parse(trimmed);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid ${fieldName}`);
  }
  return new Date(parsed).toISOString();
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

async function getScopedPlantForActiveHousehold(telegramId: string | number, plantId: string) {
  const supabaseAdmin = getSupabaseAdmin();
  const { data: profile, error: profileError } = await supabaseAdmin
    .from("profiles")
    .select("active_household_id")
    .eq("telegram_id", telegramId)
    .single();
  if (profileError) {
    throw new Error(profileError.message);
  }
  const profileRow = profile as { active_household_id?: string | null } | null;
  const activeHouseholdId = profileRow?.active_household_id ?? null;
  if (!activeHouseholdId) {
    throw new Error("No active household");
  }
  const { data: plantRow, error: plantError } = await supabaseAdmin
    .from("plants")
    .select("id,last_watered_at,rooms!inner(household_id)")
    .eq("id", plantId)
    .single();
  if (plantError) {
    throw new Error(plantError.message);
  }
  const plantRowData = plantRow as
    | { last_watered_at?: string | null; rooms?: { household_id?: string | null } | null }
    | null;
  const plantHouseholdId = plantRowData?.rooms?.household_id ?? null;
  if (!plantHouseholdId || plantHouseholdId !== activeHouseholdId) {
    throw new Error("Plant not found in active household");
  }
  return {
    supabaseAdmin,
    lastWateredAt:
      plantRowData?.last_watered_at == null ? null : String(plantRowData.last_watered_at),
  };
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

async function enrichPlantsWithSignedUrls(rows: Array<Record<string, unknown>>) {
  const supabaseAdmin = getSupabaseAdmin();
  const paths = rows
    .map((row) => row.photo_path)
    .filter((path): path is string => typeof path === "string" && path.trim().length > 0);
  const uniquePaths = [...new Set(paths)];

  if (uniquePaths.length === 0) {
    return rows.map((row) => ({ ...row, signed_photo_url: null }));
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

  return rows.map((row) => {
    const path = typeof row.photo_path === "string" && row.photo_path.trim() ? row.photo_path.trim() : null;
    return {
      ...row,
      signed_photo_url: path ? signedByPath.get(path) ?? null : null,
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

      case "deleteHousehold": {
        const householdId = asUuid(payload.householdId, "householdId");
        await rpc("api_delete_household", {
          p_telegram_id: telegramId,
          p_household_id: householdId,
        });
        return NextResponse.json({ data: { ok: true as const } });
      }

      case "renameHousehold": {
        const householdId = asUuid(payload.householdId, "householdId");
        const name = asString(payload.name, "name");
        const result = await rpc("api_rename_household", {
          p_telegram_id: telegramId,
          p_household_id: householdId,
          p_name: name,
        });
        const row = unwrapSingleRow<Record<string, unknown>>(result);
        const data = {
          household_id: String(row.household_id),
          household_name: String(row.household_name ?? ""),
          invite_code:
            row.invite_code == null || row.invite_code === ""
              ? null
              : String(row.invite_code),
        };
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

      case "renameRoom": {
        const roomId = asUuid(payload.roomId, "roomId");
        const name = asString(payload.name, "name");
        const result = await rpc("api_rename_room", {
          p_telegram_id: telegramId,
          p_room_id: roomId,
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
        const details = (await rpc("api_room_details", {
          p_telegram_id: telegramId,
          p_room_id: roomId,
        })) as { plants?: Array<Record<string, unknown>>; markers?: Array<Record<string, unknown>> } | null;
        const plants = await enrichPlantsWithSignedUrls(details?.plants ?? []);
        const data = {
          plants,
          markers: details?.markers ?? [],
        };
        return NextResponse.json({ data });
      }

      case "createPlant": {
        const roomId = asString(payload.roomId, "roomId");
        const name = asString(payload.name, "name");
        const species = asOptionalString(payload.species);
        const status = asPlantStatus(payload.status);
        const thirstyAfterMinutes = asThresholdMinutes(
          payload.thirstyAfterMinutes,
          "thirstyAfterMinutes",
        );
        const overdueAfterMinutes = asThresholdMinutes(
          payload.overdueAfterMinutes,
          "overdueAfterMinutes",
        );
        if (overdueAfterMinutes < thirstyAfterMinutes) {
          throw new Error("Invalid watering thresholds");
        }
        const result = await rpc("api_create_plant", {
          p_telegram_id: telegramId,
          p_room_id: roomId,
          p_name: name,
          p_species: species,
          p_status: status,
          p_thirsty_after_minutes: thirstyAfterMinutes,
          p_overdue_after_minutes: overdueAfterMinutes,
        });
        const data = unwrapSingleRow<Record<string, unknown>>(result);
        return NextResponse.json({ data });
      }

      case "waterPlant": {
        const plantId = asUuid(payload.plantId, "plantId");
        const { supabaseAdmin, lastWateredAt } = await getScopedPlantForActiveHousehold(
          telegramId,
          plantId,
        );
        const nextWateredAt = new Date().toISOString();
        const db = supabaseAdmin as unknown as LooseTableApi;
        const { error: waterUpdateError } = await db
          .from("plants")
          .update({
            last_watered_at: nextWateredAt,
            status: "healthy",
          })
          .eq("id", plantId);
        if (waterUpdateError) {
          throw new Error(waterUpdateError.message);
        }
        const { error: historyError } = await db.from("plant_watering_events").insert({
          plant_id: plantId,
          previous_last_watered_at: lastWateredAt,
        });
        if (historyError) {
          throw new Error(
            `Failed to save watering history: ${historyError.message}. Apply watering_undo_history.sql`,
          );
        }
        return NextResponse.json({
          data: {
            id: plantId,
            last_watered_at: nextWateredAt,
          },
        });
      }

      case "revertLastWatering": {
        const plantId = asUuid(payload.plantId, "plantId");
        const { supabaseAdmin } = await getScopedPlantForActiveHousehold(telegramId, plantId);
        const db = supabaseAdmin as unknown as LooseTableApi;
        const { data: latestEvent, error: latestEventError } = await db
          .from("plant_watering_events")
          .select("id,previous_last_watered_at")
          .eq("plant_id", plantId)
          .is("undone_at", null)
          .order("watered_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        if (latestEventError) {
          throw new Error(latestEventError.message);
        }
        if (!latestEvent) {
          throw new Error("No recent watering to undo");
        }
        const latestEventRow = latestEvent as { id?: string; previous_last_watered_at?: string | null };
        const previousLastWateredAt =
          latestEventRow.previous_last_watered_at == null
            ? null
            : String(latestEventRow.previous_last_watered_at);
        const { error: updateError } = await db
          .from("plants")
          .update({ last_watered_at: previousLastWateredAt })
          .eq("id", plantId);
        if (updateError) {
          throw new Error(updateError.message);
        }
        const { error: markUndoneError } = await db
          .from("plant_watering_events")
          .update({ undone_at: new Date().toISOString() })
          .eq("id", String(latestEventRow.id));
        if (markUndoneError) {
          throw new Error(markUndoneError.message);
        }
        return NextResponse.json({
          data: {
            id: plantId,
            last_watered_at: previousLastWateredAt,
          },
        });
      }

      case "deletePlant": {
        const plantId = asUuid(payload.plantId, "plantId");
        const { supabaseAdmin } = await getScopedPlantForActiveHousehold(telegramId, plantId);
        const db = supabaseAdmin as unknown as LooseTableApi;
        const { error: deleteMarkersError } = await db
          .from("plant_markers")
          .delete()
          .eq("plant_id", plantId);
        if (deleteMarkersError) {
          throw new Error(deleteMarkersError.message);
        }
        const { error: deletePlantError } = await db.from("plants").delete().eq("id", plantId);
        if (deletePlantError) {
          throw new Error(deletePlantError.message);
        }
        return NextResponse.json({ data: { ok: true as const } });
      }

      case "removePlantPhoto": {
        const plantId = asUuid(payload.plantId, "plantId");
        const { supabaseAdmin } = await getScopedPlantForActiveHousehold(telegramId, plantId);
        const { data: plantRow, error: plantReadError } = await supabaseAdmin
          .from("plants")
          .select("photo_path")
          .eq("id", plantId)
          .single();
        if (plantReadError) {
          throw new Error(plantReadError.message);
        }
        const existingPhotoPath =
          (plantRow as { photo_path?: string | null } | null)?.photo_path ?? null;

        const db = supabaseAdmin as unknown as LooseTableApi;
        const { error: updateError } = await db
          .from("plants")
          .update({ photo_path: null })
          .eq("id", plantId);
        if (updateError) {
          throw new Error(updateError.message);
        }

        if (existingPhotoPath) {
          const { error: storageError } = await supabaseAdmin
            .storage
            .from("rooms")
            .remove([existingPhotoPath]);
          if (storageError) {
            console.warn("[secure-api] failed to remove old plant photo from storage", {
              plantId,
              message: storageError.message,
            });
          }
        }

        return NextResponse.json({
          data: {
            id: plantId,
            photo_path: null,
            signed_photo_url: null,
          },
        });
      }

      case "updatePlant": {
        const plantId = asString(payload.plantId, "plantId");
        const name = asString(payload.name, "name");
        const species = asOptionalString(payload.species);
        const status = asPlantStatus(payload.status);
        const thirstyAfterMinutes = asThresholdMinutes(
          payload.thirstyAfterMinutes,
          "thirstyAfterMinutes",
        );
        const overdueAfterMinutes = asThresholdMinutes(
          payload.overdueAfterMinutes,
          "overdueAfterMinutes",
        );
        if (overdueAfterMinutes < thirstyAfterMinutes) {
          throw new Error("Invalid watering thresholds");
        }
        const result = await rpc("api_update_plant", {
          p_telegram_id: telegramId,
          p_plant_id: plantId,
          p_name: name,
          p_species: species,
          p_status: status,
          p_thirsty_after_minutes: thirstyAfterMinutes,
          p_overdue_after_minutes: overdueAfterMinutes,
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

      case "listTasks": {
        const raw = (await rpc("api_list_tasks", {
          p_telegram_id: telegramId,
        })) as Array<Record<string, unknown>> | null;
        return NextResponse.json({ data: raw ?? [] });
      }

      case "createTask": {
        const title = asString(payload.title, "title");
        const description = asOptionalString(payload.description);
        const priority = payload.priority == null ? "normal" : asTaskPriority(payload.priority);
        const dueAt = asOptionalIsoDate(payload.dueAt, "dueAt");
        const result = await rpc("api_create_task", {
          p_telegram_id: telegramId,
          p_title: title,
          p_description: description,
          p_priority: priority,
          p_due_at: dueAt,
        });
        const data = unwrapSingleRow<Record<string, unknown>>(result);
        return NextResponse.json({ data });
      }

      case "updateTaskStatus": {
        const taskId = asUuid(payload.taskId, "taskId");
        const status = asTaskStatus(payload.status);
        const result = await rpc("api_update_task_status", {
          p_telegram_id: telegramId,
          p_task_id: taskId,
          p_status: status,
        });
        const data = unwrapSingleRow<Record<string, unknown>>(result);
        return NextResponse.json({ data });
      }

      case "deleteTask": {
        const taskId = asUuid(payload.taskId, "taskId");
        await rpc("api_delete_task", {
          p_telegram_id: telegramId,
          p_task_id: taskId,
        });
        return NextResponse.json({ data: { ok: true as const } });
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
