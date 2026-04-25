"use client";

import Link from "next/link";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  Camera,
  CheckCircle2,
  Copy,
  DoorOpen,
  HousePlus,
  ImagePlus,
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
  removePlantPhoto,
  revertLastWatering,
  setActiveHousehold,
  updatePlant,
  analyzePlantImage,
  uploadPlantImage,
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

/** Per-plant defaults: green under 5 min, yellow 5 min–1 h, red after 1 h (or never watered). */
const DEFAULT_THIRSTY_AFTER_MINUTES = 5;
const DEFAULT_OVERDUE_AFTER_MINUTES = 60;
const MARKER_WATER_DELAY_MS = 3_000;
const MINUTES_IN_HOUR = 60;

function wateringDerivedStatus(
  lastWateredAt: string | null,
  thirstyAfterMinutes: number,
  overdueAfterMinutes: number,
): PlantStatus {
  if (!lastWateredAt) {
    return "overdue";
  }
  const t = new Date(lastWateredAt).getTime();
  if (Number.isNaN(t)) {
    return "overdue";
  }
  const elapsed = Date.now() - t;
  const thirstyAfterMs = Math.max(1, thirstyAfterMinutes) * 60 * 1000;
  const overdueAfterMs = Math.max(thirstyAfterMinutes, overdueAfterMinutes) * 60 * 1000;
  if (elapsed < thirstyAfterMs) {
    return "healthy";
  }
  if (elapsed < overdueAfterMs) {
    return "thirsty";
  }
  return "overdue";
}

function minutesToHours(minutes: number) {
  return minutes / MINUTES_IN_HOUR;
}

function hoursToMinutes(hours: number) {
  return Math.round(hours * MINUTES_IN_HOUR);
}

function formatHours(hours: number) {
  const rounded = Number(hours.toFixed(2));
  return Number.isInteger(rounded) ? String(rounded) : String(rounded);
}

function formatWateringAmount(value: Plant["watering_amount_recommendation"]) {
  if (value === "light") {
    return "light";
  }
  if (value === "moderate") {
    return "moderate";
  }
  if (value === "abundant") {
    return "abundant";
  }
  return "unknown";
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
  const [, setActiveMarkerId] = useState<string | null>(null);
  const [pendingWateringMarkerIds, setPendingWateringMarkerIds] = useState<string[]>([]);
  const [justWateredMarkerId, setJustWateredMarkerId] = useState<string | null>(null);
  const [selectedPlantIdForMarker, setSelectedPlantIdForMarker] = useState<string>("");
  const [isMarkerEditMode, setIsMarkerEditMode] = useState(false);
  const [isAddPlantOpen, setIsAddPlantOpen] = useState(false);
  const [isEditPlantOpen, setIsEditPlantOpen] = useState(false);
  const [editingPlantId, setEditingPlantId] = useState<string | null>(null);
  const [plantName, setPlantName] = useState("");
  const [addPlantNameError, setAddPlantNameError] = useState<string | null>(null);
  const [plantSpecies, setPlantSpecies] = useState("");
  const [, setPlantThirstyAfterMinutes] = useState(
    DEFAULT_THIRSTY_AFTER_MINUTES,
  );
  const [, setPlantOverdueAfterMinutes] = useState(
    DEFAULT_OVERDUE_AFTER_MINUTES,
  );
  const [plantThirstyAfterHours, setPlantThirstyAfterHours] = useState(
    minutesToHours(DEFAULT_THIRSTY_AFTER_MINUTES),
  );
  const [plantOverdueAfterHours, setPlantOverdueAfterHours] = useState(
    minutesToHours(DEFAULT_OVERDUE_AFTER_MINUTES),
  );
  const [newPlantPhotoFile, setNewPlantPhotoFile] = useState<File | null>(null);
  const [newPlantPhotoPreviewUrl, setNewPlantPhotoPreviewUrl] = useState<string | null>(null);
  const [isAnalyzingPlantPhoto, setIsAnalyzingPlantPhoto] = useState(false);
  const [newPlantPhotoAiError, setNewPlantPhotoAiError] = useState<string | null>(null);
  const [didApplyAiAutofill, setDidApplyAiAutofill] = useState(false);
  const [newPlantPhotoCompressionInfo, setNewPlantPhotoCompressionInfo] = useState<string | null>(
    null,
  );
  const [isCameraCaptureOpen, setIsCameraCaptureOpen] = useState(false);
  const [isStartingCamera, setIsStartingCamera] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [editPlantName, setEditPlantName] = useState("");
  const [editPlantSpecies, setEditPlantSpecies] = useState("");
  const [editPlantStatus, setEditPlantStatus] = useState<PlantStatus>("healthy");
  const [, setEditPlantThirstyAfterMinutes] = useState(
    DEFAULT_THIRSTY_AFTER_MINUTES,
  );
  const [, setEditPlantOverdueAfterMinutes] = useState(
    DEFAULT_OVERDUE_AFTER_MINUTES,
  );
  const [editPlantThirstyAfterHours, setEditPlantThirstyAfterHours] = useState(
    minutesToHours(DEFAULT_THIRSTY_AFTER_MINUTES),
  );
  const [editPlantOverdueAfterHours, setEditPlantOverdueAfterHours] = useState(
    minutesToHours(DEFAULT_OVERDUE_AFTER_MINUTES),
  );
  const [isReplacingPlantPhoto, setIsReplacingPlantPhoto] = useState(false);
  const [isRemovingPlantPhoto, setIsRemovingPlantPhoto] = useState(false);
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
  const addPlantCameraInputRef = useRef<HTMLInputElement | null>(null);
  const addPlantUploadInputRef = useRef<HTMLInputElement | null>(null);
  const editPlantPhotoInputRef = useRef<HTMLInputElement | null>(null);
  const cameraPreviewVideoRef = useRef<HTMLVideoElement | null>(null);
  const cameraStreamRef = useRef<MediaStream | null>(null);

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

  const stopCameraStream = useCallback(() => {
    const stream = cameraStreamRef.current;
    if (stream) {
      stream.getTracks().forEach((track) => track.stop());
      cameraStreamRef.current = null;
    }
    const video = cameraPreviewVideoRef.current;
    if (video) {
      video.srcObject = null;
    }
  }, []);

  useEffect(() => {
    return () => {
      stopCameraStream();
    };
  }, [stopCameraStream]);

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

    return date.toLocaleString();
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
    if (newPlantPhotoPreviewUrl) {
      URL.revokeObjectURL(newPlantPhotoPreviewUrl);
    }
    setNewPlantPhotoFile(null);
    setNewPlantPhotoPreviewUrl(null);
  }

  function clearNewPlantPhotoSelection() {
    if (newPlantPhotoPreviewUrl) {
      URL.revokeObjectURL(newPlantPhotoPreviewUrl);
    }
    setNewPlantPhotoFile(null);
    setNewPlantPhotoPreviewUrl(null);
    setIsAnalyzingPlantPhoto(false);
    setNewPlantPhotoAiError(null);
    setDidApplyAiAutofill(false);
    setNewPlantPhotoCompressionInfo(null);
    if (addPlantCameraInputRef.current) {
      addPlantCameraInputRef.current.value = "";
    }
    if (addPlantUploadInputRef.current) {
      addPlantUploadInputRef.current.value = "";
    }
  }

  function handleNewPlantPhotoSelected(file: File | null) {
    if (!file) {
      clearNewPlantPhotoSelection();
      return;
    }
    if (newPlantPhotoPreviewUrl) {
      URL.revokeObjectURL(newPlantPhotoPreviewUrl);
    }
    setNewPlantPhotoFile(file);
    setNewPlantPhotoPreviewUrl(URL.createObjectURL(file));
    setNewPlantPhotoAiError(null);
    setDidApplyAiAutofill(false);
    setNewPlantPhotoCompressionInfo(null);
  }

  function formatBytes(bytes: number) {
    if (!Number.isFinite(bytes) || bytes <= 0) {
      return "0 B";
    }
    const units = ["B", "KB", "MB", "GB"];
    let value = bytes;
    let unitIndex = 0;
    while (value >= 1024 && unitIndex < units.length - 1) {
      value /= 1024;
      unitIndex += 1;
    }
    const rounded = value >= 10 ? value.toFixed(1) : value.toFixed(2);
    return `${rounded} ${units[unitIndex]}`;
  }

  async function compressImageIfNeeded(
    file: File,
  ): Promise<{ file: File; originalBytes: number; resultBytes: number; compressed: boolean }> {
    if (!file.type.startsWith("image/")) {
      return {
        file,
        originalBytes: file.size,
        resultBytes: file.size,
        compressed: false,
      };
    }
    const objectUrl = URL.createObjectURL(file);
    try {
      const image = await new Promise<HTMLImageElement>((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error("Failed to decode image"));
        img.src = objectUrl;
      });
      const maxSide = 1600;
      const scale = Math.min(1, maxSide / Math.max(image.width, image.height));
      const targetWidth = Math.max(1, Math.round(image.width * scale));
      const targetHeight = Math.max(1, Math.round(image.height * scale));
      const canvas = document.createElement("canvas");
      canvas.width = targetWidth;
      canvas.height = targetHeight;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        return {
          file,
          originalBytes: file.size,
          resultBytes: file.size,
          compressed: false,
        };
      }
      ctx.drawImage(image, 0, 0, targetWidth, targetHeight);
      const compressedBlob = await new Promise<Blob | null>((resolve) => {
        canvas.toBlob(resolve, "image/jpeg", 0.82);
      });
      if (!compressedBlob || compressedBlob.size >= file.size) {
        return {
          file,
          originalBytes: file.size,
          resultBytes: file.size,
          compressed: false,
        };
      }
      const baseName = file.name.replace(/\.[^.]+$/, "");
      const compressedFile = new File([compressedBlob], `${baseName || "plant-photo"}.jpg`, {
        type: "image/jpeg",
      });
      return {
        file: compressedFile,
        originalBytes: file.size,
        resultBytes: compressedFile.size,
        compressed: true,
      };
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
  }

  async function handleAnalyzePhotoWithAi() {
    if (!newPlantPhotoFile) {
      setNewPlantPhotoAiError("Select or capture a photo first.");
      return;
    }
    setIsAnalyzingPlantPhoto(true);
    setNewPlantPhotoAiError(null);
    setDidApplyAiAutofill(false);
    try {
      const compressedResult = await compressImageIfNeeded(newPlantPhotoFile);
      if (compressedResult.compressed) {
        setNewPlantPhotoCompressionInfo(
          `Compressed: ${formatBytes(compressedResult.originalBytes)} -> ${formatBytes(compressedResult.resultBytes)}`,
        );
      } else {
        setNewPlantPhotoCompressionInfo(`No compression gain: ${formatBytes(compressedResult.resultBytes)}`);
      }
      const result = await analyzePlantImage(getCurrentInitData(), { file: compressedResult.file });
      if (result.ai_status === "ok" && result.ai_profile) {
        setPlantName(result.ai_profile.plant_name);
        setPlantThirstyAfterHours(minutesToHours(result.ai_profile.thirsty_after_minutes));
        setPlantOverdueAfterHours(minutesToHours(result.ai_profile.overdue_after_minutes));
        setDidApplyAiAutofill(true);
        setMessage("AI analysis complete. Fields auto-filled.");
        return;
      }
      if (result.ai_status === "disabled_missing_api_key") {
        setNewPlantPhotoAiError("AI is disabled on server (missing GEMINI_API_KEY).");
      } else if (result.ai_status === "request_failed") {
        const detail = result.ai_error?.trim();
        setNewPlantPhotoAiError(
          detail ? `AI request failed: ${detail}` : "AI request failed. Please try again.",
        );
      } else {
        const detail = result.ai_error?.trim();
        setNewPlantPhotoAiError(
          detail
            ? `AI response was invalid: ${detail}`
            : "AI response was invalid. Try again or fill manually.",
        );
      }
    } catch {
      setNewPlantPhotoAiError("AI analysis failed. Try again.");
    } finally {
      setIsAnalyzingPlantPhoto(false);
    }
  }

  function closeCameraCapture() {
    stopCameraStream();
    setIsCameraCaptureOpen(false);
    setIsStartingCamera(false);
    setCameraError(null);
  }

  async function handleOpenCameraCapture() {
    setCameraError(null);
    setIsStartingCamera(true);
    if (!navigator.mediaDevices?.getUserMedia) {
      setIsStartingCamera(false);
      setCameraError("Camera API is not available in this Telegram WebView.");
      setMessage("Camera API is unavailable here. Use Upload photo.");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" } },
        audio: false,
      });
      cameraStreamRef.current = stream;
      setIsCameraCaptureOpen(true);
      requestAnimationFrame(() => {
        const video = cameraPreviewVideoRef.current;
        if (!video) {
          return;
        }
        video.srcObject = stream;
        void video.play().catch(() => {
          // Autoplay may be blocked in some WebViews; user can still tap Capture if first frame loads.
        });
      });
    } catch {
      setCameraError("Could not start camera. Check Telegram camera permission.");
      setMessage("Could not start camera");
    } finally {
      setIsStartingCamera(false);
    }
  }

  async function handleCapturePhotoFromCamera() {
    const video = cameraPreviewVideoRef.current;
    if (!video || video.videoWidth <= 0 || video.videoHeight <= 0) {
      setCameraError("Camera is not ready yet. Please wait a moment.");
      return;
    }
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      setCameraError("Unable to capture frame.");
      return;
    }
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, "image/jpeg", 0.92);
    });
    if (!blob) {
      setCameraError("Failed to create captured image.");
      return;
    }
    const capturedFile = new File([blob], `plant-${Date.now()}.jpg`, { type: "image/jpeg" });
    handleNewPlantPhotoSelected(capturedFile);
    closeCameraCapture();
    setMessage("Photo captured");
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
      const errorText = "Cannot save plant: name is required";
      setAddPlantNameError(errorText);
      setMessage(errorText);
      return;
    }
    setAddPlantNameError(null);
    const nextThirstyAfterMinutes = hoursToMinutes(plantThirstyAfterHours);
    const nextOverdueAfterMinutes = hoursToMinutes(plantOverdueAfterHours);
    if (
      !Number.isFinite(plantThirstyAfterHours) ||
      !Number.isFinite(plantOverdueAfterHours) ||
      plantThirstyAfterHours <= 0 ||
      plantOverdueAfterHours <= 0 ||
      nextThirstyAfterMinutes <= 0 ||
      nextOverdueAfterMinutes <= 0 ||
      nextOverdueAfterMinutes < nextThirstyAfterMinutes
    ) {
      setMessage("Cannot save plant: invalid watering thresholds");
      return;
    }
    const photoToUpload = newPlantPhotoFile;
    const createdPlant = await createPlant(getCurrentInitData(), {
      roomId: selectedRoom.id,
      name: newPlantName,
      species: plantSpecies.trim() || null,
      status: "healthy",
      thirstyAfterMinutes: nextThirstyAfterMinutes,
      overdueAfterMinutes: nextOverdueAfterMinutes,
    });

    if (createdPlant?.id && photoToUpload) {
      const compressedResult = await compressImageIfNeeded(photoToUpload);
      if (compressedResult.compressed) {
        setNewPlantPhotoCompressionInfo(
          `Compressed: ${formatBytes(compressedResult.originalBytes)} -> ${formatBytes(compressedResult.resultBytes)}`,
        );
      } else {
        setNewPlantPhotoCompressionInfo(`No compression gain: ${formatBytes(compressedResult.resultBytes)}`);
      }
      await uploadPlantImage(getCurrentInitData(), {
        plantId: createdPlant.id,
        file: compressedResult.file,
        aiMode: "manual",
      });
    }

    setPlantName("");
    setPlantSpecies("");
    setPlantThirstyAfterMinutes(DEFAULT_THIRSTY_AFTER_MINUTES);
    setPlantOverdueAfterMinutes(DEFAULT_OVERDUE_AFTER_MINUTES);
    setPlantThirstyAfterHours(minutesToHours(DEFAULT_THIRSTY_AFTER_MINUTES));
    setPlantOverdueAfterHours(minutesToHours(DEFAULT_OVERDUE_AFTER_MINUTES));
    clearNewPlantPhotoSelection();
    setIsAddPlantOpen(false);
    await fetchRoomDetails(selectedRoom.id);
    const aiMessage = didApplyAiAutofill ? " AI profile applied." : "";
    if (createdPlant?.id) {
      setSelectedPlantIdForMarker(createdPlant.id);
      setIsMarkerEditMode(true);
      setMessage(`Plant added. Tap image to place marker.${aiMessage}`);
    } else {
      setMessage(`Plant added.${aiMessage}`);
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
    setEditPlantThirstyAfterMinutes(plant.thirsty_after_minutes ?? DEFAULT_THIRSTY_AFTER_MINUTES);
    setEditPlantOverdueAfterMinutes(plant.overdue_after_minutes ?? DEFAULT_OVERDUE_AFTER_MINUTES);
    setEditPlantThirstyAfterHours(
      minutesToHours(plant.thirsty_after_minutes ?? DEFAULT_THIRSTY_AFTER_MINUTES),
    );
    setEditPlantOverdueAfterHours(
      minutesToHours(plant.overdue_after_minutes ?? DEFAULT_OVERDUE_AFTER_MINUTES),
    );
    setIsEditPlantOpen(true);
  }

  async function handleSavePlantEdits() {
    if (!selectedRoom || !editingPlantId) {
      return;
    }

    const nextName = editPlantName.trim();
    if (!nextName) {
      setMessage("Cannot save plant: name is required");
      return;
    }
    const nextEditThirstyAfterMinutes = hoursToMinutes(editPlantThirstyAfterHours);
    const nextEditOverdueAfterMinutes = hoursToMinutes(editPlantOverdueAfterHours);
    if (
      !Number.isFinite(editPlantThirstyAfterHours) ||
      !Number.isFinite(editPlantOverdueAfterHours) ||
      editPlantThirstyAfterHours <= 0 ||
      editPlantOverdueAfterHours <= 0 ||
      nextEditThirstyAfterMinutes <= 0 ||
      nextEditOverdueAfterMinutes <= 0 ||
      nextEditOverdueAfterMinutes < nextEditThirstyAfterMinutes
    ) {
      setMessage("Cannot save plant: invalid watering thresholds");
      return;
    }

    await updatePlant(getCurrentInitData(), {
      plantId: editingPlantId,
      name: nextName,
      species: editPlantSpecies.trim() || null,
      status: editPlantStatus,
      thirstyAfterMinutes: nextEditThirstyAfterMinutes,
      overdueAfterMinutes: nextEditOverdueAfterMinutes,
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

  async function handleReplacePlantPhoto(file: File | null) {
    if (!selectedRoom || !editingPlantId || !file) {
      return;
    }
    setIsReplacingPlantPhoto(true);
    try {
      const compressedResult = await compressImageIfNeeded(file);
      const uploadResult = await uploadPlantImage(getCurrentInitData(), {
        plantId: editingPlantId,
        file: compressedResult.file,
      });
      if (editPlantPhotoInputRef.current) {
        editPlantPhotoInputRef.current.value = "";
      }
      await fetchRoomDetails(selectedRoom.id);
      if (uploadResult.ai_status === "ok") {
        setMessage("Plant photo updated. AI profile applied.");
      } else if (uploadResult.ai_status === "disabled_missing_api_key") {
        setMessage("Plant photo updated. AI disabled on server (missing GEMINI_API_KEY).");
      } else if (uploadResult.ai_status === "request_failed") {
        setMessage("Plant photo updated. AI request failed on server.");
      } else if (uploadResult.ai_status === "invalid_response") {
        setMessage("Plant photo updated. AI returned invalid response.");
      } else if (uploadResult.ai_status === "skipped_manual") {
        setMessage("Plant photo updated");
      } else {
        setMessage("Plant photo updated");
      }
    } finally {
      setIsReplacingPlantPhoto(false);
    }
  }

  async function handleRemovePlantPhoto() {
    if (!selectedRoom || !editingPlantId) {
      return;
    }
    setIsRemovingPlantPhoto(true);
    try {
      await removePlantPhoto(getCurrentInitData(), editingPlantId);
      await fetchRoomDetails(selectedRoom.id);
      setMessage("Plant photo removed");
    } finally {
      setIsRemovingPlantPhoto(false);
    }
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

  useEffect(() => {
    return () => {
      if (newPlantPhotoPreviewUrl) {
        URL.revokeObjectURL(newPlantPhotoPreviewUrl);
      }
    };
  }, [newPlantPhotoPreviewUrl]);

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
                onClick={() => {
                  clearNewPlantPhotoSelection();
                  setAddPlantNameError(null);
                  setPlantThirstyAfterMinutes(DEFAULT_THIRSTY_AFTER_MINUTES);
                  setPlantOverdueAfterMinutes(DEFAULT_OVERDUE_AFTER_MINUTES);
                  setPlantThirstyAfterHours(minutesToHours(DEFAULT_THIRSTY_AFTER_MINUTES));
                  setPlantOverdueAfterHours(minutesToHours(DEFAULT_OVERDUE_AFTER_MINUTES));
                  setIsAddPlantOpen(true);
                }}
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
                const isPendingWatering = pendingWateringMarkerIds.includes(marker.id);
                const isJustWatered = justWateredMarkerId === marker.id;
                const secondsLeft = getPendingWateringSecondsLeft(marker.id);
                const status = wateringDerivedStatus(
                  markerPlant?.last_watered_at ?? null,
                  markerPlant?.thirsty_after_minutes ?? DEFAULT_THIRSTY_AFTER_MINUTES,
                  markerPlant?.overdue_after_minutes ?? DEFAULT_OVERDUE_AFTER_MINUTES,
                );
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
                        <div className="flex min-w-0 items-start gap-3">
                          {plant.signed_photo_url ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img
                              src={plant.signed_photo_url}
                              alt={plant.name}
                              className="h-14 w-14 shrink-0 rounded-lg border border-[#e8ddd6] object-cover"
                            />
                          ) : (
                            <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-lg border border-dashed border-[#d5ccc6] bg-[#fff8f5] text-[10px] font-semibold uppercase tracking-wide text-[#9b8a80]">
                              no photo
                            </div>
                          )}
                          <div className="min-w-0">
                          <p className="font-semibold">
                            {plant.name}
                            {plant.ai_inferred_at ? (
                              <span className="ml-2 rounded-full bg-[#e6f5ef] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[#006c49]">
                                AI detected
                              </span>
                            ) : null}
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
                            {wateringDerivedStatus(
                              plant.last_watered_at,
                              plant.thirsty_after_minutes ?? DEFAULT_THIRSTY_AFTER_MINUTES,
                              plant.overdue_after_minutes ?? DEFAULT_OVERDUE_AFTER_MINUTES,
                            )}
                          </p>
                          <p className="text-[10px] text-[#6c7a71]">
                            Last watered: {formatLastWatered(plant.last_watered_at)}
                          </p>
                          <p className="text-[10px] text-[#6c7a71]">
                            Thresholds: thirsty after{" "}
                            {formatHours(
                              minutesToHours(
                                plant.thirsty_after_minutes ?? DEFAULT_THIRSTY_AFTER_MINUTES,
                              ),
                            )}
                            h, overdue after{" "}
                            {formatHours(
                              minutesToHours(
                                plant.overdue_after_minutes ?? DEFAULT_OVERDUE_AFTER_MINUTES,
                              ),
                            )}
                            h
                          </p>
                          <p className="text-[10px] text-[#6c7a71]">
                            Water amount: {formatWateringAmount(plant.watering_amount_recommendation)}
                          </p>
                          {plant.watering_summary ? (
                            <p className="mt-1 text-[10px] leading-relaxed text-[#6c7a71]">
                              AI advice: {plant.watering_summary}
                            </p>
                          ) : null}
                          </div>
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
          <div className="max-h-[85vh] w-full max-w-md overflow-y-auto rounded-[24px] bg-white p-4 shadow-xl">
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
          <div className="relative max-h-[85vh] w-full max-w-md overflow-y-auto rounded-[24px] bg-white p-4 shadow-xl">
            <span className="absolute right-4 top-4 rounded-full bg-[#e6f5ef] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[#006c49]">
              healthy
            </span>
            <h3 className="text-base font-semibold text-[#1f1b17]">Add Plant</h3>
            <p className="mt-1 text-sm text-[#6c7a71]">{selectedRoom.name}</p>
            <input
              value={plantName}
              onChange={(event) => {
                setPlantName(event.target.value);
                if (addPlantNameError) {
                  setAddPlantNameError(null);
                }
              }}
              placeholder="Plant name"
              className={`mt-4 w-full rounded-xl bg-white px-3 py-2 text-sm outline-none ${
                addPlantNameError
                  ? "border border-[#ba1a1a] focus:border-[#ba1a1a]"
                  : "border border-[#bbcabf] focus:border-[#006c49]"
              }`}
              autoFocus
            />
            {addPlantNameError ? (
              <p className="mt-1 text-xs font-medium text-[#ba1a1a]">{addPlantNameError}</p>
            ) : null}
            <div className="mt-2 grid grid-cols-2 gap-2">
              <label className="text-xs text-[#6c7a71]">
                Thirsty after (hours)
                <input
                  type="number"
                  min={0.1}
                  step={0.1}
                  value={plantThirstyAfterHours}
                  onChange={(event) => {
                    const next = Number(event.target.value);
                    setPlantThirstyAfterHours(Number.isFinite(next) ? next : 0);
                  }}
                  className="mt-1 w-full rounded-xl border border-[#bbcabf] bg-white px-3 py-2 text-sm outline-none focus:border-[#006c49]"
                />
              </label>
              <label className="text-xs text-[#6c7a71]">
                Overdue after (hours)
                <input
                  type="number"
                  min={0.1}
                  step={0.1}
                  value={plantOverdueAfterHours}
                  onChange={(event) => {
                    const next = Number(event.target.value);
                    setPlantOverdueAfterHours(Number.isFinite(next) ? next : 0);
                  }}
                  className="mt-1 w-full rounded-xl border border-[#bbcabf] bg-white px-3 py-2 text-sm outline-none focus:border-[#006c49]"
                />
              </label>
            </div>
            <div className="mt-3 rounded-xl border border-[#e7ddd6] bg-[#fffaf7] p-3">
              <p className="text-xs font-semibold text-[#3c4a42]">Plant photo</p>
              <p className="mt-0.5 text-[11px] text-[#6c7a71]">
                Take a new photo or pick one from gallery.
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => {
                    void runSafely(handleOpenCameraCapture);
                  }}
                  disabled={isStartingCamera}
                  className="inline-flex items-center gap-1 rounded-lg border border-[#bbcabf] bg-white px-3 py-1.5 text-xs font-semibold text-[#3c4a42] disabled:opacity-60"
                >
                  <Camera className="h-4 w-4" />
                  {isStartingCamera ? "Opening camera..." : "Take photo"}
                </button>
                <button
                  type="button"
                  onClick={() => addPlantUploadInputRef.current?.click()}
                  className="inline-flex items-center gap-1 rounded-lg border border-[#bbcabf] bg-white px-3 py-1.5 text-xs font-semibold text-[#3c4a42]"
                >
                  <ImagePlus className="h-4 w-4" />
                  Upload photo
                </button>
                {newPlantPhotoFile ? (
                  <button
                    type="button"
                    onClick={clearNewPlantPhotoSelection}
                    className="inline-flex items-center rounded-lg border border-[#ba1a1a]/30 px-3 py-1.5 text-xs font-semibold text-[#93000a]"
                  >
                    Remove
                  </button>
                ) : null}
              </div>
              <input
                id="add-plant-camera-input"
                ref={addPlantCameraInputRef}
                type="file"
                accept="image/*;capture=camera"
                capture="environment"
                onChange={(event) => handleNewPlantPhotoSelected(event.target.files?.[0] ?? null)}
                className="sr-only"
              />
              <input
                ref={addPlantUploadInputRef}
                type="file"
                accept="image/*"
                onChange={(event) => handleNewPlantPhotoSelected(event.target.files?.[0] ?? null)}
                className="hidden"
              />
              {newPlantPhotoPreviewUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={newPlantPhotoPreviewUrl}
                  alt="New plant preview"
                  className="mt-3 h-28 w-full rounded-lg border border-[#e8ddd6] object-cover"
                />
              ) : null}
              {newPlantPhotoFile ? (
                <div className="mt-3 rounded-lg border border-[#e8ddd6] bg-white p-2">
                  <p className="text-[11px] font-semibold text-[#3c4a42]">After upload</p>
                  <div className="mt-2">
                    <button
                      type="button"
                      onClick={() => {
                        void runSafely(handleAnalyzePhotoWithAi);
                      }}
                      disabled={isAnalyzingPlantPhoto}
                      className="w-full rounded-lg border border-[#006c49] bg-[#e6f5ef] px-3 py-2 text-xs font-semibold text-[#006c49] disabled:opacity-60"
                    >
                      {isAnalyzingPlantPhoto
                        ? "Analyzing with AI..."
                        : didApplyAiAutofill
                          ? "Analyze again"
                          : "Analyze with AI"}
                    </button>
                    {newPlantPhotoAiError ? (
                      <p className="mt-2 text-[11px] text-[#ba1a1a]">
                        {newPlantPhotoAiError} You can retry or continue manually.
                      </p>
                    ) : null}
                    {didApplyAiAutofill ? (
                      <p className="mt-2 text-[11px] text-[#006c49]">
                        AI filled fields automatically.
                      </p>
                    ) : null}
                  </div>
                  {newPlantPhotoCompressionInfo ? (
                    <p className="mt-2 text-[11px] text-[#6c7a71]">{newPlantPhotoCompressionInfo}</p>
                  ) : null}
                  <p className="mt-2 text-[11px] leading-relaxed text-[#6c7a71]">
                    AI can auto-fill plant name, watering thresholds, recommended water amount, and
                    short watering advice.
                  </p>
                </div>
              ) : null}
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  closeCameraCapture();
                  clearNewPlantPhotoSelection();
                  setAddPlantNameError(null);
                  setPlantThirstyAfterMinutes(DEFAULT_THIRSTY_AFTER_MINUTES);
                  setPlantOverdueAfterMinutes(DEFAULT_OVERDUE_AFTER_MINUTES);
                  setPlantThirstyAfterHours(minutesToHours(DEFAULT_THIRSTY_AFTER_MINUTES));
                  setPlantOverdueAfterHours(minutesToHours(DEFAULT_OVERDUE_AFTER_MINUTES));
                  setIsAddPlantOpen(false);
                }}
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

      {selectedRoom && isAddPlantOpen && isCameraCaptureOpen ? (
        <div className="fixed inset-0 z-[60] flex items-end justify-center overflow-y-auto bg-black/50 p-4 pb-28 pt-16 sm:items-center sm:pb-4 sm:pt-4">
          <div className="w-full max-w-md rounded-[24px] bg-white p-4 shadow-xl">
            <h3 className="text-base font-semibold text-[#1f1b17]">Take photo</h3>
            <p className="mt-1 text-sm text-[#6c7a71]">Point camera at the plant and tap Capture.</p>
            <video
              ref={cameraPreviewVideoRef}
              autoPlay
              playsInline
              muted
              className="mt-3 h-64 w-full rounded-xl border border-[#e8ddd6] bg-black object-cover"
            />
            {cameraError ? <p className="mt-2 text-xs text-[#ba1a1a]">{cameraError}</p> : null}
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={closeCameraCapture}
                className="rounded-xl border border-[#bbcabf] px-4 py-2 text-sm font-medium text-[#3c4a42]"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  void runSafely(handleCapturePhotoFromCamera);
                }}
                className="rounded-xl border-b-2 border-[#005236] bg-[#006c49] px-4 py-2 text-sm font-semibold text-white"
              >
                Capture
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
            {editingPlantId ? (
              (() => {
                const editingPlant = plants.find((plant) => plant.id === editingPlantId);
                if (!editingPlant?.signed_photo_url) {
                  return null;
                }
                return (
                  <div className="mt-3">
                    {editingPlant.ai_inferred_at ? (
                      <p className="mb-2 inline-flex rounded-full bg-[#e6f5ef] px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide text-[#006c49]">
                        AI detected
                      </p>
                    ) : null}
                    <p className="mb-2 text-xs text-[#6c7a71]">
                      Last watered: {formatLastWatered(editingPlant.last_watered_at)}
                    </p>
                    <p className="mb-2 text-xs text-[#6c7a71]">
                      Water amount: {formatWateringAmount(editingPlant.watering_amount_recommendation)}
                    </p>
                    {editingPlant.watering_summary ? (
                      <p className="mb-2 text-xs leading-relaxed text-[#6c7a71]">
                        AI advice: {editingPlant.watering_summary}
                      </p>
                    ) : null}
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={editingPlant.signed_photo_url}
                      alt={editingPlant.name}
                      className="h-32 w-full rounded-xl border border-[#e8ddd6] object-cover"
                    />
                  </div>
                );
              })()
            ) : null}
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
            <div className="mt-2 grid grid-cols-2 gap-2">
              <label className="text-xs text-[#6c7a71]">
                Thirsty after (hours)
                <input
                  type="number"
                  min={0.1}
                  step={0.1}
                  value={editPlantThirstyAfterHours}
                  onChange={(event) => {
                    const next = Number(event.target.value);
                    setEditPlantThirstyAfterHours(Number.isFinite(next) ? next : 0);
                  }}
                  className="mt-1 w-full rounded-xl border border-[#bbcabf] bg-white px-3 py-2 text-sm outline-none focus:border-[#006c49]"
                />
              </label>
              <label className="text-xs text-[#6c7a71]">
                Overdue after (hours)
                <input
                  type="number"
                  min={0.1}
                  step={0.1}
                  value={editPlantOverdueAfterHours}
                  onChange={(event) => {
                    const next = Number(event.target.value);
                    setEditPlantOverdueAfterHours(Number.isFinite(next) ? next : 0);
                  }}
                  className="mt-1 w-full rounded-xl border border-[#bbcabf] bg-white px-3 py-2 text-sm outline-none focus:border-[#006c49]"
                />
              </label>
            </div>
            <div className="mt-3 rounded-xl border border-[#e7ddd6] bg-[#fffaf7] p-3">
              <p className="text-xs font-semibold text-[#3c4a42]">Plant photo</p>
              <div className="mt-2 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => editPlantPhotoInputRef.current?.click()}
                  disabled={isReplacingPlantPhoto || isRemovingPlantPhoto}
                  className="inline-flex items-center gap-1 rounded-lg border border-[#bbcabf] bg-white px-3 py-1.5 text-xs font-semibold text-[#3c4a42]"
                >
                  <ImagePlus className="h-4 w-4" />
                  {isReplacingPlantPhoto ? "Uploading..." : "Replace photo"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    void runSafely(handleRemovePlantPhoto);
                  }}
                  disabled={isReplacingPlantPhoto || isRemovingPlantPhoto}
                  className="inline-flex items-center rounded-lg border border-[#ba1a1a]/30 px-3 py-1.5 text-xs font-semibold text-[#93000a]"
                >
                  {isRemovingPlantPhoto ? "Removing..." : "Remove photo"}
                </button>
              </div>
              <input
                ref={editPlantPhotoInputRef}
                type="file"
                accept="image/*"
                onChange={(event) => {
                  void runSafely(() => handleReplacePlantPhoto(event.target.files?.[0] ?? null));
                }}
                className="hidden"
              />
            </div>
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
