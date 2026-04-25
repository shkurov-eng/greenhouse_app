"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowLeft, CheckCircle2, ChevronDown, Circle, Inbox, Pencil, RefreshCw, X } from "lucide-react";

import { MobileShell } from "@/components/MobileShell";
import { createTask, listHouseholds, listTasks, updateTask, updateTaskStatus, type Task } from "@/lib/api";

function resolveTelegramInitData() {
  if (typeof window === "undefined") {
    return null;
  }
  const telegram = (window as Window & { Telegram?: { WebApp?: { initData?: string } } }).Telegram;
  return telegram?.WebApp?.initData?.trim() || null;
}

function hasUrl(text: string | null) {
  if (!text) {
    return false;
  }
  return /(https?:\/\/|www\.)\S+/i.test(text);
}

function toDatetimeLocalValue(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${year}-${month}-${day}T${hours}:${minutes}`;
}

const TASK_TYPE_FILTER_STORAGE_KEY = "tasks.taskTypeFilter";

export default function TasksPage() {
  type TaskTypeFilter = "all" | "personal" | `household:${string}`;

  const [tasks, setTasks] = useState<Task[]>([]);
  const [householdNameById, setHouseholdNameById] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<string | null>(null);
  const [busyTaskId, setBusyTaskId] = useState<string | null>(null);
  const [taskTypeFilter, setTaskTypeFilter] = useState<TaskTypeFilter>("all");
  const [sortBy, setSortBy] = useState<
    "created_desc" | "created_asc" | "due_asc" | "due_desc" | "scope_personal_first" | "scope_household_first"
  >("created_desc");
  const [deadlineFrom, setDeadlineFrom] = useState("");
  const [deadlineTo, setDeadlineTo] = useState("");
  const [households, setHouseholds] = useState<Array<{ household_id: string; household_name: string }>>([]);
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [editingTask, setEditingTask] = useState<Task | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editDueAt, setEditDueAt] = useState("");
  const [editTaskScope, setEditTaskScope] = useState<"personal" | "household">("personal");
  const [editHouseholdId, setEditHouseholdId] = useState("");
  const [savingEdit, setSavingEdit] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newDueAt, setNewDueAt] = useState("");
  const [newTaskScope, setNewTaskScope] = useState<"personal" | "household">("personal");
  const [newHouseholdId, setNewHouseholdId] = useState("");
  const [creatingTask, setCreatingTask] = useState(false);
  const [isNewTaskCollapsed, setIsNewTaskCollapsed] = useState(true);
  const [isFiltersCollapsed, setIsFiltersCollapsed] = useState(true);

  const initData = useMemo(() => resolveTelegramInitData(), []);

  const loadTasks = useCallback(async () => {
    setLoading(true);
    setMessage(null);
    try {
      const [data, households] = await Promise.all([listTasks(initData), listHouseholds(initData)]);
      setTasks(data);
      setHouseholds(households);
      const nextMap: Record<string, string> = {};
      for (const household of households) {
        nextMap[household.household_id] = household.household_name;
      }
      setHouseholdNameById(nextMap);
      if (!newHouseholdId && households.length > 0) {
        setNewHouseholdId(households[0].household_id);
      }
    } catch (error) {
      const text = error instanceof Error ? error.message : "Failed to load tasks";
      setMessage(text);
    } finally {
      setLoading(false);
    }
  }, [initData, newHouseholdId]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadTasks();
    }, 0);
    return () => {
      window.clearTimeout(timer);
    };
  }, [loadTasks]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const savedFilter = window.localStorage.getItem(TASK_TYPE_FILTER_STORAGE_KEY);
    if (!savedFilter) {
      return;
    }
    if (savedFilter === "all" || savedFilter === "personal" || savedFilter.startsWith("household:")) {
      setTaskTypeFilter(savedFilter as TaskTypeFilter);
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    if (taskTypeFilter.startsWith("household:")) {
      const householdId = taskTypeFilter.slice("household:".length);
      const hasAccess = households.some((home) => home.household_id === householdId);
      if (!hasAccess && households.length > 0) {
        setTaskTypeFilter("all");
        return;
      }
    }
    window.localStorage.setItem(TASK_TYPE_FILTER_STORAGE_KEY, taskTypeFilter);
  }, [households, taskTypeFilter]);

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

  const openEdit = useCallback((task: Task) => {
    setEditingTask(task);
    setEditTitle(task.title);
    setEditDueAt(task.due_at ? new Date(task.due_at).toISOString().slice(0, 16) : "");
    setEditTaskScope(task.task_scope);
    setEditHouseholdId(task.household_id ?? "");
  }, []);

  const saveEdit = useCallback(async () => {
    if (!editingTask) {
      return;
    }
    const title = editTitle.trim();
    if (!title) {
      setMessage("Task title is required");
      return;
    }
    if (editTaskScope === "household" && !editHouseholdId) {
      setMessage("Select home");
      return;
    }
    setSavingEdit(true);
    setMessage(null);
    try {
      const dueAt = editDueAt ? new Date(editDueAt).toISOString() : null;
      await updateTask(initData, {
        taskId: editingTask.id,
        title,
        dueAt,
        taskScope: editTaskScope,
        householdId: editTaskScope === "household" ? editHouseholdId : null,
      });
      setTasks((prev) =>
        prev.map((item) =>
          item.id === editingTask.id
            ? {
                ...item,
                title,
                due_at: dueAt,
                task_scope: editTaskScope,
                household_id: editTaskScope === "household" ? editHouseholdId : null,
                updated_at: new Date().toISOString(),
              }
            : item,
        ),
      );
      setEditingTask(null);
    } catch (error) {
      const text = error instanceof Error ? error.message : "Failed to save task";
      setMessage(text);
    } finally {
      setSavingEdit(false);
    }
  }, [editingTask, editTitle, editDueAt, editTaskScope, editHouseholdId, initData]);

  const createTaskFromForm = useCallback(async () => {
    const title = newTitle.trim();
    if (!title) {
      setMessage("Task title is required");
      return;
    }
    if (newTaskScope === "household" && !newHouseholdId) {
      setMessage("Select home");
      return;
    }

    setCreatingTask(true);
    setMessage(null);
    try {
      const dueAt = newDueAt ? new Date(newDueAt).toISOString() : null;
      await createTask(initData, {
        title,
        dueAt,
        taskScope: newTaskScope,
        householdId: newTaskScope === "household" ? newHouseholdId : null,
      });

      setNewTitle("");
      setNewDueAt("");
      setNewTaskScope("personal");
      await loadTasks();
      setMessage("Task created");
    } catch (error) {
      const text = error instanceof Error ? error.message : "Failed to create task";
      setMessage(text);
    } finally {
      setCreatingTask(false);
    }
  }, [initData, loadTasks, newDueAt, newHouseholdId, newTaskScope, newTitle]);

  const setDuePreset = useCallback((preset: "plus_1h" | "today_20" | "tomorrow_09") => {
    const now = new Date();
    if (preset === "plus_1h") {
      const next = new Date(now.getTime() + 60 * 60 * 1000);
      setNewDueAt(toDatetimeLocalValue(next));
      return;
    }
    if (preset === "today_20") {
      const next = new Date(now);
      next.setHours(20, 0, 0, 0);
      if (next.getTime() <= now.getTime()) {
        next.setDate(next.getDate() + 1);
      }
      setNewDueAt(toDatetimeLocalValue(next));
      return;
    }
    const tomorrowMorning = new Date(now);
    tomorrowMorning.setDate(tomorrowMorning.getDate() + 1);
    tomorrowMorning.setHours(9, 0, 0, 0);
    setNewDueAt(toDatetimeLocalValue(tomorrowMorning));
  }, []);

  const visibleTasks = useMemo(() => {
    const startMs = deadlineFrom ? new Date(`${deadlineFrom}T00:00:00`).getTime() : null;
    const endMs = deadlineTo ? new Date(`${deadlineTo}T23:59:59.999`).getTime() : null;

    const filtered = tasks.filter((task) => {
      if (taskTypeFilter === "personal") {
        if (task.task_scope !== "personal") {
          return false;
        }
      } else if (taskTypeFilter.startsWith("household:")) {
        const householdId = taskTypeFilter.slice("household:".length);
        if (task.task_scope !== "household" || task.household_id !== householdId) {
          return false;
        }
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
  }, [tasks, taskTypeFilter, sortBy, deadlineFrom, deadlineTo]);

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
              <p className="text-sm text-[#6c7a71]">Create a task here or forward a message to bot.</p>
              <button
                type="button"
                onClick={() => void loadTasks()}
                className="inline-flex items-center gap-2 rounded-full bg-[#f1f6f3] px-3 py-1.5 text-xs font-semibold text-[#006c49]"
              >
                <RefreshCw className="h-3.5 w-3.5" />
                Refresh
              </button>
            </div>
            <div className="mb-4 rounded-2xl border border-[#ece6e1] bg-[#fffaf6]">
              <button
                type="button"
                onClick={() => setIsNewTaskCollapsed((prev) => !prev)}
                className="flex w-full items-center justify-between px-4 py-3 text-left"
              >
                <span className="text-sm font-bold text-[#1f1b17]">New task</span>
                <ChevronDown
                  className={`h-4 w-4 text-[#6c7a71] transition-transform ${isNewTaskCollapsed ? "" : "rotate-180"}`}
                />
              </button>
              {!isNewTaskCollapsed ? (
                <div className="border-t border-[#efe7e0] px-4 pb-4 pt-3">
                  <div className="grid gap-2 sm:grid-cols-2">
                <label className="text-xs font-semibold uppercase tracking-wide text-[#6c7a71] sm:col-span-2">
                  Task
                  <input
                    value={newTitle}
                    onChange={(event) => setNewTitle(event.target.value)}
                    placeholder="e.g. Buy fertilizer"
                    className="mt-1 w-full rounded-xl border border-[#e7ddd6] bg-white px-3 py-2 text-sm text-[#1f1b17]"
                  />
                </label>
                <label className="text-xs font-semibold uppercase tracking-wide text-[#6c7a71]">
                  Date & time
                  <input
                    type="datetime-local"
                    value={newDueAt}
                    onChange={(event) => setNewDueAt(event.target.value)}
                    className="mt-1 w-full rounded-xl border border-[#e7ddd6] bg-white px-3 py-2 text-sm text-[#1f1b17]"
                  />
                  <div className="mt-2 flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => setDuePreset("plus_1h")}
                      className="rounded-full border border-[#d9cec6] bg-white px-2.5 py-1 text-[11px] font-semibold text-[#6c7a71] hover:bg-[#faf6f3]"
                    >
                      +1h
                    </button>
                    <button
                      type="button"
                      onClick={() => setDuePreset("today_20")}
                      className="rounded-full border border-[#d9cec6] bg-white px-2.5 py-1 text-[11px] font-semibold text-[#6c7a71] hover:bg-[#faf6f3]"
                    >
                      Today 20:00
                    </button>
                    <button
                      type="button"
                      onClick={() => setDuePreset("tomorrow_09")}
                      className="rounded-full border border-[#d9cec6] bg-white px-2.5 py-1 text-[11px] font-semibold text-[#6c7a71] hover:bg-[#faf6f3]"
                    >
                      Tomorrow 09:00
                    </button>
                  </div>
                </label>
                <label className="text-xs font-semibold uppercase tracking-wide text-[#6c7a71]">
                  Type
                  <select
                    value={newTaskScope}
                    onChange={(event) => {
                      const nextScope = event.target.value as "personal" | "household";
                      setNewTaskScope(nextScope);
                      if (nextScope === "household" && !newHouseholdId && households.length > 0) {
                        setNewHouseholdId(households[0].household_id);
                      }
                    }}
                    className="mt-1 w-full rounded-xl border border-[#e7ddd6] bg-white px-3 py-2 text-sm text-[#1f1b17]"
                  >
                    <option value="personal">Личная</option>
                    <option value="household">Общая на дом</option>
                  </select>
                </label>
                {newTaskScope === "household" ? (
                  <label className="text-xs font-semibold uppercase tracking-wide text-[#6c7a71] sm:col-span-2">
                    Home
                    <select
                      value={newHouseholdId}
                      onChange={(event) => setNewHouseholdId(event.target.value)}
                      className="mt-1 w-full rounded-xl border border-[#e7ddd6] bg-white px-3 py-2 text-sm text-[#1f1b17]"
                    >
                      {households.map((home) => (
                        <option key={home.household_id} value={home.household_id}>
                          {home.household_name}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}
                  </div>
                  <div className="mt-3 flex justify-end">
                    <button
                      type="button"
                      disabled={creatingTask}
                      onClick={() => void createTaskFromForm()}
                      className="rounded-full bg-[#006c49] px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
                    >
                      {creatingTask ? "Creating..." : "Create task"}
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
            <div className="mb-4 rounded-2xl border border-[#ece6e1] bg-white">
              <button
                type="button"
                onClick={() => setIsFiltersCollapsed((prev) => !prev)}
                className="flex w-full items-center justify-between px-4 py-3 text-left"
              >
                <span className="text-sm font-bold text-[#1f1b17]">Filters</span>
                <ChevronDown
                  className={`h-4 w-4 text-[#6c7a71] transition-transform ${isFiltersCollapsed ? "" : "rotate-180"}`}
                />
              </button>
              {!isFiltersCollapsed ? (
                <div className="border-t border-[#efe7e0] px-4 pb-4 pt-3">
                  <div className="grid gap-2 sm:grid-cols-2">
                    <label className="text-xs font-semibold uppercase tracking-wide text-[#6c7a71]">
                      Task type
                      <select
                        value={taskTypeFilter}
                        onChange={(event) => setTaskTypeFilter(event.target.value as TaskTypeFilter)}
                        className="mt-1 w-full rounded-xl border border-[#e7ddd6] bg-white px-3 py-2 text-sm text-[#1f1b17]"
                      >
                        <option value="all">All tasks</option>
                        <option value="personal">Personal only</option>
                        {households.map((home) => (
                          <option key={home.household_id} value={`household:${home.household_id}`}>
                            Home: {home.household_name}
                          </option>
                        ))}
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
                  <div className="mt-2 grid gap-2 sm:grid-cols-2">
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
                  <div className="mt-3 flex justify-end">
                    <button
                      type="button"
                      onClick={() => {
                        setTaskTypeFilter("all");
                        setSortBy("created_desc");
                        setDeadlineFrom("");
                        setDeadlineTo("");
                      }}
                      className="inline-flex items-center rounded-full border border-[#d9cec6] bg-white px-3 py-1.5 text-xs font-semibold text-[#6c7a71] hover:bg-[#faf6f3]"
                    >
                      Reset filters
                    </button>
                  </div>
                </div>
              ) : null}
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
                  const householdName = task.household_id ? (householdNameById[task.household_id] ?? "Unknown home") : null;
                  const fromLink = hasUrl(task.description);
                  return (
                    <li
                      key={task.id}
                      className="flex items-start justify-between gap-3 rounded-2xl border border-[#ece6e1] px-3 py-3"
                    >
                      <div className="min-w-0 flex-1 text-left">
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
                            {task.task_scope === "household" ? `Дом: ${householdName ?? "Unknown home"}` : "Личная"}
                          </span>
                        </p>
                        {task.description ? (
                          <p className="mt-1 text-xs text-[#6c7a71]">{task.description}</p>
                        ) : null}
                        <p className="mt-1 text-[11px] uppercase tracking-wide text-[#8e8a86]">
                          {task.priority}
                          {fromLink ? " · из ссылки" : ""}
                          {task.parse_source === "ai" ? " · AI parsed" : ""}
                          {task.needs_review ? " · needs review" : ""}
                          {dueText ? ` · due ${dueText}` : ""}
                        </p>
                      </div>
                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => setSelectedTask(task)}
                          className="rounded-full border border-[#d9cec6] bg-white px-2.5 py-1 text-[11px] font-semibold text-[#6c7a71] hover:bg-[#f5f1ed]"
                        >
                          Details
                        </button>
                        <button
                          type="button"
                          onClick={() => openEdit(task)}
                          className="rounded-full p-1 text-[#6c7a71] hover:bg-[#f5f1ed]"
                          aria-label="Edit task"
                        >
                          <Pencil className="h-4 w-4" />
                        </button>
                        <button
                          type="button"
                          disabled={busyTaskId === task.id}
                          onClick={() => void toggleStatus(task)}
                          className="rounded-full p-1 text-[#006c49] disabled:cursor-not-allowed disabled:opacity-60"
                          aria-label={isDone ? "Mark as open" : "Mark as done"}
                        >
                          {isDone ? <CheckCircle2 className="h-5 w-5" /> : <Circle className="h-5 w-5" />}
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </div>

        {selectedTask ? (
          <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/30 p-4 sm:items-center">
            <div className="w-full max-w-lg rounded-2xl bg-white p-5 shadow-xl">
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-base font-bold text-[#1f1b17]">Task details</h2>
                <button
                  type="button"
                  onClick={() => setSelectedTask(null)}
                  className="rounded-full p-1 text-[#6c7a71] hover:bg-[#f3efeb]"
                  aria-label="Close details"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <p className="text-sm font-semibold text-[#1f1b17]">{selectedTask.title}</p>
              <p className="mt-2 text-xs text-[#6c7a71]">
                {selectedTask.task_scope === "household"
                  ? `Дом: ${selectedTask.household_id ? (householdNameById[selectedTask.household_id] ?? "Unknown home") : "Unknown home"}`
                  : "Личная"}
              </p>
              {hasUrl(selectedTask.description) ? (
                <p className="mt-1 text-xs font-semibold text-[#006c49]">Источник: ссылка</p>
              ) : null}
              {selectedTask.source_platform === "telegram" && selectedTask.description ? (
                <div className="mt-4 rounded-xl border border-[#ece6e1] bg-[#fffaf6] p-3">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-[#8e8a86]">
                    Оригинал пересланного сообщения
                  </p>
                  <p className="mt-1 whitespace-pre-wrap text-sm text-[#3a332e]">{selectedTask.description}</p>
                  <p className="mt-2 text-[11px] text-[#8e8a86]">
                    source_message_id: {selectedTask.source_message_id ?? "n/a"} · source_chat_id:{" "}
                    {selectedTask.source_chat_id ?? "n/a"}
                  </p>
                </div>
              ) : null}
            </div>
          </div>
        ) : null}

        {editingTask ? (
          <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/30 p-4 sm:items-center">
            <div className="w-full max-w-lg rounded-2xl bg-white p-5 shadow-xl">
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-base font-bold text-[#1f1b17]">Edit task</h2>
                <button
                  type="button"
                  onClick={() => setEditingTask(null)}
                  className="rounded-full p-1 text-[#6c7a71] hover:bg-[#f3efeb]"
                  aria-label="Close editor"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <label className="mb-3 block text-xs font-semibold uppercase tracking-wide text-[#6c7a71]">
                Task
                <input
                  value={editTitle}
                  onChange={(event) => setEditTitle(event.target.value)}
                  className="mt-1 w-full rounded-xl border border-[#e7ddd6] bg-white px-3 py-2 text-sm text-[#1f1b17]"
                />
              </label>
              <label className="mb-3 block text-xs font-semibold uppercase tracking-wide text-[#6c7a71]">
                Deadline time
                <input
                  type="datetime-local"
                  value={editDueAt}
                  onChange={(event) => setEditDueAt(event.target.value)}
                  className="mt-1 w-full rounded-xl border border-[#e7ddd6] bg-white px-3 py-2 text-sm text-[#1f1b17]"
                />
              </label>
              <label className="mb-3 block text-xs font-semibold uppercase tracking-wide text-[#6c7a71]">
                Type
                <select
                  value={editTaskScope}
                  onChange={(event) => {
                    const nextScope = event.target.value as "personal" | "household";
                    setEditTaskScope(nextScope);
                    if (nextScope === "household" && !editHouseholdId && households.length > 0) {
                      setEditHouseholdId(households[0].household_id);
                    }
                  }}
                  className="mt-1 w-full rounded-xl border border-[#e7ddd6] bg-white px-3 py-2 text-sm text-[#1f1b17]"
                >
                  <option value="personal">Личная</option>
                  <option value="household">Общая на дом</option>
                </select>
              </label>
              {editTaskScope === "household" ? (
                <label className="mb-4 block text-xs font-semibold uppercase tracking-wide text-[#6c7a71]">
                  Home
                  <select
                    value={editHouseholdId}
                    onChange={(event) => setEditHouseholdId(event.target.value)}
                    className="mt-1 w-full rounded-xl border border-[#e7ddd6] bg-white px-3 py-2 text-sm text-[#1f1b17]"
                  >
                    {households.map((home) => (
                      <option key={home.household_id} value={home.household_id}>
                        {home.household_name}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setEditingTask(null)}
                  className="rounded-full border border-[#d9cec6] bg-white px-4 py-2 text-sm font-semibold text-[#6c7a71]"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={savingEdit}
                  onClick={() => void saveEdit()}
                  className="rounded-full bg-[#006c49] px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
                >
                  {savingEdit ? "Saving..." : "Save"}
                </button>
              </div>
            </div>
          </div>
        ) : null}
      </main>
    </MobileShell>
  );
}
