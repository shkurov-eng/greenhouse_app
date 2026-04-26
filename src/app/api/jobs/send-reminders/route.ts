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

const DUE_SOON_LEAD_MS = 15 * 60 * 1000;
const DUE_SOON_GRACE_MS = 5 * 60 * 1000;
const DUE_SOON_DEDUPE_MS = 15 * 60 * 1000;
const OVERDUE_DEDUPE_MS = 24 * 60 * 60 * 1000;

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

    return NextResponse.json({ data: { ok: true, sent, skipped, failed, scanned: tasks.length } });
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
