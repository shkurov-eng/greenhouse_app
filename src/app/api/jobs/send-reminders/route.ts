import { NextResponse, type NextRequest } from "next/server";

import { getSupabaseAdmin } from "@/lib/server/supabaseAdmin";

type DbError = { message: string } | null;
type DbWriteResult = Promise<{ error: DbError }>;
type LooseInsertApi = {
  from: (table: string) => {
    insert: (values: Record<string, unknown>) => DbWriteResult;
  };
};

type ReminderKind = "due_soon" | "overdue";

type CandidateTask = {
  id: string;
  title: string;
  due_at: string | null;
  created_by_profile_id: string | null;
};

type ProfileReminderSettings = {
  telegram_id?: number | string | null;
  repeat_overdue_reminders?: boolean | null;
};

type PlantStatus = "healthy" | "thirsty" | "overdue";
type WateringSlot = "morning" | "evening";
type WateringSeverity = "gentle" | "strict";

type PlantReminderCandidate = {
  id: string;
  household_id: string | null;
  last_watered_at: string | null;
  thirsty_after_hours: number | null;
  overdue_after_hours: number | null;
  name: string | null;
};

type HouseholdMemberRow = {
  household_id: string | null;
  user_id: string | null;
};

type PlantReminderProfileSettings = {
  id: string;
  telegram_id?: number | string | null;
  watering_reminders_enabled?: boolean | null;
  watering_reminder_schedule?: string | null;
  watering_reminder_morning_minute_utc?: number | null;
  watering_reminder_evening_minute_utc?: number | null;
};

const DUE_SOON_LEAD_MS = 15 * 60 * 1000;
const DUE_SOON_GRACE_MS = 5 * 60 * 1000;
const DUE_SOON_DEDUPE_MS = 15 * 60 * 1000;
const OVERDUE_DEDUPE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_PLANT_THIRSTY_AFTER_HOURS = 72;
const DEFAULT_PLANT_OVERDUE_AFTER_HOURS = 96;
const DEFAULT_WATERING_MORNING_MINUTE_UTC = 8 * 60;
const DEFAULT_WATERING_EVENING_MINUTE_UTC = 19 * 60;

function getAcceptedJobSecrets() {
  return [process.env.TASK_REMINDER_JOB_SECRET, process.env.CRON_SECRET]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));
}

function getProvidedJobSecret(request: NextRequest) {
  const explicitHeader = request.headers.get("x-job-secret")?.trim();
  if (explicitHeader) {
    return explicitHeader;
  }

  const authorization = request.headers.get("authorization")?.trim();
  const bearerPrefix = "Bearer ";
  if (authorization?.startsWith(bearerPrefix)) {
    return authorization.slice(bearerPrefix.length).trim();
  }

  return null;
}

function classifyReminderKind(dueAt: string): ReminderKind {
  const due = new Date(dueAt).getTime();
  return due < Date.now() - DUE_SOON_GRACE_MS ? "overdue" : "due_soon";
}

function normalizeMinute(value: number | null | undefined, fallback: number) {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 1439) {
    return value;
  }
  return fallback;
}

function getCurrentWateringSlotForProfile(date: Date, profile: PlantReminderProfileSettings): WateringSlot | null {
  const minuteOfDayUtc = date.getUTCHours() * 60 + date.getUTCMinutes();
  const morningMinuteUtc = normalizeMinute(
    profile.watering_reminder_morning_minute_utc,
    DEFAULT_WATERING_MORNING_MINUTE_UTC,
  );
  const eveningMinuteUtc = normalizeMinute(
    profile.watering_reminder_evening_minute_utc,
    DEFAULT_WATERING_EVENING_MINUTE_UTC,
  );
  if (minuteOfDayUtc === morningMinuteUtc) {
    return "morning";
  }
  if (minuteOfDayUtc === eveningMinuteUtc) {
    return "evening";
  }
  return null;
}

function derivePlantStatus(plant: PlantReminderCandidate): PlantStatus {
  if (!plant.last_watered_at) {
    return "overdue";
  }
  const lastWateredMs = Date.parse(plant.last_watered_at);
  if (!Number.isFinite(lastWateredMs)) {
    return "overdue";
  }
  const thirstyAfterHours =
    typeof plant.thirsty_after_hours === "number" && plant.thirsty_after_hours > 0
      ? plant.thirsty_after_hours
      : DEFAULT_PLANT_THIRSTY_AFTER_HOURS;
  const overdueAfterHours =
    typeof plant.overdue_after_hours === "number" && plant.overdue_after_hours > 0
      ? Math.max(plant.overdue_after_hours, thirstyAfterHours)
      : Math.max(DEFAULT_PLANT_OVERDUE_AFTER_HOURS, thirstyAfterHours);

  const elapsedMs = Date.now() - lastWateredMs;
  const thirstyMs = thirstyAfterHours * 60 * 60 * 1000;
  const overdueMs = overdueAfterHours * 60 * 60 * 1000;
  if (elapsedMs < thirstyMs) {
    return "healthy";
  }
  if (elapsedMs < overdueMs) {
    return "thirsty";
  }
  return "overdue";
}

function shouldSendBySchedule(scheduleRaw: string | null | undefined, slot: WateringSlot) {
  const schedule = scheduleRaw === "morning" || scheduleRaw === "evening" ? scheduleRaw : "both";
  if (schedule === "both") {
    return true;
  }
  return schedule === slot;
}

async function sendTelegramMessage(chatId: string, text: string) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    throw new Error("Missing TELEGRAM_BOT_TOKEN");
  }
  const response = await fetch(`https://api.telegram.org/bot${encodeURIComponent(token)}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      disable_notification: false,
    }),
  });
  if (!response.ok) {
    const body = await response.text();
    const compact = body.replace(/\s+/g, " ").trim().slice(0, 220);
    throw new Error(`Telegram sendMessage failed: ${compact || response.statusText}`);
  }
}

async function handleReminderJob(request: NextRequest) {
  try {
    const acceptedSecrets = getAcceptedJobSecrets();
    if (acceptedSecrets.length > 0) {
      const provided = getProvidedJobSecret(request);
      if (!provided || !acceptedSecrets.includes(provided)) {
        return NextResponse.json({ error: "Unauthorized job request" }, { status: 401 });
      }
    }

    const supabaseAdmin = getSupabaseAdmin();
    const nowMs = Date.now();
    const dueWindowEndIso = new Date(nowMs + DUE_SOON_LEAD_MS).toISOString();
    const { data, error } = await supabaseAdmin
      .from("tasks")
      .select("id,title,due_at,created_by_profile_id")
      .eq("status", "open")
      .not("due_at", "is", null)
      .lte("due_at", dueWindowEndIso)
      .order("due_at", { ascending: false })
      .limit(100);
    if (error) {
      throw new Error(error.message);
    }

    const tasks = (data ?? []) as CandidateTask[];
    let sent = 0;
    let skipped = 0;
    let failed = 0;

    for (const task of tasks) {
      if (!task.due_at || !task.created_by_profile_id) {
        skipped += 1;
        continue;
      }
      const kind = classifyReminderKind(task.due_at);
      const dedupeWindowMs = kind === "overdue" ? OVERDUE_DEDUPE_MS : DUE_SOON_DEDUPE_MS;
      const sinceIso = new Date(Date.now() - dedupeWindowMs).toISOString();

      const { data: existingLog, error: existingLogError } = await supabaseAdmin
        .from("task_reminders_log")
        .select("id")
        .eq("task_id", task.id)
        .eq("reminder_type", kind)
        .gte("sent_at", sinceIso)
        .limit(1);
      if (existingLogError) {
        throw new Error(existingLogError.message);
      }
      if ((existingLog ?? []).length > 0) {
        skipped += 1;
        continue;
      }

      const { data: profileRow, error: profileError } = await supabaseAdmin
        .from("profiles")
        .select("telegram_id,repeat_overdue_reminders")
        .eq("id", task.created_by_profile_id)
        .single();
      if (profileError) {
        skipped += 1;
        continue;
      }
      const profileSettings = (profileRow as ProfileReminderSettings | null) ?? {};
      const telegramId = String(profileSettings.telegram_id ?? "");
      if (!telegramId) {
        skipped += 1;
        continue;
      }
      const repeatOverdueReminders = profileSettings.repeat_overdue_reminders !== false;
      const shouldCheckAnyOverdueLog = kind === "overdue" && !repeatOverdueReminders;

      const dueText = new Date(task.due_at).toLocaleString();
      const prefix = kind === "overdue" ? "Overdue task" : "Task reminder";

      if (shouldCheckAnyOverdueLog) {
        const { data: anyOverdueLog, error: anyOverdueLogError } = await supabaseAdmin
          .from("task_reminders_log")
          .select("id")
          .eq("task_id", task.id)
          .eq("reminder_type", "overdue")
          .limit(1);
        if (anyOverdueLogError) {
          throw new Error(anyOverdueLogError.message);
        }
        if ((anyOverdueLog ?? []).length > 0) {
          skipped += 1;
          continue;
        }
      }

      try {
        await sendTelegramMessage(telegramId, `${prefix}: ${task.title}\nDue: ${dueText}`);
      } catch (sendError) {
        failed += 1;
        const message =
          sendError instanceof Error ? sendError.message : "Unknown Telegram sendMessage error";
        console.warn("[send-reminders] failed to send telegram reminder", {
          taskId: task.id,
          reminderType: kind,
          telegramId,
          message,
        });
        continue;
      }
      sent += 1;

      const db = supabaseAdmin as unknown as LooseInsertApi;
      const { error: logError } = await db.from("task_reminders_log").insert({
        task_id: task.id,
        reminder_type: kind,
        sent_to_telegram_id: Number.isFinite(Number(telegramId)) ? Number(telegramId) : null,
        payload: {
          title: task.title,
          due_at: task.due_at,
        },
      });
      if (logError) {
        throw new Error(logError.message);
      }
    }

    const now = new Date();
    let plantSent = 0;
    let plantSkipped = 0;
    let plantFailed = 0;
    let plantHouseholdsScanned = 0;

    const { data: rawPlants, error: plantsError } = await supabaseAdmin
      .from("plants")
      .select("id,household_id,last_watered_at,thirsty_after_hours,overdue_after_hours,name")
      .limit(2000);
    if (plantsError) {
      throw new Error(plantsError.message);
    }

    const plants = (rawPlants ?? []) as PlantReminderCandidate[];
    const byHousehold = new Map<
      string,
      { hasOverdue: boolean; hasThirsty: boolean; redCount: number; orangeCount: number; names: string[] }
    >();

    for (const plant of plants) {
      const householdId = plant.household_id;
      if (!householdId) {
        continue;
      }
      const current = byHousehold.get(householdId) ?? {
        hasOverdue: false,
        hasThirsty: false,
        redCount: 0,
        orangeCount: 0,
        names: [],
      };
      const status = derivePlantStatus(plant);
      if (status === "healthy") {
        continue;
      }
      if (status === "overdue") {
        current.hasOverdue = true;
        current.redCount += 1;
      } else if (status === "thirsty") {
        current.hasThirsty = true;
        current.orangeCount += 1;
      }
      if (plant.name && current.names.length < 5) {
        current.names.push(plant.name);
      }
      byHousehold.set(householdId, current);
    }

    plantHouseholdsScanned = byHousehold.size;
    const sentOn = now.toISOString().slice(0, 10);

    for (const [householdId, summary] of byHousehold) {
      const severity: WateringSeverity = summary.hasOverdue ? "strict" : "gentle";

      const { data: membersData, error: membersError } = await supabaseAdmin
        .from("household_members")
        .select("household_id,user_id")
        .eq("household_id", householdId);
      if (membersError) {
        throw new Error(membersError.message);
      }

      const members = (membersData ?? []) as HouseholdMemberRow[];
      const profileIds = members
        .map((member) => member.user_id)
        .filter((value): value is string => typeof value === "string" && value.length > 0);
      if (profileIds.length === 0) {
        continue;
      }

      const { data: profileData, error: profileError } = await supabaseAdmin
        .from("profiles")
        .select(
          "id,telegram_id,watering_reminders_enabled,watering_reminder_schedule,watering_reminder_morning_minute_utc,watering_reminder_evening_minute_utc",
        )
        .in("id", profileIds);
      if (profileError) {
        throw new Error(profileError.message);
      }

      const profiles = (profileData ?? []) as PlantReminderProfileSettings[];
      for (const profile of profiles) {
        const wateringSlot = getCurrentWateringSlotForProfile(now, profile);
        const telegramId = String(profile.telegram_id ?? "");
        const enabled = profile.watering_reminders_enabled !== false;
        if (
          !wateringSlot ||
          !enabled ||
          !telegramId ||
          !shouldSendBySchedule(profile.watering_reminder_schedule, wateringSlot)
        ) {
          plantSkipped += 1;
          continue;
        }

        const { data: existingLog, error: existingLogError } = await supabaseAdmin
          .from("plant_watering_reminders_log")
          .select("id")
          .eq("household_id", householdId)
          .eq("profile_id", profile.id)
          .eq("slot", wateringSlot)
          .eq("sent_on", sentOn)
          .limit(1);
        if (existingLogError) {
          throw new Error(existingLogError.message);
        }
        if ((existingLog ?? []).length > 0) {
          plantSkipped += 1;
          continue;
        }

        const namesLine = summary.names.length > 0 ? `\nРастения: ${summary.names.join(", ")}` : "";
        const text =
          severity === "strict"
            ? `Срочное напоминание о поливе: в доме есть растения с красным статусом (${summary.redCount}). Пожалуйста, полейте сегодня.${namesLine}`
            : `Легкое напоминание о поливе: в доме есть растения с оранжевым статусом (${summary.orangeCount}).`;

        try {
          await sendTelegramMessage(telegramId, text);
        } catch (sendError) {
          plantFailed += 1;
          const message =
            sendError instanceof Error ? sendError.message : "Unknown Telegram sendMessage error";
          console.warn("[send-reminders] failed to send plant watering reminder", {
            householdId,
            profileId: profile.id,
            slot: wateringSlot,
            severity,
            telegramId,
            message,
          });
          continue;
        }

        plantSent += 1;
        const db = supabaseAdmin as unknown as LooseInsertApi;
        const { error: logError } = await db.from("plant_watering_reminders_log").insert({
          household_id: householdId,
          profile_id: profile.id,
          slot: wateringSlot,
          severity,
          sent_to_telegram_id: Number.isFinite(Number(telegramId)) ? Number(telegramId) : null,
          sent_on: sentOn,
          payload: {
            red_count: summary.redCount,
            orange_count: summary.orangeCount,
            sample_names: summary.names,
          },
        });
        if (logError) {
          throw new Error(logError.message);
        }
      }
    }

    return NextResponse.json({
      data: {
        ok: true,
        sent,
        skipped,
        failed,
        scanned: tasks.length,
        watering: {
          slot: null,
          sent: plantSent,
          skipped: plantSkipped,
          failed: plantFailed,
          householdsScanned: plantHouseholdsScanned,
        },
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Reminder job failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

export async function GET(request: NextRequest) {
  return handleReminderJob(request);
}

export async function POST(request: NextRequest) {
  return handleReminderJob(request);
}
