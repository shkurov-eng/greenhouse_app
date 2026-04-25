"use client";

import Link from "next/link";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  CheckCircle2,
  Copy,
  DoorOpen,
  HousePlus,
  KeyRound,
  Pencil,
  Plus,
  Settings,
  Sprout,
  Trash2,
} from "lucide-react";

import { MobileShell } from "@/components/MobileShell";
import {
  bootstrapUser,
  createHousehold,
  createPlant,
  deletePlant,
  createRoom,
  deleteHousehold,
  deleteRoom,
  joinHousehold,
  listHouseholds,
  listRoomDetails,
  listRooms,
  renameHousehold,
  renameRoom,
  revertLastWatering,
  setActiveHousehold,
  updatePlant,
  uploadRoomImage,
  upsertMarker,
  waterPlant,
  type Household,
  type HouseholdSummary,
  type Plant,
  type PlantMarker,
  type PlantStatus,
  type Room,
} from "@/lib/api";

/** UI watering urgency from clock: green under 5 min, yellow 5 min–1 h, red after 1 h (or never watered). */
const THIRSTY_AFTER_MS = 5 * 60 * 1000;
const OVERDUE_AFTER_MS = 60 * 60 * 1000;
const MARKER_WATER_DELAY_MS = 3_000;

function wateringDerivedStatus(lastWateredAt: string | null): PlantStatus {
  if (!lastWateredAt) {
    return "overdue";
  }
  const t = new Date(lastWateredAt).getTime();
  if (Number.isNaN(t)) {
    return "overdue";
  }
  const elapsed = Date.now() - t;
  if (elapsed < THIRSTY_AFTER_MS) {
    return "healthy";
  }
  if (elapsed < OVERDUE_AFTER_MS) {
    return "thirsty";
  }
  return "overdue";
}

type TelegramWebAppUser = {
  id: number;
  username?: string;
};

type TelegramWebApp = {
  ready?: () => void;
  initData?: string;
  initDataUnsafe?: {
    user?: TelegramWebAppUser;
  };
};

type PendingDeleteTarget =
  | { kind: "room"; id: string; label: string }
  | { kind: "household"; id: string; label: string }
  | { kind: "plant"; id: string; label: string };

type ImageContentBox = {
  left: number;
  top: number;
  width: number;
  height: number;
};

declare global {
  interface Window {
    Telegram?: {
      WebApp?: TelegramWebApp;
    };
  }
}

export default function Home() {
  /** Sync source for API headers; React state updates too late for same-tick awaits after bootstrap. */
  const telegramInitDataRef = useRef<string | null>(null);

  const [message, setMessage] = useState("No Telegram user detected");
  const [isDebugMock, setIsDebugMock] = useState(false);
  const [telegramInitData, setTelegramInitData] = useState<string | null>(null);
  const [isTelegramWebAppDetected, setIsTelegramWebAppDetected] = useState(false);
  const [isTelegramUserAgentDetected, setIsTelegramUserAgentDetected] = useState(false);
  const [householdId, setHouseholdId] = useState<string | null>(null);
  const [currentHousehold, setCurrentHousehold] = useState<Household | null>(null);
  const [isJoinHomeOpen, setIsJoinHomeOpen] = useState(false);
  const [isCreateHomeOpen, setIsCreateHomeOpen] = useState(false);
  const [newHomeName, setNewHomeName] = useState("");
  const [householdSummaries, setHouseholdSummaries] = useState<HouseholdSummary[]>([]);
  const [joinCode, setJoinCode] = useState("");
  const [isRenameHomeOpen, setIsRenameHomeOpen] = useState(false);
  const [renameHomeId, setRenameHomeId] = useState<string | null>(null);
  const [renameHomeInput, setRenameHomeInput] = useState("");
  const [isRenameRoomOpen, setIsRenameRoomOpen] = useState(false);
  const [renameRoomId, setRenameRoomId] = useState<string | null>(null);
  const [renameRoomInput, setRenameRoomInput] = useState("");
  const [roomName, setRoomName] = useState("");
  const [isCreateRoomOpen, setIsCreateRoomOpen] = useState(false);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [selectedRoom, setSelectedRoom] = useState<Room | null>(null);
  const [plants, setPlants] = useState<Plant[]>([]);
  const [markers, setMarkers] = useState<PlantMarker[]>([]);
  const [activeMarkerId, setActiveMarkerId] = useState<string | null>(null);
  const [pendingWateringMarkerIds, setPendingWateringMarkerIds] = useState<string[]>([]);
  const [justWateredMarkerId, setJustWateredMarkerId] = useState<string | null>(null);
  const [selectedPlantIdForMarker, setSelectedPlantIdForMarker] = useState<string>("");
  const [isMarkerEditMode, setIsMarkerEditMode] = useState(false);
  const [isAddPlantOpen, setIsAddPlantOpen] = useState(false);
  const [isEditPlantOpen, setIsEditPlantOpen] = useState(false);
  const [editingPlantId, setEditingPlantId] = useState<string | null>(null);
  const [plantName, setPlantName] = useState("");
  const [plantSpecies, setPlantSpecies] = useState("");
  const [plantStatus, setPlantStatus] = useState<PlantStatus>("healthy");
  const [editPlantName, setEditPlantName] = useState("");
  const [editPlantSpecies, setEditPlantSpecies] = useState("");
  const [editPlantStatus, setEditPlantStatus] = useState<PlantStatus>("healthy");
  const [roomFiles, setRoomFiles] = useState<Record<string, File | null>>({});
  const [roomUploadStatus, setRoomUploadStatus] = useState<Record<string, string>>({});
  const [pendingDeleteTarget, setPendingDeleteTarget] = useState<PendingDeleteTarget | null>(null);
  /** Bumps on an interval so marker colors refresh from `last_watered_at` without refetch. */
  const [, setWateringUiTick] = useState(0);
  const [, setPendingWateringTick] = useState(0);
  const [showMarkerLongPressHint, setShowMarkerLongPressHint] = useState(() => {
    if (typeof window === "undefined") {
      return false;
    }
    return window.localStorage.getItem("markerLongPressHintDismissed") !== "1";
  });
  const markerLongPressTimerRef = useRef<number | null>(null);
  const pendingWateringTimersRef = useRef<Record<string, number>>({});
  const [pendingWateringStartedAtByMarkerId, setPendingWateringStartedAtByMarkerId] = useState<
    Record<string, number>
  >({});
  const [pendingWateringNowMs, setPendingWateringNowMs] = useState(0);
  const markerLongPressHandledRef = useRef<string | null>(null);
  const roomImageContainerRef = useRef<HTMLDivElement | null>(null);
  const roomImageRef = useRef<HTMLImageElement | null>(null);
  const [roomImageContentBox, setRoomImageContentBox] = useState<ImageContentBox | null>(null);

  /** Opening a room reuses the same document scroll as the overview; reset so the photo + markers are in view. */
  useLayoutEffect(() => {
    if (!selectedRoom) {
      return;
    }
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
  }, [selectedRoom]);

  useEffect(() => {
    if (!selectedRoom) {
      return;
    }
    const id = window.setInterval(() => {
      setWateringUiTick((n) => n + 1);
    }, 30_000);
    return () => window.clearInterval(id);
  }, [selectedRoom]);

  useEffect(() => {
    if (pendingWateringMarkerIds.length === 0) {
      return;
    }
    const intervalId = window.setInterval(() => {
      setPendingWateringTick((n) => n + 1);
      setPendingWateringNowMs((now) => now + 200);
    }, 200);
    return () => window.clearInterval(intervalId);
  }, [pendingWateringMarkerIds.length]);

  function getMarkerColorClasses(status: PlantStatus) {
    if (status === "healthy") {
      return {
        pin: "bg-[#10b981]",
        pulse: "bg-[#10b981]/40",
        labelText: "text-[#006c49]",
        labelChip: "bg-[#e6f5ef]",
      };
    }
    if (status === "thirsty") {
      return {
        pin: "bg-[#e29100]",
        pulse: "bg-[#e29100]/40",
        labelText: "text-[#855300]",
        labelChip: "bg-[#ffddb8]",
      };
    }
    return {
      pin: "bg-[#ba1a1a]",
      pulse: "bg-[#ba1a1a]/40",
      labelText: "text-[#93000a]",
      labelChip: "bg-[#ffdad6]",
    };
  }

  function formatLastWatered(lastWateredAt: string | null) {
    if (!lastWateredAt) {
      return "Never";
    }

    const date = new Date(lastWateredAt);
    if (Number.isNaN(date.getTime())) {
      return "Unknown";
    }

    return date.toLocaleDateString();
  }

  function getCurrentInitData() {
    return telegramInitDataRef.current ?? telegramInitData;
  }

  async function loadHouseholds() {
    let list = await listHouseholds(getCurrentInitData());
    if (list.length === 0) {
      await bootstrapUser(getCurrentInitData(), null);
      list = await listHouseholds(getCurrentInitData());
    }
    setHouseholdSummaries(list);
    const active = list.find((h) => h.is_active) ?? list[0];
    if (active) {
      setHouseholdId(active.household_id);
      setCurrentHousehold({
        id: active.household_id,
        name: active.household_name,
        invite_code: active.invite_code,
      });
    } else {
      setHouseholdId(null);
      setCurrentHousehold(null);
    }
  }

  function clearRoomDetailState() {
    setPlants([]);
    setMarkers([]);
    setActiveMarkerId(null);
    setSelectedPlantIdForMarker("");
    setIsMarkerEditMode(false);
    setIsAddPlantOpen(false);
    setIsEditPlantOpen(false);
    setEditingPlantId(null);
  }

  function getRoomImageUrl(room: Room) {
    return room.signed_background_url ?? room.background_url;
  }

  function computeObjectContainBox(
    containerWidth: number,
    containerHeight: number,
    imageNaturalWidth: number,
    imageNaturalHeight: number,
  ): ImageContentBox {
    if (
      containerWidth <= 0 ||
      containerHeight <= 0 ||
      imageNaturalWidth <= 0 ||
      imageNaturalHeight <= 0
    ) {
      return { left: 0, top: 0, width: containerWidth, height: containerHeight };
    }

    const containerRatio = containerWidth / containerHeight;
    const imageRatio = imageNaturalWidth / imageNaturalHeight;

    if (containerRatio > imageRatio) {
      const height = containerHeight;
      const width = height * imageRatio;
      const left = (containerWidth - width) / 2;
      return { left, top: 0, width, height };
    }

    const width = containerWidth;
    const height = width / imageRatio;
    const top = (containerHeight - height) / 2;
    return { left: 0, top, width, height };
  }

  const measureRoomImageContentBox = useCallback(() => {
    const container = roomImageContainerRef.current;
    const image = roomImageRef.current;
    if (!container || !image) {
      setRoomImageContentBox(null);
      return;
    }
    const box = computeObjectContainBox(
      container.clientWidth,
      container.clientHeight,
      image.naturalWidth,
      image.naturalHeight,
    );
    setRoomImageContentBox(box);
  }, []);

  async function fetchRoomsForHousehold() {
    const nextRooms = await listRooms(getCurrentInitData());
    let shouldClearSelectionState = false;
    setRooms(nextRooms);
    setSelectedRoom((prev) => {
      if (!prev) {
        return prev;
      }
      const nextSelectedRoom = nextRooms.find((room) => room.id === prev.id) ?? null;
      if (!nextSelectedRoom) {
        shouldClearSelectionState = true;
      }
      return nextSelectedRoom;
    });
    if (shouldClearSelectionState) {
      clearRoomDetailState();
    }
  }

  async function fetchRoomDetails(roomId: string) {
    const details = await listRoomDetails(getCurrentInitData(), roomId);

    const syncedPlants = details.plants;
    setPlants(syncedPlants);
    setSelectedPlantIdForMarker((prev) => {
      if (!syncedPlants.length) {
        return "";
      }
      if (prev && syncedPlants.some((plant) => plant.id === prev)) {
        return prev;
      }
      return syncedPlants[0].id;
    });
    const nextMarkers = details.markers;
    setMarkers(nextMarkers);
    setActiveMarkerId((prev) => {
      if (!prev) {
        return prev;
      }
      return nextMarkers.some((marker) => marker.id === prev) ? prev : null;
    });
  }

  useEffect(() => {
    let isMounted = true;

    const wait = (ms: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
      });

    async function waitForTelegramWebApp() {
      // Small startup delay before first read, then retry briefly.
      await wait(300);

      for (let attempt = 0; attempt < 10; attempt += 1) {
        const tg = window.Telegram?.WebApp;
        if (tg) {
          return tg;
        }

        await wait(300);
      }

      return undefined;
    }

    async function saveTelegramUser() {
      const tg = await waitForTelegramWebApp();
      tg?.ready?.();
      const rawInitData = tg?.initData;
      const telegramInitDataValue =
        typeof rawInitData === "string" && rawInitData.length > 0 ? rawInitData : null;
      const telegramUser = tg?.initDataUnsafe?.user;
      const shouldUseMockUser = !telegramInitDataValue;
      const isTelegramUa = /telegram/i.test(window.navigator.userAgent);

      telegramInitDataRef.current = telegramInitDataValue;

      if (isMounted) {
        setIsDebugMock(shouldUseMockUser);
        setTelegramInitData(telegramInitDataValue);
        setIsTelegramWebAppDetected(Boolean(tg));
        setIsTelegramUserAgentDetected(isTelegramUa);
      }

      await bootstrapUser(telegramInitDataValue, telegramUser?.username ?? null);

      if (isMounted) {
        await loadHouseholds();
        await fetchRoomsForHousehold();
        setMessage("User initialized");
      }
    }

    saveTelegramUser().catch((error) => {
      console.error("Unexpected Telegram/Supabase error:", error);
      if (!isMounted) {
        return;
      }
      const errorText = error instanceof Error ? error.message : "Unexpected auth error";
      if (errorText.includes("DEV_BROWSER_MODE is only allowed in development")) {
        setMessage("Browser debug works only on local dev (`npm run dev`), not on deployed app.");
        return;
      }
      if (errorText.includes("Missing TELEGRAM_BOT_TOKEN")) {
        setMessage(
          "No Telegram auth on server. Use local browser debug (`npm run dev`) or set TELEGRAM_BOT_TOKEN for Telegram Mini App auth.",
        );
        return;
      }
      setMessage(errorText);
    });

    return () => {
      isMounted = false;
    };
    // bootstrap is intentionally run once on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleCreateRoom() {
    const newRoomName = roomName.trim();
    if (!newRoomName) {
      setMessage("Enter room name");
      return;
    }

    await createRoom(getCurrentInitData(), newRoomName);
    setRoomName("");
    setIsCreateRoomOpen(false);
    setMessage("Room created");
    await fetchRoomsForHousehold();
  }

  async function handleJoinHome() {
    const code = joinCode.trim().toUpperCase();
    if (!code) {
      setMessage("Enter invite code");
      return;
    }

    const targetHome = await joinHousehold(getCurrentInitData(), code);
    if (targetHome.household_id === householdId) {
      setMessage("This home is already active");
      await loadHouseholds();
      return;
    }

    setSelectedRoom(null);
    clearRoomDetailState();
    setIsJoinHomeOpen(false);
    setJoinCode("");
    await loadHouseholds();
    await fetchRoomsForHousehold();
    setMessage(`Joined ${targetHome.household_name}`);
  }

  async function handleSwitchHousehold(targetId: string) {
    await setActiveHousehold(getCurrentInitData(), targetId);
    setSelectedRoom(null);
    clearRoomDetailState();
    await loadHouseholds();
    await fetchRoomsForHousehold();
    setMessage("Home switched");
  }

  async function handleCreateHome() {
    const label = newHomeName.trim();
    await createHousehold(getCurrentInitData(), label.length > 0 ? label : null);
    setNewHomeName("");
    setIsCreateHomeOpen(false);
    setSelectedRoom(null);
    clearRoomDetailState();
    await loadHouseholds();
    await fetchRoomsForHousehold();
    setMessage("New home created");
  }

  async function handleDeleteRoom(roomId: string) {
    await deleteRoom(getCurrentInitData(), roomId);
    if (selectedRoom?.id === roomId) {
      setSelectedRoom(null);
      clearRoomDetailState();
    }
    await fetchRoomsForHousehold();
    setMessage("Room deleted");
  }

  async function handleDeleteHousehold(targetHouseholdId: string) {
    await deleteHousehold(getCurrentInitData(), targetHouseholdId);
    if (householdId === targetHouseholdId) {
      setSelectedRoom(null);
      clearRoomDetailState();
    }
    await loadHouseholds();
    await fetchRoomsForHousehold();
    setMessage("Home deleted");
  }

  async function handleSubmitRenameHome() {
    const id = renameHomeId;
    const label = renameHomeInput.trim();
    if (!id) {
      return;
    }
    if (!label) {
      setMessage("Enter home name");
      return;
    }
    await renameHousehold(getCurrentInitData(), id, label);
    setIsRenameHomeOpen(false);
    setRenameHomeId(null);
    setRenameHomeInput("");
    await loadHouseholds();
    setMessage("Home renamed");
  }

  async function handleSubmitRenameRoom() {
    const id = renameRoomId;
    const label = renameRoomInput.trim();
    if (!id) {
      return;
    }
    if (!label) {
      setMessage("Enter room name");
      return;
    }
    await renameRoom(getCurrentInitData(), id, label);
    setIsRenameRoomOpen(false);
    setRenameRoomId(null);
    setRenameRoomInput("");
    await fetchRoomsForHousehold();
    setMessage("Room renamed");
  }

  function householdInitials(name: string) {
    const parts = name.trim().split(/\s+/).filter(Boolean);
    if (parts.length >= 2) {
      return (parts[0]!.slice(0, 1) + parts[1]!.slice(0, 1)).toUpperCase();
    }
    const compact = name.trim().slice(0, 2);
    return compact.length > 0 ? compact.toUpperCase() : "H";
  }

  function householdCardTint(index: number) {
    const tints = [
      "from-[#006c49] to-[#0d8f6e]",
      "from-[#944a23] to-[#c45c2a]",
      "from-[#355c7d] to-[#5b8fb9]",
      "from-[#5c4d7d] to-[#8b7ab8]",
    ];
    return tints[index % tints.length]!;
  }

  async function copyInviteCode() {
    const code = currentHousehold?.invite_code;
    if (!code) {
      setMessage("No invite code yet");
      return;
    }
    try {
      await navigator.clipboard.writeText(code);
      setMessage("Invite code copied");
    } catch {
      setMessage("Could not copy — select and copy manually");
    }
  }

  async function handleCreatePlant() {
    if (!selectedRoom || !householdId) {
      setMessage("Room is not ready");
      return;
    }

    const newPlantName = plantName.trim();
    if (!newPlantName) {
      setMessage("Enter plant name");
      return;
    }

    const createdPlant = await createPlant(getCurrentInitData(), {
      roomId: selectedRoom.id,
      name: newPlantName,
      species: plantSpecies.trim() || null,
      status: plantStatus,
    });

    setPlantName("");
    setPlantSpecies("");
    setPlantStatus("healthy");
    setIsAddPlantOpen(false);
    await fetchRoomDetails(selectedRoom.id);
    if (createdPlant?.id) {
      setSelectedPlantIdForMarker(createdPlant.id);
      setIsMarkerEditMode(true);
      setMessage("Plant added. Tap image to place marker");
    } else {
      setMessage("Plant added");
    }
  }

  async function handleWaterPlant(plantId: string, roomId: string) {
    if (!roomId) {
      return;
    }
    const plantBeforeWatering = plants.find((plant) => plant.id === plantId) ?? null;
    const hadRecentWatering =
      plantBeforeWatering?.last_watered_at != null &&
      !Number.isNaN(new Date(plantBeforeWatering.last_watered_at).getTime());

    await waterPlant(getCurrentInitData(), plantId);
    await fetchRoomDetails(roomId);
    setMessage(hadRecentWatering ? "Timer reset" : "Plant marked as watered");
  }

  async function handleUndoLastWatering() {
    if (!selectedRoom || !editingPlantId) {
      return;
    }
    const currentEditingPlantId = editingPlantId;
    await revertLastWatering(getCurrentInitData(), {
      plantId: currentEditingPlantId,
    });
    setIsEditPlantOpen(false);
    setEditingPlantId(null);
    await fetchRoomDetails(selectedRoom.id);
    setMessage("Last watering undone");
  }

  async function handleMarkerTap(
    plantId: string,
    markerId: string,
    roomId: string,
    startedAtMs: number,
  ) {
    if (pendingWateringTimersRef.current[markerId]) {
      return;
    }
    setActiveMarkerId(markerId);
    setPendingWateringMarkerIds((prev) =>
      prev.includes(markerId) ? prev : [...prev, markerId],
    );
    setPendingWateringNowMs((now) => Math.max(now, startedAtMs));
    setPendingWateringStartedAtByMarkerId((prev) => ({ ...prev, [markerId]: startedAtMs }));
    pendingWateringTimersRef.current[markerId] = window.setTimeout(() => {
      delete pendingWateringTimersRef.current[markerId];
      setPendingWateringStartedAtByMarkerId((prev) => {
        const next = { ...prev };
        delete next[markerId];
        return next;
      });
      setPendingWateringMarkerIds((prev) => prev.filter((id) => id !== markerId));
      setJustWateredMarkerId(markerId);
      setTimeout(() => {
        setJustWateredMarkerId((prev) => (prev === markerId ? null : prev));
      }, 700);
      void runSafely(async () => {
        await handleWaterPlant(plantId, roomId);
        setActiveMarkerId((prev) => (prev === markerId ? null : prev));
      });
    }, MARKER_WATER_DELAY_MS);
  }

  function handleCancelPendingMarkerWatering(markerId: string) {
    const timerId = pendingWateringTimersRef.current[markerId];
    if (!timerId) {
      return;
    }
    window.clearTimeout(timerId);
    delete pendingWateringTimersRef.current[markerId];
    setPendingWateringStartedAtByMarkerId((prev) => {
      const next = { ...prev };
      delete next[markerId];
      return next;
    });
    setPendingWateringMarkerIds((prev) => prev.filter((id) => id !== markerId));
    setActiveMarkerId((prev) => (prev === markerId ? null : prev));
  }

  function getPendingWateringSecondsLeft(markerId: string) {
    const startedAt = pendingWateringStartedAtByMarkerId[markerId];
    if (!startedAt) {
      return 0;
    }
    const elapsedMs = Math.max(0, pendingWateringNowMs - startedAt);
    const remainingMs = Math.max(0, MARKER_WATER_DELAY_MS - elapsedMs);
    return Math.ceil(remainingMs / 1000);
  }

  function consumeLongPressHandled(markerId: string) {
    if (markerLongPressHandledRef.current === markerId) {
      markerLongPressHandledRef.current = null;
      return true;
    }
    return false;
  }

  function clearMarkerLongPressTimer() {
    if (markerLongPressTimerRef.current !== null) {
      window.clearTimeout(markerLongPressTimerRef.current);
      markerLongPressTimerRef.current = null;
    }
  }

  function startMarkerLongPress(markerId: string, plant: Plant | undefined) {
    clearMarkerLongPressTimer();
    markerLongPressHandledRef.current = null;
    if (!plant) {
      return;
    }
    markerLongPressTimerRef.current = window.setTimeout(() => {
      markerLongPressHandledRef.current = markerId;
      setShowMarkerLongPressHint(false);
      window.localStorage.setItem("markerLongPressHintDismissed", "1");
      setActiveMarkerId(markerId);
      openEditPlantDialog(plant);
    }, 550);
  }

  function stopMarkerLongPress() {
    clearMarkerLongPressTimer();
  }

  function openEditPlantDialog(plant: Plant) {
    setEditingPlantId(plant.id);
    setEditPlantName(plant.name);
    setEditPlantSpecies(plant.species ?? "");
    setEditPlantStatus(plant.status);
    setIsEditPlantOpen(true);
  }

  async function handleSavePlantEdits() {
    if (!selectedRoom || !editingPlantId) {
      return;
    }

    const nextName = editPlantName.trim();
    if (!nextName) {
      setMessage("Enter plant name");
      return;
    }

    await updatePlant(getCurrentInitData(), {
      plantId: editingPlantId,
      name: nextName,
      species: editPlantSpecies.trim() || null,
      status: editPlantStatus,
    });

    setIsEditPlantOpen(false);
    setEditingPlantId(null);
    await fetchRoomDetails(selectedRoom.id);
    setMessage("Plant updated");
  }

  async function handleDeletePlant() {
    if (!selectedRoom || !editingPlantId) {
      return;
    }
    const plantId = editingPlantId;
    await deletePlant(getCurrentInitData(), plantId);
    setIsEditPlantOpen(false);
    setEditingPlantId(null);
    await fetchRoomDetails(selectedRoom.id);
    setMessage("Plant deleted");
  }

  function requestDeleteRoom(roomId: string, roomLabel: string) {
    setPendingDeleteTarget({ kind: "room", id: roomId, label: roomLabel });
  }

  function requestDeleteHousehold(targetHouseholdId: string, homeLabel: string) {
    setPendingDeleteTarget({ kind: "household", id: targetHouseholdId, label: homeLabel });
  }

  function requestDeletePlant() {
    if (!editingPlantId) {
      return;
    }
    const plantToDelete = plants.find((plant) => plant.id === editingPlantId);
    setPendingDeleteTarget({
      kind: "plant",
      id: editingPlantId,
      label: plantToDelete?.name ?? "this plant",
    });
  }

  async function handleConfirmDelete() {
    const target = pendingDeleteTarget;
    if (!target) {
      return;
    }
    if (target.kind === "room") {
      await handleDeleteRoom(target.id);
    } else if (target.kind === "household") {
      await handleDeleteHousehold(target.id);
    } else {
      if (editingPlantId !== target.id) {
        const plantToEdit = plants.find((plant) => plant.id === target.id);
        if (plantToEdit) {
          openEditPlantDialog(plantToEdit);
        }
      }
      await handleDeletePlant();
    }
    setPendingDeleteTarget(null);
  }

  function handleEditMarkerForPlant() {
    if (!editingPlantId) {
      return;
    }
    setSelectedPlantIdForMarker(editingPlantId);
    setIsMarkerEditMode(true);
    setIsEditPlantOpen(false);
    setMessage("Tap image to set marker position");
  }

  async function handleImageClick(event: React.MouseEvent<HTMLDivElement>) {
    if (!selectedRoom) {
      return;
    }
    if (!isMarkerEditMode) {
      return;
    }
    if (!selectedPlantIdForMarker) {
      setMessage("Choose a plant first");
      return;
    }

    const rect = event.currentTarget.getBoundingClientRect();
    if (!rect.width || !rect.height) {
      return;
    }

    const contentBox =
      roomImageContentBox ??
      computeObjectContainBox(
        rect.width,
        rect.height,
        roomImageRef.current?.naturalWidth ?? rect.width,
        roomImageRef.current?.naturalHeight ?? rect.height,
      );
    const localX = event.clientX - rect.left - contentBox.left;
    const localY = event.clientY - rect.top - contentBox.top;
    if (localX < 0 || localY < 0 || localX > contentBox.width || localY > contentBox.height) {
      setMessage("Tap on the image area to place marker");
      return;
    }

    const rawX = localX / contentBox.width;
    const rawY = localY / contentBox.height;
    const x = Math.min(Math.max(rawX, 0), 1);
    const y = Math.min(Math.max(rawY, 0), 1);

    await upsertMarker(getCurrentInitData(), {
      roomId: selectedRoom.id,
      plantId: selectedPlantIdForMarker,
      x,
      y,
    });

    await fetchRoomDetails(selectedRoom.id);
    setMessage("Marker saved");
    setIsMarkerEditMode(false);
  }

  function handleRoomFileChange(roomId: string, file: File | null) {
    setRoomFiles((prev) => ({
      ...prev,
      [roomId]: file,
    }));
    setRoomUploadStatus((prev) => ({
      ...prev,
      [roomId]: file ? `Selected: ${file.name}` : "No file selected",
    }));
  }

  async function handleUploadImage(roomId: string) {
    const file = roomFiles[roomId];
    if (!file) {
      const text = "No file selected";
      setRoomUploadStatus((prev) => ({
        ...prev,
        [roomId]: text,
      }));
      return;
    }

    setRoomUploadStatus((prev) => ({
      ...prev,
      [roomId]: "Uploading...",
    }));

    await uploadRoomImage(getCurrentInitData(), { roomId, file });

    setRoomFiles((prev) => ({
      ...prev,
      [roomId]: null,
    }));
    setRoomUploadStatus((prev) => ({
      ...prev,
      [roomId]: "Uploaded successfully",
    }));
    await fetchRoomsForHousehold();
  }

  async function runSafely(action: () => Promise<void>) {
    try {
      await action();
    } catch (error) {
      const text = error instanceof Error ? error.message : "Unexpected error";
      console.error(text);
      setMessage(text);
    }
  }

  const homesForPicker =
    householdSummaries.length > 0
      ? householdSummaries
      : currentHousehold
        ? [
            {
              household_id: currentHousehold.id,
              household_name: currentHousehold.name,
              invite_code: currentHousehold.invite_code,
              is_active: true,
            },
          ]
        : [];

  useEffect(() => {
    return () => {
      clearMarkerLongPressTimer();
      const timers = Object.values(pendingWateringTimersRef.current);
      for (const timerId of timers) {
        window.clearTimeout(timerId);
      }
      pendingWateringTimersRef.current = {};
    };
  }, []);

  useEffect(() => {
    if (!selectedRoom) return;
    const onResize = () => {
      measureRoomImageContentBox();
    };
    onResize();
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
    };
  }, [measureRoomImageContentBox, selectedRoom]);

  return (
    <MobileShell>
    <main className="min-h-screen bg-[#fff8f5] pb-32 text-[#1f1b17]">
      {selectedRoom ? (
        <div className="mx-auto flex w-full max-w-5xl flex-col">
          <header className="fixed top-0 z-30 flex h-16 w-full items-center justify-between border-b border-[#eae1da] bg-[#fff8f5]/90 px-5 backdrop-blur-md">
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => {
                  setSelectedRoom(null);
                  clearRoomDetailState();
                }}
                className="active:scale-95"
              >
                <ArrowLeft className="h-5 w-5 text-[#3c4a42]" />
              </button>
              <div className="flex items-center gap-2">
                <Sprout className="h-5 w-5 text-[#006c49]" />
                <p className="text-sm font-semibold text-[#006c49]">GreenHouse</p>
              </div>
            </div>
            <div className="flex min-w-0 max-w-[min(100%,20rem)] flex-1 items-center justify-end gap-2 sm:max-w-none">
              <div className="flex min-w-0 items-center gap-1">
                <p className="truncate text-xs font-medium text-[#6c7a71]">{selectedRoom.name}</p>
                <button
                  type="button"
                  onClick={() => {
                    setRenameRoomId(selectedRoom.id);
                    setRenameRoomInput(selectedRoom.name);
                    setIsRenameRoomOpen(true);
                  }}
                  className="shrink-0 rounded-md p-1 text-[#6c7a71] transition hover:bg-[#e6f5ef] hover:text-[#006c49]"
                  aria-label="Rename room"
                >
                  <Pencil className="h-[18px] w-[18px]" />
                </button>
              </div>
              <button
                type="button"
                onClick={() => setIsAddPlantOpen(true)}
                className="shrink-0 rounded-lg border-b-2 border-[#005236] bg-[#006c49] px-3 py-1 text-xs font-semibold text-white"
              >
                Add Plant
              </button>
            </div>
          </header>

          <section className="px-5 pt-20">
            <div
              className="relative overflow-hidden rounded-[24px] bg-[#f6ece6] shadow-[0_4px_20px_rgba(148,74,35,0.08)]"
              ref={roomImageContainerRef}
              onClick={(event) => {
                void runSafely(() => handleImageClick(event));
              }}
            >
              {showMarkerLongPressHint ? (
                <div className="pointer-events-none absolute right-3 top-3 z-10 rounded-full bg-white/90 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide text-[#3c4a42] shadow">
                  Long press marker to edit plant
                </div>
              ) : null}
              {getRoomImageUrl(selectedRoom) ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={getRoomImageUrl(selectedRoom) ?? undefined}
                  alt={selectedRoom.name}
                  className="h-[72vh] w-full object-contain"
                  ref={roomImageRef}
                  onLoad={() => {
                    measureRoomImageContentBox();
                  }}
                />
              ) : (
                <div className="flex h-[72vh] items-center justify-center text-sm text-[#6c7a71]">
                  No image yet
                </div>
              )}
              {markers.map((marker) => {
                const markerPlant = plants.find((plant) => plant.id === marker.plant_id);
                const isActive = activeMarkerId === marker.id;
                const isPendingWatering = pendingWateringMarkerIds.includes(marker.id);
                const isJustWatered = justWateredMarkerId === marker.id;
                const secondsLeft = getPendingWateringSecondsLeft(marker.id);
                const status = wateringDerivedStatus(markerPlant?.last_watered_at ?? null);
                const colors = getMarkerColorClasses(status);
                return (
                  <div
                    key={marker.id}
                    style={{
                      left: roomImageContentBox
                        ? `${roomImageContentBox.left + marker.x * roomImageContentBox.width}px`
                        : `${marker.x * 100}%`,
                      top: roomImageContentBox
                        ? `${roomImageContentBox.top + marker.y * roomImageContentBox.height}px`
                        : `${marker.y * 100}%`,
                    }}
                    className="absolute -translate-x-1/2 -translate-y-1/2"
                  >
                    <button
                      type="button"
                      className={`relative h-6 w-6 rounded-full border-2 border-white shadow-md transition-all ${
                        isJustWatered ? "scale-125 ring-4 ring-[#10b981]/35" : ""
                      } ${colors.pin}`}
                      onPointerDown={(event) => {
                        event.stopPropagation();
                        startMarkerLongPress(marker.id, markerPlant);
                      }}
                      onPointerUp={(event) => {
                        event.stopPropagation();
                        stopMarkerLongPress();
                      }}
                      onPointerCancel={(event) => {
                        event.stopPropagation();
                        stopMarkerLongPress();
                      }}
                      onPointerLeave={(event) => {
                        event.stopPropagation();
                        stopMarkerLongPress();
                      }}
                      onClick={(event) => {
                        event.stopPropagation();
                        if (consumeLongPressHandled(marker.id)) {
                          return;
                        }
                        void runSafely(() =>
                          handleMarkerTap(marker.plant_id, marker.id, selectedRoom.id, event.timeStamp),
                        );
                      }}
                      title={markerPlant?.name ?? "Plant marker"}
                      aria-label={markerPlant?.name ?? "Plant marker"}
                    >
                      <span className={`absolute inset-0 animate-ping rounded-full ${colors.pulse}`} />
                    </button>
                    {isPendingWatering ? (
                      <div className="absolute bottom-8 left-1/2 -translate-x-1/2 rounded-lg bg-white px-2 py-1 text-[10px] font-semibold text-[#3c4a42] shadow-md">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-[9px] text-[#6c7a71]">Watering in {secondsLeft}s</span>
                          <button
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation();
                              handleCancelPendingMarkerWatering(marker.id);
                            }}
                            className="rounded-md border border-[#ba1a1a]/30 px-1.5 py-0.5 text-[9px] font-semibold text-[#93000a] hover:bg-[#ffdad6]/40"
                          >
                            Cancel
                          </button>
                        </div>
                        <span className="absolute left-1/2 top-full h-2 w-2 -translate-x-1/2 -translate-y-1 rotate-45 bg-white" />
                      </div>
                    ) : null}
                  </div>
                );
              })}
              {isMarkerEditMode ? (
                <div className="absolute left-3 top-3 flex items-center gap-2 rounded-lg bg-white/90 px-2 py-1 text-xs text-[#3c4a42] shadow">
                  <span>Marker edit mode</span>
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      setIsMarkerEditMode(false);
                    }}
                    className="rounded bg-[#ffdad6] px-1.5 py-0.5 text-[10px] font-semibold text-[#93000a]"
                  >
                    Cancel
                  </button>
                </div>
              ) : null}
            </div>
            <div className="mt-4 rounded-[24px] bg-white p-4 shadow-[0_4px_20px_rgba(148,74,35,0.06)]">
              <h3 className="text-sm font-semibold text-[#3c4a42]">Plants in this room</h3>
              {plants.length === 0 ? (
                <p className="mt-2 text-sm text-[#6c7a71]">No plants yet</p>
              ) : (
                <ul className="mt-2 space-y-2">
                  {plants.map((plant) => {
                    const hasMarker = markers.some((marker) => marker.plant_id === plant.id);
                    return (
                    <li
                      key={plant.id}
                      className="rounded-xl bg-[#fcf2eb] px-3 py-2 text-sm text-[#1f1b17]"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <p className="font-semibold">
                            {plant.name}
                            {!hasMarker ? (
                              <span className="ml-2 rounded-full bg-[#ffedd5] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[#9a3412]">
                                no marker
                              </span>
                            ) : null}
                          </p>
                          {plant.species ? (
                            <p className="text-xs text-[#6c7a71]">{plant.species}</p>
                          ) : null}
                          <p className="mt-1 text-[10px] uppercase tracking-wide text-[#6c7a71]">
                            {wateringDerivedStatus(plant.last_watered_at)}
                          </p>
                          <p className="text-[10px] text-[#6c7a71]">
                            Last watered: {formatLastWatered(plant.last_watered_at)}
                          </p>
                        </div>
                        <div className="flex flex-col gap-2">
                          <button
                            type="button"
                            onClick={() => {
                              void runSafely(() => handleWaterPlant(plant.id, selectedRoom.id));
                            }}
                            className="rounded-lg border-b-2 border-[#005236] bg-[#006c49] px-2.5 py-1.5 text-[11px] font-semibold text-white"
                          >
                            Watered
                          </button>
                          <button
                            type="button"
                            onClick={() => openEditPlantDialog(plant)}
                            className="rounded-lg border border-[#bbcabf] px-2.5 py-1.5 text-[11px] font-semibold text-[#3c4a42]"
                          >
                            Edit Plant
                          </button>
                        </div>
                      </div>
                    </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </section>
        </div>
      ) : (
        <div className="mx-auto w-full max-w-5xl px-5 pt-6">
          <header className="mb-8 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Sprout className="h-6 w-6 text-[#006c49]" />
              <p className="text-lg font-extrabold tracking-tight text-[#006c49]">GreenHouse</p>
            </div>
            <Link
              href="/settings"
              className="rounded-full bg-white p-2 text-[#6c7a71] shadow-sm"
              aria-label="Settings"
            >
              <Settings className="h-5 w-5" />
            </Link>
          </header>

          <section className="mb-8 flex items-end justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[#006c49]">
                My Sanctuary
              </p>
              <h1 className="mt-1 text-3xl font-bold tracking-tight">Rooms Overview</h1>
              <p className="mt-1 text-sm text-[#6c7a71]">{message}</p>
              {isDebugMock ? (
                <p className="mt-1 text-xs text-[#944a23]">Debug mode: mock Telegram user</p>
              ) : null}
              <p className="mt-2 text-[11px] text-[#6c7a71]">
                Telegram WebApp: {isTelegramWebAppDetected ? "yes" : "no"} · initData:{" "}
                {telegramInitData ? "present" : "missing"} · telegram user agent:{" "}
                {isTelegramUserAgentDetected ? "yes" : "no"}
              </p>
            </div>
          </section>

          <section className="relative mb-6 overflow-hidden rounded-[28px] shadow-[0_8px_40px_rgba(0,108,73,0.12)] ring-1 ring-[#006c49]/10">
            <div
              className="pointer-events-none absolute -right-16 -top-24 h-48 w-48 rounded-full bg-[#006c49] opacity-[0.14] blur-3xl"
              aria-hidden
            />
            <div
              className="pointer-events-none absolute -bottom-20 -left-12 h-40 w-40 rounded-full bg-[#944a23] opacity-[0.1] blur-3xl"
              aria-hidden
            />
            <div className="relative bg-gradient-to-br from-white via-[#faf9f7] to-[#eef7f2] p-5">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-[#006c49]">
                    Your homes
                  </p>
                  <h2 className="mt-1 text-xl font-bold tracking-tight text-[#1f1b17]">
                    Pick a space
                  </h2>
                  <p className="mt-0.5 text-xs text-[#6c7a71]">
                    Switch anytime — rooms and plants follow the active home.
                  </p>
                </div>
                {homesForPicker.length > 0 ? (
                  <div className="flex h-10 min-w-10 items-center justify-center rounded-2xl bg-[#006c49]/10 px-2.5 text-sm font-bold tabular-nums text-[#006c49]">
                    {homesForPicker.length}
                  </div>
                ) : (
                  <div className="h-10 w-10 animate-pulse rounded-2xl bg-[#e8ece9]" aria-hidden />
                )}
              </div>

              {homesForPicker.length === 0 ? (
                <div className="mt-4 rounded-2xl border border-dashed border-[#c5d4cc] bg-white/60 p-8 text-center">
                  <p className="text-sm font-medium text-[#6c7a71]">Loading your homes…</p>
                </div>
              ) : (
              <div
                className={`mt-4 flex gap-3 ${
                  homesForPicker.length <= 1
                    ? "flex-col"
                    : "snap-x snap-mandatory overflow-x-auto pb-2 pt-0.5 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
                }`}
              >
                {homesForPicker.map((h, index) => {
                  const isCurrent = h.household_id === householdId;
                  const tint = householdCardTint(index);
                  return (
                    <div
                      key={h.household_id}
                      className={`group flex transition ${
                        homesForPicker.length <= 1 ? "w-full" : "w-[min(100%,11.5rem)] shrink-0 snap-start sm:w-44"
                      } rounded-2xl border-2 focus-within:ring-2 focus-within:ring-[#006c49] focus-within:ring-offset-2 ${
                        isCurrent
                          ? "border-[#006c49] bg-white shadow-[0_6px_24px_rgba(0,108,73,0.15)]"
                          : "border-transparent bg-white/70 shadow-sm hover:border-[#bbcabf]/80 hover:bg-white hover:shadow-md"
                      }`}
                    >
                      <button
                        type="button"
                        onClick={() => {
                          if (!isCurrent) {
                            void runSafely(() => handleSwitchHousehold(h.household_id));
                          }
                        }}
                        className={`min-w-0 flex-1 rounded-2xl p-3.5 text-left focus:outline-none ${
                          isCurrent ? "cursor-default" : "cursor-pointer active:scale-[0.98]"
                        }`}
                      >
                        <div className="flex items-start gap-3">
                          <div
                            className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br text-sm font-bold text-white shadow-inner ${tint}`}
                          >
                            {householdInitials(h.household_name)}
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className="truncate font-semibold leading-snug text-[#1f1b17]">
                              {h.household_name}
                            </p>
                            <div className="mt-1 flex flex-wrap items-center gap-1.5">
                              {isCurrent ? (
                                <span className="inline-flex items-center gap-0.5 rounded-full bg-[#e6f5ef] px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-[#006c49]">
                                  <CheckCircle2 className="h-3 w-3" />
                                  Active
                                </span>
                              ) : (
                                <span className="text-[10px] font-semibold uppercase tracking-wide text-[#6c7a71]">
                                  Tap to open
                                </span>
                              )}
                            </div>
                          </div>
                        </div>
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setRenameHomeId(h.household_id);
                          setRenameHomeInput(h.household_name);
                          setIsRenameHomeOpen(true);
                        }}
                        className="flex shrink-0 items-start justify-center px-1.5 pb-2 pt-3 text-[#6c7a71] transition hover:bg-[#e6f5ef]/80 hover:text-[#006c49] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#006c49]/30"
                        aria-label={`Rename home ${h.household_name}`}
                      >
                        <Pencil className="h-5 w-5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          requestDeleteHousehold(h.household_id, h.household_name);
                        }}
                        className="flex shrink-0 items-start justify-center rounded-tr-2xl rounded-br-2xl px-2.5 pb-2 pt-3 text-[#6c7a71] transition hover:bg-[#ffdad6]/50 hover:text-[#93000a] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#ba1a1a]/40"
                        aria-label={`Delete home ${h.household_name}`}
                      >
                        <Trash2 className="h-5 w-5" />
                      </button>
                    </div>
                  );
                })}
              </div>
              )}

              <div className="mt-4 rounded-2xl border border-[#e8e4e0] bg-white/80 p-3 backdrop-blur-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2 text-xs font-semibold text-[#6c7a71]">
                    <KeyRound className="h-4 w-4 text-[#006c49]/80" />
                    <span>Invite friends</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      void runSafely(copyInviteCode);
                    }}
                    className="inline-flex items-center gap-1 rounded-full border border-[#d4e8df] bg-[#f4faf7] px-2.5 py-1 text-[11px] font-semibold text-[#006c49] transition hover:bg-[#e6f5ef]"
                  >
                    <Copy className="h-4 w-4" />
                    Copy
                  </button>
                </div>
                <p className="mt-2 break-all font-mono text-sm font-semibold tracking-[0.08em] text-[#1f1b17]">
                  {currentHousehold?.invite_code ?? "—"}
                </p>
              </div>

              <div className="mt-4 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => setIsCreateHomeOpen(true)}
                  className="inline-flex flex-1 min-w-[9rem] items-center justify-center gap-2 rounded-2xl border-b-2 border-[#005236] bg-[#006c49] px-4 py-3 text-sm font-semibold text-white shadow-[0_4px_14px_rgba(0,108,73,0.35)] transition active:translate-y-px"
                >
                  <HousePlus className="h-5 w-5" />
                  New home
                </button>
                <button
                  type="button"
                  onClick={() => setIsJoinHomeOpen(true)}
                  className="inline-flex flex-1 min-w-[9rem] items-center justify-center gap-2 rounded-2xl border border-[#d5ddd9] bg-white px-4 py-3 text-sm font-semibold text-[#3c4a42] shadow-sm transition hover:border-[#bbcabf] hover:bg-[#fafafa]"
                >
                  <DoorOpen className="h-5 w-5 text-[#6c7a71]" />
                  Join with code
                </button>
              </div>
            </div>
          </section>

          <section className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {rooms.length === 0 ? (
              <div className="rounded-[24px] bg-white p-5 text-sm text-[#6c7a71] shadow-[0_4px_20px_rgba(148,74,35,0.06)]">
                No rooms yet
              </div>
            ) : (
              rooms.map((room) => (
                <article
                  key={room.id}
                  className="cursor-pointer overflow-hidden rounded-[24px] bg-white shadow-[0_4px_20px_rgba(148,74,35,0.06)] transition hover:shadow-[0_8px_30px_rgba(148,74,35,0.12)]"
                  onClick={() => {
                    setSelectedRoom(room);
                    void runSafely(() => fetchRoomDetails(room.id));
                  }}
                >
                  <div className="relative h-48 bg-[#f6ece6]">
                    {getRoomImageUrl(room) ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={getRoomImageUrl(room) ?? undefined}
                        alt={room.name}
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      <div className="flex h-full items-center justify-center text-sm text-[#6c7a71]">
                        No image
                      </div>
                    )}
                    <button
                      type="button"
                      className="absolute left-2 top-2 rounded-full bg-white/95 p-1.5 text-[#006c49] shadow-md active:scale-95"
                      aria-label={`Rename ${room.name}`}
                      onClick={(event) => {
                        event.stopPropagation();
                        setRenameRoomId(room.id);
                        setRenameRoomInput(room.name);
                        setIsRenameRoomOpen(true);
                      }}
                    >
                      <Pencil className="h-[18px] w-[18px]" />
                    </button>
                    <button
                      type="button"
                      className="absolute right-2 top-2 rounded-full bg-white/95 p-1.5 text-[#93000a] shadow-md active:scale-95"
                      aria-label={`Delete ${room.name}`}
                      onClick={(event) => {
                        event.stopPropagation();
                        requestDeleteRoom(room.id, room.name);
                      }}
                    >
                      <Trash2 className="h-[18px] w-[18px]" />
                    </button>
                  </div>

                  <div className="p-4">
                    <p className="text-lg font-semibold text-[#944a23]">{room.name}</p>
                    <p className="mt-1 text-xs text-[#6c7a71]">Tap card to open detail</p>

                    <div className="mt-4 flex items-center gap-2" onClick={(event) => event.stopPropagation()}>
                      <input
                        type="file"
                        accept="image/*"
                        onChange={(event) =>
                          handleRoomFileChange(room.id, event.target.files?.[0] ?? null)
                        }
                        className="w-full text-xs"
                      />
                      <button
                        type="button"
                        onClick={() => {
                          void runSafely(() => handleUploadImage(room.id));
                        }}
                        className="whitespace-nowrap rounded-lg border border-[#bbcabf] px-3 py-2 text-xs font-medium"
                      >
                        Upload Image
                      </button>
                    </div>

                    {roomUploadStatus[room.id] ? (
                      <p className="mt-2 text-xs text-[#6c7a71]">{roomUploadStatus[room.id]}</p>
                    ) : null}
                  </div>
                </article>
              ))
            )}
          </section>

          <button
            type="button"
            onClick={() => setIsCreateRoomOpen(true)}
            className="fixed bottom-24 right-6 z-30 flex h-14 w-14 items-center justify-center rounded-2xl border-b-2 border-[#005236] bg-[#006c49] text-white shadow-xl"
          >
            <Plus className="h-6 w-6" />
          </button>
        </div>
      )}

      {!selectedRoom && isCreateRoomOpen ? (
        <div className="fixed inset-0 z-50 flex items-end justify-center overflow-y-auto bg-black/30 p-4 pb-28 pt-16 sm:items-center sm:pb-4 sm:pt-4">
          <div className="w-full max-w-md rounded-[24px] bg-white p-4 shadow-xl">
            <h3 className="text-base font-semibold text-[#1f1b17]">Add Room</h3>
            <p className="mt-1 text-sm text-[#6c7a71]">Create a new room in your household</p>
            <input
              value={roomName}
              onChange={(event) => setRoomName(event.target.value)}
              placeholder="Room name"
              className="mt-4 w-full rounded-xl border border-[#bbcabf] bg-white px-3 py-2 text-sm outline-none focus:border-[#006c49]"
              autoFocus
            />
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setIsCreateRoomOpen(false)}
                className="rounded-xl border border-[#bbcabf] px-4 py-2 text-sm font-medium text-[#3c4a42]"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  void runSafely(handleCreateRoom);
                }}
                className="rounded-xl border-b-2 border-[#005236] bg-[#006c49] px-4 py-2 text-sm font-semibold text-white"
              >
                Create Room
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {!selectedRoom && isCreateHomeOpen ? (
        <div className="fixed inset-0 z-50 flex items-end justify-center overflow-y-auto bg-black/30 p-4 pb-28 pt-16 sm:items-center sm:pb-4 sm:pt-4">
          <div className="w-full max-w-md rounded-[24px] bg-white p-4 shadow-xl">
            <h3 className="text-base font-semibold text-[#1f1b17]">Create new home</h3>
            <p className="mt-1 text-sm text-[#6c7a71]">Starts an empty household. You can switch anytime.</p>
            <input
              value={newHomeName}
              onChange={(event) => setNewHomeName(event.target.value)}
              placeholder="Home name (optional)"
              className="mt-4 w-full rounded-xl border border-[#bbcabf] bg-white px-3 py-2 text-sm outline-none focus:border-[#006c49]"
              autoFocus
            />
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setIsCreateHomeOpen(false)}
                className="rounded-xl border border-[#bbcabf] px-4 py-2 text-sm font-medium text-[#3c4a42]"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  void runSafely(handleCreateHome);
                }}
                className="rounded-xl border-b-2 border-[#005236] bg-[#006c49] px-4 py-2 text-sm font-semibold text-white"
              >
                Create
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {isRenameRoomOpen ? (
        <div className="fixed inset-0 z-50 flex items-end justify-center overflow-y-auto bg-black/30 p-4 pb-28 pt-16 sm:items-center sm:pb-4 sm:pt-4">
          <div className="w-full max-w-md rounded-[24px] bg-white p-4 shadow-xl">
            <h3 className="text-base font-semibold text-[#1f1b17]">Rename room</h3>
            <p className="mt-1 text-sm text-[#6c7a71]">Shown on cards and in the room header.</p>
            <input
              value={renameRoomInput}
              onChange={(event) => setRenameRoomInput(event.target.value)}
              placeholder="Room name"
              className="mt-4 w-full rounded-xl border border-[#bbcabf] bg-white px-3 py-2 text-sm outline-none focus:border-[#006c49]"
              autoFocus
            />
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setIsRenameRoomOpen(false);
                  setRenameRoomId(null);
                  setRenameRoomInput("");
                }}
                className="rounded-xl border border-[#bbcabf] px-4 py-2 text-sm font-medium text-[#3c4a42]"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  void runSafely(handleSubmitRenameRoom);
                }}
                className="rounded-xl border-b-2 border-[#005236] bg-[#006c49] px-4 py-2 text-sm font-semibold text-white"
              >
                Save
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {!selectedRoom && isRenameHomeOpen ? (
        <div className="fixed inset-0 z-50 flex items-end justify-center overflow-y-auto bg-black/30 p-4 pb-28 pt-16 sm:items-center sm:pb-4 sm:pt-4">
          <div className="w-full max-w-md rounded-[24px] bg-white p-4 shadow-xl">
            <h3 className="text-base font-semibold text-[#1f1b17]">Rename home</h3>
            <p className="mt-1 text-sm text-[#6c7a71]">Everyone in this home sees the new name.</p>
            <input
              value={renameHomeInput}
              onChange={(event) => setRenameHomeInput(event.target.value)}
              placeholder="Home name"
              className="mt-4 w-full rounded-xl border border-[#bbcabf] bg-white px-3 py-2 text-sm outline-none focus:border-[#006c49]"
              autoFocus
            />
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setIsRenameHomeOpen(false);
                  setRenameHomeId(null);
                  setRenameHomeInput("");
                }}
                className="rounded-xl border border-[#bbcabf] px-4 py-2 text-sm font-medium text-[#3c4a42]"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  void runSafely(handleSubmitRenameHome);
                }}
                className="rounded-xl border-b-2 border-[#005236] bg-[#006c49] px-4 py-2 text-sm font-semibold text-white"
              >
                Save
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {!selectedRoom && isJoinHomeOpen ? (
        <div className="fixed inset-0 z-50 flex items-end justify-center overflow-y-auto bg-black/30 p-4 pb-28 pt-16 sm:items-center sm:pb-4 sm:pt-4">
          <div className="w-full max-w-md rounded-[24px] bg-white p-4 shadow-xl">
            <h3 className="text-base font-semibold text-[#1f1b17]">Join Home</h3>
            <p className="mt-1 text-sm text-[#6c7a71]">Enter invite code</p>
            <input
              value={joinCode}
              onChange={(event) => setJoinCode(event.target.value.toUpperCase())}
              placeholder="ABC123"
              className="mt-4 w-full rounded-xl border border-[#bbcabf] bg-white px-3 py-2 text-sm uppercase outline-none focus:border-[#006c49]"
              autoFocus
            />
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setIsJoinHomeOpen(false)}
                className="rounded-xl border border-[#bbcabf] px-4 py-2 text-sm font-medium text-[#3c4a42]"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  void runSafely(handleJoinHome);
                }}
                className="rounded-xl border-b-2 border-[#005236] bg-[#006c49] px-4 py-2 text-sm font-semibold text-white"
              >
                Join
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {selectedRoom && isAddPlantOpen ? (
        <div className="fixed inset-0 z-50 flex items-end justify-center overflow-y-auto bg-black/30 p-4 pb-28 pt-16 sm:items-center sm:pb-4 sm:pt-4">
          <div className="w-full max-w-md rounded-[24px] bg-white p-4 shadow-xl">
            <h3 className="text-base font-semibold text-[#1f1b17]">Add Plant</h3>
            <p className="mt-1 text-sm text-[#6c7a71]">{selectedRoom.name}</p>
            <input
              value={plantName}
              onChange={(event) => setPlantName(event.target.value)}
              placeholder="Plant name"
              className="mt-4 w-full rounded-xl border border-[#bbcabf] bg-white px-3 py-2 text-sm outline-none focus:border-[#006c49]"
              autoFocus
            />
            <input
              value={plantSpecies}
              onChange={(event) => setPlantSpecies(event.target.value)}
              placeholder="Species (optional)"
              className="mt-2 w-full rounded-xl border border-[#bbcabf] bg-white px-3 py-2 text-sm outline-none focus:border-[#006c49]"
            />
            <select
              value={plantStatus}
              onChange={(event) => setPlantStatus(event.target.value as PlantStatus)}
              className="mt-2 w-full rounded-xl border border-[#bbcabf] bg-white px-3 py-2 text-sm outline-none focus:border-[#006c49]"
            >
              <option value="healthy">healthy</option>
              <option value="thirsty">thirsty</option>
              <option value="overdue">overdue</option>
            </select>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setIsAddPlantOpen(false)}
                className="rounded-xl border border-[#bbcabf] px-4 py-2 text-sm font-medium text-[#3c4a42]"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  void runSafely(handleCreatePlant);
                }}
                className="rounded-xl border-b-2 border-[#005236] bg-[#006c49] px-4 py-2 text-sm font-semibold text-white"
              >
                Add Plant
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {selectedRoom && isEditPlantOpen ? (
        <div className="fixed inset-0 z-50 flex items-end justify-center overflow-y-auto bg-black/30 p-4 pb-28 pt-16 sm:items-center sm:pb-4 sm:pt-4">
          <div className="w-full max-w-md rounded-[24px] bg-white p-4 shadow-xl">
            <h3 className="text-base font-semibold text-[#1f1b17]">Edit Plant</h3>
            <p className="mt-1 text-sm text-[#6c7a71]">{selectedRoom.name}</p>
            <input
              value={editPlantName}
              onChange={(event) => setEditPlantName(event.target.value)}
              placeholder="Plant name"
              className="mt-4 w-full rounded-xl border border-[#bbcabf] bg-white px-3 py-2 text-sm outline-none focus:border-[#006c49]"
              autoFocus
            />
            <input
              value={editPlantSpecies}
              onChange={(event) => setEditPlantSpecies(event.target.value)}
              placeholder="Species (optional)"
              className="mt-2 w-full rounded-xl border border-[#bbcabf] bg-white px-3 py-2 text-sm outline-none focus:border-[#006c49]"
            />
            <select
              value={editPlantStatus}
              onChange={(event) => setEditPlantStatus(event.target.value as PlantStatus)}
              className="mt-2 w-full rounded-xl border border-[#bbcabf] bg-white px-3 py-2 text-sm outline-none focus:border-[#006c49]"
            >
              <option value="healthy">healthy</option>
              <option value="thirsty">thirsty</option>
              <option value="overdue">overdue</option>
            </select>
            <div className="mt-4 flex flex-wrap justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  requestDeletePlant();
                }}
                className="rounded-xl border border-[#ba1a1a]/30 px-4 py-2 text-sm font-semibold text-[#93000a] hover:bg-[#ffdad6]/40"
              >
                Delete plant
              </button>
              <button
                type="button"
                onClick={() => {
                  void runSafely(handleUndoLastWatering);
                }}
                className="rounded-xl border border-[#ba1a1a]/30 px-4 py-2 text-sm font-semibold text-[#93000a] hover:bg-[#ffdad6]/40"
              >
                Undo last watering
              </button>
              <button
                type="button"
                onClick={handleEditMarkerForPlant}
                className="rounded-xl border border-[#bbcabf] px-4 py-2 text-sm font-semibold text-[#006c49]"
              >
                Edit marker
              </button>
              <button
                type="button"
                onClick={() => setIsEditPlantOpen(false)}
                className="rounded-xl border border-[#bbcabf] px-4 py-2 text-sm font-medium text-[#3c4a42]"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  void runSafely(handleSavePlantEdits);
                }}
                className="rounded-xl border-b-2 border-[#005236] bg-[#006c49] px-4 py-2 text-sm font-semibold text-white"
              >
                Save
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {pendingDeleteTarget ? (
        <div className="fixed inset-0 z-[60] flex items-end justify-center overflow-y-auto bg-black/35 p-4 pb-28 pt-16 sm:items-center sm:pb-4 sm:pt-4">
          <div className="w-full max-w-md rounded-[24px] bg-white p-4 shadow-xl">
            <h3 className="text-base font-semibold text-[#1f1b17]">Delete confirmation</h3>
            <p className="mt-2 text-sm text-[#6c7a71]">
              {pendingDeleteTarget.kind === "household"
                ? `Delete home "${pendingDeleteTarget.label}"? All rooms and plants in this home will be removed for every member.`
                : pendingDeleteTarget.kind === "room"
                  ? `Delete room "${pendingDeleteTarget.label}"? Plants in this room will be removed.`
                  : `Delete "${pendingDeleteTarget.label}"? This cannot be undone.`}
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setPendingDeleteTarget(null)}
                className="rounded-xl border border-[#bbcabf] px-4 py-2 text-sm font-medium text-[#3c4a42]"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  void runSafely(handleConfirmDelete);
                }}
                className="rounded-xl border-b-2 border-[#7a0007] bg-[#ba1a1a] px-4 py-2 text-sm font-semibold text-white"
              >
                Continue
              </button>
            </div>
          </div>
        </div>
      ) : null}

    </main>
    </MobileShell>
  );
}
