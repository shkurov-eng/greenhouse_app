"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowLeft, CheckCircle2, Circle, Inbox, RefreshCw } from "lucide-react";

import { MobileShell } from "@/components/MobileShell";
import { listHouseholds, listTasks, updateTaskStatus, type Task } from "@/lib/api";

function resolveTelegramInitData() {
  if (typeof window === "undefined") {
    return null;
  }
  const telegram = (window as Window & { Telegram?: { WebApp?: { initData?: string } } }).Telegram;
  return telegram?.WebApp?.initData?.trim() || null;
}

export default function TasksPage() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [householdNameById, setHouseholdNameById] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<string | null>(null);
  const [busyTaskId, setBusyTaskId] = useState<string | null>(null);
  const [scopeFilter, setScopeFilter] = useState<"all" | "personal" | "household">("all");
  const [sortBy, setSortBy] = useState<
    "created_desc" | "created_asc" | "due_asc" | "due_desc" | "scope_personal_first" | "scope_household_first"
  >("created_desc");
  const [deadlineFrom, setDeadlineFrom] = useState("");
  const [deadlineTo, setDeadlineTo] = useState("");

  const initData = useMemo(() => resolveTelegramInitData(), []);

  const loadTasks = useCallback(async () => {
    setLoading(true);
    setMessage(null);
    try {
      const [data, households] = await Promise.all([listTasks(initData), listHouseholds(initData)]);
      setTasks(data);
      const nextMap: Record<string, string> = {};
      for (const household of households) {
        nextMap[household.household_id] = household.household_name;
      }
      setHouseholdNameById(nextMap);
    } catch (error) {
      const text = error instanceof Error ? error.message : "Failed to load tasks";
      setMessage(text);
    } finally {
      setLoading(false);
    }
  }, [initData]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadTasks();
    }, 0);
    return () => {
      window.clearTimeout(timer);
    };
  }, [loadTasks]);

  const toggleStatus = useCallback(
    async (task: Task) => {
      const nextStatus = task.status === "open" ? "done" : "open";
      setBusyTaskId(task.id);
      setMessage(null);
      try {
        await updateTaskStatus(initData, { taskId: task.id, status: nextStatus });
        setTasks((prev) =>
          prev.map((item) =>
            item.id === task.id
              ? {
                  ...item,
                  status: nextStatus,
                  updated_at: new Date().toISOString(),
                }
              : item,
          ),
        );
      } catch (error) {
        const text = error instanceof Error ? error.message : "Failed to update task";
        setMessage(text);
      } finally {
        setBusyTaskId(null);
      }
    },
    [initData],
  );

  const visibleTasks = useMemo(() => {
    const startMs = deadlineFrom ? new Date(`${deadlineFrom}T00:00:00`).getTime() : null;
    const endMs = deadlineTo ? new Date(`${deadlineTo}T23:59:59.999`).getTime() : null;

    const filtered = tasks.filter((task) => {
      if (scopeFilter !== "all" && task.task_scope !== scopeFilter) {
        return false;
      }
      if (startMs == null && endMs == null) {
        return true;
      }
      if (!task.due_at) {
        return false;
      }
      const dueMs = new Date(task.due_at).getTime();
      if (Number.isNaN(dueMs)) {
        return false;
      }
      if (startMs != null && dueMs < startMs) {
        return false;
      }
      if (endMs != null && dueMs > endMs) {
        return false;
      }
      return true;
    });

    const scopeWeight = (scope: Task["task_scope"], mode: "personal" | "household") => {
      if (mode === "personal") {
        return scope === "personal" ? 0 : 1;
      }
      return scope === "household" ? 0 : 1;
    };

    return [...filtered].sort((a, b) => {
      switch (sortBy) {
        case "created_asc":
          return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
        case "due_asc": {
          const ad = a.due_at ? new Date(a.due_at).getTime() : Number.POSITIVE_INFINITY;
          const bd = b.due_at ? new Date(b.due_at).getTime() : Number.POSITIVE_INFINITY;
          return ad - bd;
        }
        case "due_desc": {
          const ad = a.due_at ? new Date(a.due_at).getTime() : Number.NEGATIVE_INFINITY;
          const bd = b.due_at ? new Date(b.due_at).getTime() : Number.NEGATIVE_INFINITY;
          return bd - ad;
        }
        case "scope_personal_first": {
          const sw = scopeWeight(a.task_scope, "personal") - scopeWeight(b.task_scope, "personal");
          if (sw !== 0) {
            return sw;
          }
          return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
        }
        case "scope_household_first": {
          const sw = scopeWeight(a.task_scope, "household") - scopeWeight(b.task_scope, "household");
          if (sw !== 0) {
            return sw;
          }
          return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
        }
        case "created_desc":
        default:
          return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
      }
    });
  }, [tasks, scopeFilter, sortBy, deadlineFrom, deadlineTo]);

  return (
    <MobileShell>
      <main className="min-h-screen bg-[#fff8f5] pb-32 text-[#1f1b17]">
        <div className="mx-auto w-full max-w-5xl px-5 pt-6">
          <header className="mb-8 flex items-center gap-3">
            <Link href="/" className="rounded-full bg-white p-2 text-[#6c7a71] shadow-sm" aria-label="Back to rooms">
              <ArrowLeft className="h-5 w-5" />
            </Link>
            <div className="flex items-center gap-2">
              <Inbox className="h-5 w-5 text-[#006c49]" />
              <h1 className="text-lg font-extrabold tracking-tight text-[#006c49]">Tasks</h1>
            </div>
          </header>
          <section className="rounded-[24px] bg-white p-6 shadow-[0_4px_20px_rgba(148,74,35,0.06)]">
            <div className="mb-4 flex items-center justify-between gap-3">
              <p className="text-sm text-[#6c7a71]">Forward a message to bot to create a task.</p>
              <button
                type="button"
                onClick={() => void loadTasks()}
                className="inline-flex items-center gap-2 rounded-full bg-[#f1f6f3] px-3 py-1.5 text-xs font-semibold text-[#006c49]"
              >
                <RefreshCw className="h-3.5 w-3.5" />
                Refresh
              </button>
            </div>
            <div className="mb-4 grid gap-2 sm:grid-cols-2">
              <label className="text-xs font-semibold uppercase tracking-wide text-[#6c7a71]">
                Task type
                <select
                  value={scopeFilter}
                  onChange={(event) => setScopeFilter(event.target.value as "all" | "personal" | "household")}
                  className="mt-1 w-full rounded-xl border border-[#e7ddd6] bg-white px-3 py-2 text-sm text-[#1f1b17]"
                >
                  <option value="all">All</option>
                  <option value="personal">Personal only</option>
                  <option value="household">Home only</option>
                </select>
              </label>
              <label className="text-xs font-semibold uppercase tracking-wide text-[#6c7a71]">
                Sort
                <select
                  value={sortBy}
                  onChange={(event) =>
                    setSortBy(
                      event.target.value as
                        | "created_desc"
                        | "created_asc"
                        | "due_asc"
                        | "due_desc"
                        | "scope_personal_first"
                        | "scope_household_first",
                    )
                  }
                  className="mt-1 w-full rounded-xl border border-[#e7ddd6] bg-white px-3 py-2 text-sm text-[#1f1b17]"
                >
                  <option value="created_desc">Newest first</option>
                  <option value="created_asc">Oldest first</option>
                  <option value="due_asc">Deadline: nearest first</option>
                  <option value="due_desc">Deadline: latest first</option>
                  <option value="scope_personal_first">Type: personal first</option>
                  <option value="scope_household_first">Type: home first</option>
                </select>
              </label>
            </div>
            <div className="mb-4 grid gap-2 sm:grid-cols-2">
              <label className="text-xs font-semibold uppercase tracking-wide text-[#6c7a71]">
                Deadline from
                <input
                  type="date"
                  value={deadlineFrom}
                  onChange={(event) => setDeadlineFrom(event.target.value)}
                  className="mt-1 w-full rounded-xl border border-[#e7ddd6] bg-white px-3 py-2 text-sm text-[#1f1b17]"
                />
              </label>
              <label className="text-xs font-semibold uppercase tracking-wide text-[#6c7a71]">
                Deadline to
                <input
                  type="date"
                  value={deadlineTo}
                  onChange={(event) => setDeadlineTo(event.target.value)}
                  className="mt-1 w-full rounded-xl border border-[#e7ddd6] bg-white px-3 py-2 text-sm text-[#1f1b17]"
                />
              </label>
            </div>
            <div className="mb-4 flex justify-end">
              <button
                type="button"
                onClick={() => {
                  setScopeFilter("all");
                  setSortBy("created_desc");
                  setDeadlineFrom("");
                  setDeadlineTo("");
                }}
                className="inline-flex items-center rounded-full border border-[#d9cec6] bg-white px-3 py-1.5 text-xs font-semibold text-[#6c7a71] hover:bg-[#faf6f3]"
              >
                Reset filters
              </button>
            </div>
            {message ? (
              <p className="mb-3 rounded-xl bg-[#ffece6] px-3 py-2 text-sm text-[#8a3b1c]">{message}</p>
            ) : null}
            {loading ? (
              <p className="text-sm text-[#6c7a71]">Loading tasks...</p>
            ) : visibleTasks.length === 0 ? (
              <p className="text-sm text-[#6c7a71]">No tasks yet.</p>
            ) : (
              <ul className="space-y-2">
                {visibleTasks.map((task) => {
                  const isDone = task.status === "done";
                  const dueText = task.due_at ? new Date(task.due_at).toLocaleString() : null;
                  const householdName = householdNameById[task.household_id] ?? "Unknown home";
                  return (
                    <li
                      key={task.id}
                      className="flex items-start justify-between gap-3 rounded-2xl border border-[#ece6e1] px-3 py-3"
                    >
                      <div className="min-w-0">
                        <p className={`text-sm font-semibold ${isDone ? "text-[#8e8a86] line-through" : "text-[#1f1b17]"}`}>
                          {task.title}
                        </p>
                        <p className="mt-1">
                          <span
                            className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
                              task.task_scope === "household"
                                ? "bg-[#e7f4ee] text-[#006c49]"
                                : "bg-[#f3eefb] text-[#6a3ea1]"
                            }`}
                          >
                            {task.task_scope === "household" ? `Дом: ${householdName}` : `Личная · ${householdName}`}
                          </span>
                        </p>
                        {task.description ? (
                          <p className="mt-1 text-xs text-[#6c7a71]">{task.description}</p>
                        ) : null}
                        <p className="mt-1 text-[11px] uppercase tracking-wide text-[#8e8a86]">
                          {task.priority}
                          {task.parse_source === "ai" ? " · AI parsed" : ""}
                          {task.needs_review ? " · needs review" : ""}
                          {dueText ? ` · due ${dueText}` : ""}
                        </p>
                      </div>
                      <button
                        type="button"
                        disabled={busyTaskId === task.id}
                        onClick={() => void toggleStatus(task)}
                        className="rounded-full p-1 text-[#006c49] disabled:cursor-not-allowed disabled:opacity-60"
                        aria-label={isDone ? "Mark as open" : "Mark as done"}
                      >
                        {isDone ? <CheckCircle2 className="h-5 w-5" /> : <Circle className="h-5 w-5" />}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </div>
      </main>
    </MobileShell>
  );
}
