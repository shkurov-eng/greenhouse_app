"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Settings } from "lucide-react";

import { MobileShell } from "@/components/MobileShell";
import {
  getHouseholdJoinSettings,
  getTaskSettings,
  listHouseholdMembers,
  listHouseholdJoinRequests,
  removeHouseholdMember,
  reviewHouseholdJoinRequest,
  setHouseholdJoinSetting,
  setTaskSettings,
  type HouseholdMember,
  type HouseholdJoinRequest,
  type HouseholdJoinSetting,
} from "@/lib/api";

function resolveTelegramInitData() {
  if (typeof window === "undefined") {
    return null;
  }
  const telegram = (window as Window & { Telegram?: { WebApp?: { initData?: string } } }).Telegram;
  return telegram?.WebApp?.initData?.trim() || null;
}

export default function SettingsPage() {
  const initData = useMemo(() => resolveTelegramInitData(), []);
  const [mode, setMode] = useState<"single" | "combine">("single");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [joinSettings, setJoinSettings] = useState<HouseholdJoinSetting[]>([]);
  const [selectedHouseholdId, setSelectedHouseholdId] = useState("");
  const [joinRequests, setJoinRequests] = useState<HouseholdJoinRequest[]>([]);
  const [membersByHousehold, setMembersByHousehold] = useState<Record<string, HouseholdMember[]>>({});
  const [joinSettingsSavingHouseholdId, setJoinSettingsSavingHouseholdId] = useState<string | null>(null);
  const [requestsLoading, setRequestsLoading] = useState(false);
  const [membersLoading, setMembersLoading] = useState(false);
  const [reviewingRequestId, setReviewingRequestId] = useState<string | null>(null);
  const [removingMemberProfileId, setRemovingMemberProfileId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const ownerHomes = useMemo(() => joinSettings.filter((row) => row.is_owner), [joinSettings]);

  useEffect(() => {
    const run = async () => {
      try {
        const [taskSettings, settingsRows] = await Promise.all([
          getTaskSettings(initData),
          getHouseholdJoinSettings(initData),
        ]);
        setMode(taskSettings.taskMessageMode);
        setJoinSettings(settingsRows);
        const ownerHome = settingsRows.find((row) => row.is_owner);
        setSelectedHouseholdId(ownerHome?.household_id ?? "");
      } catch (error) {
        const text = error instanceof Error ? error.message : "Failed to load settings";
        setMessage(text);
      } finally {
        setLoading(false);
      }
    };
    void run();
  }, [initData]);

  useEffect(() => {
    const ownerSetting = ownerHomes.find((row) => row.household_id === selectedHouseholdId);
    if (!ownerSetting) {
      return;
    }

    const run = async () => {
      setRequestsLoading(true);
      setMembersLoading(true);
      try {
        const [requestRows, ...memberRowsPerHousehold] = await Promise.all([
          listHouseholdJoinRequests(initData, ownerSetting.household_id),
          ...ownerHomes.map((home) => listHouseholdMembers(initData, home.household_id)),
        ]);
        setJoinRequests(requestRows);
        const nextMembersByHousehold: Record<string, HouseholdMember[]> = {};
        ownerHomes.forEach((home, index) => {
          nextMembersByHousehold[home.household_id] = memberRowsPerHousehold[index] ?? [];
        });
        setMembersByHousehold(nextMembersByHousehold);
      } catch (error) {
        const text = error instanceof Error ? error.message : "Failed to load join requests";
        setMessage(text);
      } finally {
        setRequestsLoading(false);
        setMembersLoading(false);
      }
    };
    void run();
  }, [initData, ownerHomes, selectedHouseholdId]);

  const onChangeMode = async (nextMode: "single" | "combine") => {
    setMode(nextMode);
    setSaving(true);
    setMessage(null);
    try {
      const saved = await setTaskSettings(initData, { taskMessageMode: nextMode });
      setMode(saved.taskMessageMode);
    } catch (error) {
      const text = error instanceof Error ? error.message : "Failed to save settings";
      setMessage(text);
    } finally {
      setSaving(false);
    }
  };

  const onToggleJoinApproval = async (setting: HouseholdJoinSetting) => {
    setJoinSettingsSavingHouseholdId(setting.household_id);
    setMessage(null);
    try {
      const updated = await setHouseholdJoinSetting(initData, {
        householdId: setting.household_id,
        requireJoinApproval: !setting.require_join_approval,
      });
      setJoinSettings((prev) =>
        prev.map((row) => (row.household_id === updated.household_id ? updated : row)),
      );
      setMessage(
        updated.require_join_approval
          ? `Join approval enabled for "${updated.household_name}"`
          : `Join approval disabled for "${updated.household_name}"`,
      );
    } catch (error) {
      const text = error instanceof Error ? error.message : "Failed to save join settings";
      setMessage(text);
    } finally {
      setJoinSettingsSavingHouseholdId(null);
    }
  };

  const onReviewRequest = async (requestId: string, decision: "approve" | "reject") => {
    setReviewingRequestId(requestId);
    setMessage(null);
    try {
      const reviewed = await reviewHouseholdJoinRequest(initData, { requestId, decision });
      setJoinRequests((prev) => prev.filter((row) => row.request_id !== requestId));
      if (ownerHomes.length > 0) {
        const allRows = await Promise.all(
          ownerHomes.map((home) => listHouseholdMembers(initData, home.household_id)),
        );
        const nextMembersByHousehold: Record<string, HouseholdMember[]> = {};
        ownerHomes.forEach((home, index) => {
          nextMembersByHousehold[home.household_id] = allRows[index] ?? [];
        });
        setMembersByHousehold(nextMembersByHousehold);
      }
      setMessage(
        decision === "approve"
          ? `Approved join request for ${reviewed.household_name}`
          : `Rejected join request for ${reviewed.household_name}`,
      );
    } catch (error) {
      const text = error instanceof Error ? error.message : "Failed to review join request";
      setMessage(text);
    } finally {
      setReviewingRequestId(null);
    }
  };

  const onRemoveMember = async (member: HouseholdMember) => {
    setRemovingMemberProfileId(member.profile_id);
    setMessage(null);
    try {
      const removed = await removeHouseholdMember(initData, {
        householdId: member.household_id,
        memberProfileId: member.profile_id,
      });
      setMembersByHousehold((prev) => {
        const current = prev[member.household_id] ?? [];
        return {
          ...prev,
          [member.household_id]: current.filter((row) => row.profile_id !== member.profile_id),
        };
      });
      setMessage(
        `Removed ${
          member.username ? `@${member.username}` : `Telegram ID ${member.telegram_id}`
        } from ${removed.household_name}`,
      );
    } catch (error) {
      const text = error instanceof Error ? error.message : "Failed to remove member";
      setMessage(text);
    } finally {
      setRemovingMemberProfileId(null);
    }
  };

  return (
    <MobileShell>
      <main className="min-h-screen bg-[#fff8f5] pb-32 text-[#1f1b17]">
        <div className="mx-auto w-full max-w-5xl px-5 pt-6">
          <header className="mb-8 flex items-center gap-3">
            <Link href="/" className="rounded-full bg-white p-2 text-[#6c7a71] shadow-sm" aria-label="Back to rooms">
              <ArrowLeft className="h-5 w-5" />
            </Link>
            <div className="flex items-center gap-2">
              <Settings className="h-5 w-5 text-[#006c49]" />
              <h1 className="text-lg font-extrabold tracking-tight text-[#006c49]">Settings</h1>
            </div>
          </header>
          <section className="rounded-[24px] bg-white p-6 shadow-[0_4px_20px_rgba(148,74,35,0.06)]">
            <h2 className="text-sm font-bold text-[#1f1b17]">Bot task mode</h2>
            <p className="mt-1 text-xs text-[#6c7a71]">
              Choose how forwarded bot messages are turned into tasks.
            </p>
            <div className="mt-4 space-y-2">
              <label className="flex cursor-pointer items-start gap-2 rounded-xl border border-[#e7ddd6] p-3">
                <input
                  type="radio"
                  name="task-mode"
                  checked={mode === "single"}
                  disabled={loading || saving}
                  onChange={() => void onChangeMode("single")}
                />
                <span>
                  <span className="block text-sm font-semibold text-[#1f1b17]">Single message = single task</span>
                  <span className="block text-xs text-[#6c7a71]">
                    Every forwarded message is processed as a separate task.
                  </span>
                </span>
              </label>
              <label className="flex cursor-pointer items-start gap-2 rounded-xl border border-[#e7ddd6] p-3">
                <input
                  type="radio"
                  name="task-mode"
                  checked={mode === "combine"}
                  disabled={loading || saving}
                  onChange={() => void onChangeMode("combine")}
                />
                <span>
                  <span className="block text-sm font-semibold text-[#1f1b17]">Combine messages into one task</span>
                  <span className="block text-xs text-[#6c7a71]">
                    New forwarded messages are appended to one draft until task type/home is selected.
                  </span>
                </span>
              </label>
            </div>
            {saving ? <p className="mt-3 text-xs text-[#6c7a71]">Saving...</p> : null}
          </section>
          <section className="mt-4 rounded-[24px] bg-white p-6 shadow-[0_4px_20px_rgba(148,74,35,0.06)]">
            <h2 className="text-sm font-bold text-[#1f1b17]">Household join approvals</h2>
            <p className="mt-1 text-xs text-[#6c7a71]">
              For homes where you are the owner, you can require manual approval before new members join.
            </p>

            {ownerHomes.length === 0 ? (
              <p className="mt-4 text-xs text-[#6c7a71]">You are not owner of any home.</p>
            ) : (
              <div className="mt-4 space-y-3">
                {ownerHomes.map((setting) => (
                  <div
                    key={setting.household_id}
                    className="rounded-xl border border-[#e7ddd6] px-3 py-3"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <p className="text-sm font-semibold text-[#1f1b17]">{setting.household_name}</p>
                        <p className="text-xs text-[#6c7a71]">
                          {setting.require_join_approval ? "Approval required" : "Anyone with invite code can join"}
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          void onToggleJoinApproval(setting);
                        }}
                        disabled={joinSettingsSavingHouseholdId === setting.household_id}
                        className="rounded-lg border border-[#bbcabf] px-3 py-1.5 text-xs font-semibold text-[#1f1b17] disabled:opacity-60"
                      >
                        {setting.require_join_approval ? "Disable" : "Enable"}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
          <section className="mt-4 rounded-[24px] bg-white p-6 shadow-[0_4px_20px_rgba(148,74,35,0.06)]">
            <h2 className="text-sm font-bold text-[#1f1b17]">Pending join requests</h2>
            <p className="mt-1 text-xs text-[#6c7a71]">
              Review users who requested to join your home by invite code.
            </p>

            {ownerHomes.length > 0 ? (
              <div className="mt-4">
                <label className="mb-1 block text-xs font-semibold text-[#3c4a42]">Home</label>
                <select
                  value={selectedHouseholdId}
                  onChange={(event) => {
                    setSelectedHouseholdId(event.target.value);
                    setJoinRequests([]);
                  }}
                  className="w-full rounded-xl border border-[#bbcabf] bg-white px-3 py-2 text-sm outline-none focus:border-[#006c49]"
                >
                  {ownerHomes.map((home) => (
                    <option key={home.household_id} value={home.household_id}>
                      {home.household_name}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}

            {requestsLoading ? <p className="mt-4 text-xs text-[#6c7a71]">Loading requests...</p> : null}

            {!requestsLoading && ownerHomes.length > 0 && joinRequests.length === 0 ? (
              <p className="mt-4 text-xs text-[#6c7a71]">No pending requests for selected home.</p>
            ) : null}

            {!requestsLoading && joinRequests.length > 0 ? (
              <div className="mt-4 space-y-3">
                {joinRequests.map((request) => (
                  <div key={request.request_id} className="rounded-xl border border-[#e7ddd6] p-3">
                    <p className="text-sm font-semibold text-[#1f1b17]">{request.household_name}</p>
                    <p className="mt-1 text-xs text-[#3c4a42]">Telegram ID: {request.requester_telegram_id}</p>
                    <p className="text-xs text-[#3c4a42]">
                      Username: {request.requester_username ? `@${request.requester_username}` : "Unknown"}
                    </p>
                    <p className="text-xs text-[#3c4a42]">Invite code: {request.invite_code}</p>
                    <div className="mt-3 flex gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          void onReviewRequest(request.request_id, "approve");
                        }}
                        disabled={reviewingRequestId === request.request_id}
                        className="rounded-lg border-b-2 border-[#005236] bg-[#006c49] px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-60"
                      >
                        Approve
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          void onReviewRequest(request.request_id, "reject");
                        }}
                        disabled={reviewingRequestId === request.request_id}
                        className="rounded-lg border border-[#bbcabf] px-3 py-1.5 text-xs font-semibold text-[#1f1b17] disabled:opacity-60"
                      >
                        Reject
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            ) : null}
          </section>
          <section className="mt-4 rounded-[24px] bg-white p-6 shadow-[0_4px_20px_rgba(148,74,35,0.06)]">
            <h2 className="text-sm font-bold text-[#1f1b17]">Household members</h2>
            <p className="mt-1 text-xs text-[#6c7a71]">
              Members are grouped by each home where you are owner.
            </p>

            {membersLoading ? <p className="mt-4 text-xs text-[#6c7a71]">Loading members...</p> : null}

            {!membersLoading && ownerHomes.length > 0 ? (
              <div className="mt-4 space-y-4">
                {ownerHomes.map((home) => {
                  const members = membersByHousehold[home.household_id] ?? [];
                  return (
                    <div key={home.household_id} className="rounded-xl border border-[#e7ddd6] p-3">
                      <p className="text-sm font-bold text-[#1f1b17]">{home.household_name}</p>
                      {members.length === 0 ? (
                        <p className="mt-2 text-xs text-[#6c7a71]">No members found.</p>
                      ) : (
                        <div className="mt-3 space-y-3">
                          {members.map((member) => (
                            <div key={`${home.household_id}:${member.profile_id}`} className="rounded-lg border border-[#f0e6df] p-3">
                              <p className="text-sm font-semibold text-[#1f1b17]">
                                {member.username ? `@${member.username}` : "Unknown username"}
                              </p>
                              <p className="mt-1 text-xs text-[#3c4a42]">Telegram ID: {member.telegram_id}</p>
                              {member.is_owner ? (
                                <p className="mt-2 inline-flex rounded bg-[#e6f5ef] px-2 py-0.5 text-[11px] font-semibold text-[#006c49]">
                                  Owner
                                </p>
                              ) : (
                                <div className="mt-3">
                                  <button
                                    type="button"
                                    onClick={() => {
                                      void onRemoveMember(member);
                                    }}
                                    disabled={removingMemberProfileId === member.profile_id}
                                    className="rounded-lg border border-[#bbcabf] px-3 py-1.5 text-xs font-semibold text-[#8a3b1c] disabled:opacity-60"
                                  >
                                    Remove member
                                  </button>
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            ) : null}
            {!membersLoading && ownerHomes.length > 0 && ownerHomes.every((home) => (membersByHousehold[home.household_id] ?? []).length === 0) ? (
              <p className="mt-3 text-xs text-[#6c7a71]">No members in your homes.</p>
            ) : null}
          </section>
          {message ? <p className="mt-3 text-xs text-[#8a3b1c]">{message}</p> : null}
        </div>
      </main>
    </MobileShell>
  );
}
