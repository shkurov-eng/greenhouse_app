"use client";

import Link from "next/link";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  Camera,
  ChevronsUpDown,
  ImagePlus,
  Pencil,
  Plus,
  RefreshCw,
  Sparkles,
  Settings,
  Sprout,
  Trash2,
} from "lucide-react";

import { MobileShell } from "@/components/MobileShell";
import {
  bootstrapUser,
  createHousehold,
  createRoomPlantsFromDetections,
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
  stylizeRoomImage,
  updatePlant,
  analyzePlantImage,
  analyzeRoomPlantsPreview,
  reanalyzePlantPhoto,
  uploadPlantImage,
  uploadRoomImage,
  upsertMarker,
  waterPlant,
  type Household,
  type HouseholdSummary,
  type Plant,
  type PlantMarker,
  type PlantStatus,
  type RoomStylizationPreset,
  type RoomPlantDetectionDraft,
  type Room,
} from "@/lib/api";

/** Per-plant defaults in hours: green under 0.1 h, yellow 0.1 h–1 h, red after 1 h. */
const DEFAULT_THIRSTY_AFTER_HOURS = 0.1;
const DEFAULT_OVERDUE_AFTER_HOURS = 1;
const MARKER_WATER_DELAY_MS = 3_000;
const MAX_ROOM_UPLOAD_BYTES = 4 * 1024 * 1024;
const MAX_PLANT_UPLOAD_BYTES = 4 * 1024 * 1024;
const ROOM_VISUAL_MODE_STORAGE_KEY = "greenhouseRoomVisualMode";

function wateringDerivedStatus(
  lastWateredAt: string | null,
  thirstyAfterHours: number,
  overdueAfterHours: number,
): PlantStatus {
  if (!lastWateredAt) {
    return "overdue";
  }
  const t = new Date(lastWateredAt).getTime();
  if (Number.isNaN(t)) {
    return "overdue";
  }
  const elapsed = Date.now() - t;
  const thirstyAfterMs = Math.max(0.1, thirstyAfterHours) * 60 * 60 * 1000;
  const overdueAfterMs = Math.max(thirstyAfterHours, overdueAfterHours) * 60 * 60 * 1000;
  if (elapsed < thirstyAfterMs) {
    return "healthy";
  }
  if (elapsed < overdueAfterMs) {
    return "thirsty";
  }
  return "overdue";
}

function parseHoursInput(rawValue: string) {
  const normalized = rawValue.trim().replace(",", ".");
  const next = Number(normalized);
  return Number.isFinite(next) ? next : 0;
}

function formatHours(hours: number) {
  const rounded = Number(hours.toFixed(2));
  return Number.isInteger(rounded) ? String(rounded) : String(rounded);
}

function formatWateringAmount(value: Plant["watering_amount_recommendation"]) {
  if (value === "light") {
    return "low (light)";
  }
  if (value === "moderate") {
    return "medium (moderate)";
  }
  if (value === "abundant") {
    return "high (abundant)";
  }
  return "not set";
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

type MarkerPlacementFeedback = {
  x: number;
  y: number;
};

type OptimisticMarkerPlacement = {
  plantId: string;
  x: number;
  y: number;
};

type RoomVisualMode = "photo" | "cartoon";

function readRoomVisualModeFromStorage(): RoomVisualMode {
  if (typeof window === "undefined") {
    return "photo";
  }
  return window.localStorage.getItem(ROOM_VISUAL_MODE_STORAGE_KEY) === "cartoon" ? "cartoon" : "photo";
}

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

  const [message, setMessage] = useState("");
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
  const [roomVisualMode, setRoomVisualMode] = useState<RoomVisualMode>("photo");
  const [isStylizingRoom, setIsStylizingRoom] = useState(false);
  const [roomStylizeNonce, setRoomStylizeNonce] = useState(0);
  const [roomStylizationPreset, setRoomStylizationPreset] = useState<RoomStylizationPreset>("strong");
  const [plants, setPlants] = useState<Plant[]>([]);
  const [markers, setMarkers] = useState<PlantMarker[]>([]);
  /** Internal id while tap-to-water countdown runs (must not control the long-press popover). */
  const [, setWateringFocusMarkerId] = useState<string | null>(null);
  const [markerQuickMenuMarkerId, setMarkerQuickMenuMarkerId] = useState<string | null>(null);
  const [pendingWateringMarkerIds, setPendingWateringMarkerIds] = useState<string[]>([]);
  const [justWateredMarkerId, setJustWateredMarkerId] = useState<string | null>(null);
  const [selectedPlantIdForMarker, setSelectedPlantIdForMarker] = useState<string>("");
  const [isMarkerEditMode, setIsMarkerEditMode] = useState(false);
  const [isAddPlantOpen, setIsAddPlantOpen] = useState(false);
  const [isCreatingPlant, setIsCreatingPlant] = useState(false);
  const [isEditPlantOpen, setIsEditPlantOpen] = useState(false);
  const [editingPlantId, setEditingPlantId] = useState<string | null>(null);
  const [plantName, setPlantName] = useState("");
  const [addPlantNameError, setAddPlantNameError] = useState<string | null>(null);
  const [plantSpecies, setPlantSpecies] = useState("");
  const [plantThirstyAfterHours, setPlantThirstyAfterHours] = useState(DEFAULT_THIRSTY_AFTER_HOURS);
  const [plantOverdueAfterHours, setPlantOverdueAfterHours] = useState(DEFAULT_OVERDUE_AFTER_HOURS);
  const [newPlantPhotoFile, setNewPlantPhotoFile] = useState<File | null>(null);
  const [newPlantPhotoPreviewUrl, setNewPlantPhotoPreviewUrl] = useState<string | null>(null);
  const [isAnalyzingPlantPhoto, setIsAnalyzingPlantPhoto] = useState(false);
  const [newPlantPhotoAiError, setNewPlantPhotoAiError] = useState<string | null>(null);
  const [didApplyAiAutofill, setDidApplyAiAutofill] = useState(false);
  const [latestAiProfile, setLatestAiProfile] = useState<{
    plant_name: string;
    thirsty_after_hours: number;
    overdue_after_hours: number;
    watering_amount_recommendation: "light" | "moderate" | "abundant";
    watering_summary: string;
  } | null>(null);
  const [lowConfidenceAiProfile, setLowConfidenceAiProfile] = useState<{
    plant_name: string;
    thirsty_after_hours: number;
    overdue_after_hours: number;
  } | null>(null);
  const [newPlantPhotoCompressionInfo, setNewPlantPhotoCompressionInfo] = useState<string | null>(
    null,
  );
  const [isCameraCaptureOpen, setIsCameraCaptureOpen] = useState(false);
  const [cameraCaptureTarget, setCameraCaptureTarget] = useState<"plant" | "room" | "editPlant" | null>(null);
  const [isStartingCamera, setIsStartingCamera] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [editPlantName, setEditPlantName] = useState("");
  const [isEditPlantNameFieldOpen, setIsEditPlantNameFieldOpen] = useState(false);
  const [editPlantSpecies, setEditPlantSpecies] = useState("");
  const [editPlantStatus, setEditPlantStatus] = useState<PlantStatus>("healthy");
  const [editPlantAiSummary, setEditPlantAiSummary] = useState<string | null>(null);
  const [editPlantAiWaterAmount, setEditPlantAiWaterAmount] = useState<
    Plant["watering_amount_recommendation"] | null
  >(null);
  const [editPlantThirstyAfterHours, setEditPlantThirstyAfterHours] = useState(
    DEFAULT_THIRSTY_AFTER_HOURS,
  );
  const [editPlantOverdueAfterHours, setEditPlantOverdueAfterHours] = useState(DEFAULT_OVERDUE_AFTER_HOURS);
  const [isReplacingPlantPhoto, setIsReplacingPlantPhoto] = useState(false);
  const [isRemovingPlantPhoto, setIsRemovingPlantPhoto] = useState(false);
  const [isAnalyzingEditPlantPhoto, setIsAnalyzingEditPlantPhoto] = useState(false);
  const [roomFiles, setRoomFiles] = useState<Record<string, File | null>>({});
  const [roomUploadStatus, setRoomUploadStatus] = useState<Record<string, string>>({});
  const [isDetectingRoomPlants, setIsDetectingRoomPlants] = useState(false);
  const [isRoomDetectionPreviewOpen, setIsRoomDetectionPreviewOpen] = useState(false);
  const [roomDetectionPreview, setRoomDetectionPreview] = useState<RoomPlantDetectionDraft[]>([]);
  const [selectedRoomDetectionIndexes, setSelectedRoomDetectionIndexes] = useState<number[]>([]);
  const [isApplyingRoomDetections, setIsApplyingRoomDetections] = useState(false);
  const [roomPhotoPickerRoomId, setRoomPhotoPickerRoomId] = useState<string | null>(null);
  const [pendingDeleteTarget, setPendingDeleteTarget] = useState<PendingDeleteTarget | null>(null);
  const [isConfirmDeletePending, setIsConfirmDeletePending] = useState(false);
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
  const [markerPlacementFeedback, setMarkerPlacementFeedback] = useState<MarkerPlacementFeedback | null>(
    null,
  );
  const [optimisticMarkerPlacement, setOptimisticMarkerPlacement] =
    useState<OptimisticMarkerPlacement | null>(null);
  const addPlantCameraInputRef = useRef<HTMLInputElement | null>(null);
  const addPlantUploadInputRef = useRef<HTMLInputElement | null>(null);
  const roomPhotoUploadInputRef = useRef<HTMLInputElement | null>(null);
  const editPlantPhotoInputRef = useRef<HTMLInputElement | null>(null);
  const cameraPreviewVideoRef = useRef<HTMLVideoElement | null>(null);
  const cameraStreamRef = useRef<MediaStream | null>(null);
  const cameraCaptureCounterRef = useRef(0);
  const markerPlacementFeedbackTimerRef = useRef<number | null>(null);

  useLayoutEffect(() => {
    // After SSR/hydration, apply the user's last Photo/Cartoon choice from localStorage.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional one-shot client sync
    setRoomVisualMode(readRoomVisualModeFromStorage());
  }, []);

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

  function getPlantGlowClasses(status: PlantStatus) {
    if (status === "healthy") {
      return {
        glow: "border-[#10b981]/75 bg-white/10 shadow-[0_0_12px_rgba(16,185,129,0.28)]",
        pulse: "border-[#10b981]/45 shadow-[0_0_10px_rgba(16,185,129,0.24)]",
        dot: "bg-[#10b981] text-white",
        shimmer: "[animation:pulse_4.2s_ease-in-out_infinite]",
        shimmerOpacity: "opacity-35 group-hover:opacity-55",
      };
    }
    if (status === "thirsty") {
      return {
        glow: "border-[#f59e0b]/80 bg-white/10 shadow-[0_0_16px_rgba(245,158,11,0.40)]",
        pulse: "border-[#f59e0b]/60 shadow-[0_0_14px_rgba(245,158,11,0.34)]",
        dot: "bg-[#f59e0b] text-white",
        shimmer: "[animation:pulse_2.8s_ease-in-out_infinite]",
        shimmerOpacity: "opacity-70 group-hover:opacity-95",
      };
    }
    return {
      glow: "border-[#ef4444]/80 bg-white/10 shadow-[0_0_18px_rgba(239,68,68,0.42)]",
      pulse: "border-[#ef4444]/60 shadow-[0_0_16px_rgba(239,68,68,0.36)]",
      dot: "bg-[#ef4444] text-white",
      shimmer: "[animation:pulse_1.9s_ease-in-out_infinite]",
      shimmerOpacity: "opacity-90 group-hover:opacity-100",
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
    return telegramInitDataRef.current;
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
    setWateringFocusMarkerId(null);
    setMarkerQuickMenuMarkerId(null);
    setSelectedPlantIdForMarker("");
    setIsMarkerEditMode(false);
    setIsAddPlantOpen(false);
    setIsRoomDetectionPreviewOpen(false);
    setIsEditPlantOpen(false);
    setRoomVisualMode(readRoomVisualModeFromStorage());
    setIsStylizingRoom(false);
    setRoomStylizeNonce(0);
    setEditingPlantId(null);
    if (newPlantPhotoPreviewUrl) {
      URL.revokeObjectURL(newPlantPhotoPreviewUrl);
    }
    setNewPlantPhotoFile(null);
    setNewPlantPhotoPreviewUrl(null);
    setRoomDetectionPreview([]);
    setSelectedRoomDetectionIndexes([]);
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
    setLatestAiProfile(null);
    setLowConfidenceAiProfile(null);
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
    setLatestAiProfile(null);
    setLowConfidenceAiProfile(null);
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
    options?: { maxSide?: number; targetMaxBytes?: number },
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
      const maxSide = options?.maxSide ?? 1600;
      const targetMaxBytes = options?.targetMaxBytes ?? null;
      const scale = Math.min(1, maxSide / Math.max(image.width, image.height));
      let targetWidth = Math.max(1, Math.round(image.width * scale));
      let targetHeight = Math.max(1, Math.round(image.height * scale));
      const attempts = targetMaxBytes ? 5 : 1;
      let bestBlob: Blob | null = null;
      let hitTarget = false;

      for (let attempt = 0; attempt < attempts; attempt += 1) {
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
        const qualities = targetMaxBytes ? [0.82, 0.74, 0.66, 0.58] : [0.82];
        for (const quality of qualities) {
          const candidateBlob = await new Promise<Blob | null>((resolve) => {
            canvas.toBlob(resolve, "image/jpeg", quality);
          });
          if (!candidateBlob) {
            continue;
          }
          if (!bestBlob || candidateBlob.size < bestBlob.size) {
            bestBlob = candidateBlob;
          }
          if (targetMaxBytes && candidateBlob.size <= targetMaxBytes) {
            hitTarget = true;
            break;
          }
        }
        if (!targetMaxBytes || hitTarget) {
          break;
        }
        if (targetWidth <= 640 || targetHeight <= 640) {
          break;
        }
        targetWidth = Math.max(1, Math.round(targetWidth * 0.8));
        targetHeight = Math.max(1, Math.round(targetHeight * 0.8));
      }

      if (!bestBlob || bestBlob.size >= file.size) {
        return {
          file,
          originalBytes: file.size,
          resultBytes: file.size,
          compressed: false,
        };
      }
      const baseName = file.name.replace(/\.[^.]+$/, "");
      const compressedFile = new File([bestBlob], `${baseName || "plant-photo"}.jpg`, {
        type: "image/jpeg",
      });
      return {
        file: compressedFile,
        originalBytes: file.size,
        resultBytes: compressedFile.size,
        compressed: true,
      };
    } catch {
      // Some desktop browsers cannot decode specific image formats (for example HEIC).
      // In this case we keep original file instead of breaking the whole add-plant flow.
      setNewPlantPhotoCompressionInfo(
        `Compression skipped (unsupported image decode). Uploading original: ${formatBytes(file.size)}`,
      );
      return {
        file,
        originalBytes: file.size,
        resultBytes: file.size,
        compressed: false,
      };
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
  }

  function buildTooLargePhotoMessage(
    photoLabel: "Photo" | "Plant photo" | "Room photo",
    bytes: number,
  ) {
    return `${photoLabel} is too large after compression (${formatBytes(bytes)}). Please choose a smaller image.`;
  }

  async function compressPhotoForUpload(
    file: File,
    options: {
      maxBytes: number;
      photoLabel: "Photo" | "Plant photo" | "Room photo";
    },
  ) {
    const compressedResult = await compressImageIfNeeded(file, {
      targetMaxBytes: options.maxBytes,
    });
    if (compressedResult.resultBytes > options.maxBytes) {
      throw new Error(buildTooLargePhotoMessage(options.photoLabel, compressedResult.resultBytes));
    }
    return compressedResult;
  }

  async function handleAnalyzePhotoWithAi() {
    if (!newPlantPhotoFile) {
      setNewPlantPhotoAiError("Select or capture a photo first.");
      return;
    }
    setIsAnalyzingPlantPhoto(true);
    setNewPlantPhotoAiError(null);
    setDidApplyAiAutofill(false);
    setLatestAiProfile(null);
    setLowConfidenceAiProfile(null);
    try {
      const compressedResult = await compressPhotoForUpload(newPlantPhotoFile, {
        maxBytes: MAX_PLANT_UPLOAD_BYTES,
        photoLabel: "Photo",
      });
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
        setPlantThirstyAfterHours(result.ai_profile.thirsty_after_hours);
        setPlantOverdueAfterHours(result.ai_profile.overdue_after_hours);
        setDidApplyAiAutofill(true);
        setLatestAiProfile(result.ai_profile);
        setLowConfidenceAiProfile(null);
        setMessage("AI analysis complete. Fields auto-filled.");
        return;
      }
      if (result.ai_status === "disabled_missing_api_key") {
        setNewPlantPhotoAiError("AI is disabled on server (missing GEMINI_API_KEY).");
      } else if (result.ai_status === "not_plant") {
        setNewPlantPhotoAiError("This photo does not look like a plant. Use another photo or fill manually.");
      } else if (result.ai_status === "low_confidence") {
        if (result.ai_profile) {
          setLatestAiProfile(result.ai_profile);
          setLowConfidenceAiProfile({
            plant_name: result.ai_profile.plant_name,
            thirsty_after_hours: result.ai_profile.thirsty_after_hours,
            overdue_after_hours: result.ai_profile.overdue_after_hours,
          });
        }
        const detail = result.ai_error?.trim();
        setNewPlantPhotoAiError(detail ? `AI is not confident enough: ${detail}` : "AI is not confident enough.");
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
    } catch (error) {
      const text =
        error instanceof Error && error.message.trim()
          ? error.message
          : "AI analysis failed. Try again.";
      setNewPlantPhotoAiError(text);
    } finally {
      setIsAnalyzingPlantPhoto(false);
    }
  }

  function handleApplyLowConfidenceAiSuggestion() {
    if (!lowConfidenceAiProfile) {
      return;
    }
    setPlantName(lowConfidenceAiProfile.plant_name);
    setPlantThirstyAfterHours(lowConfidenceAiProfile.thirsty_after_hours);
    setPlantOverdueAfterHours(lowConfidenceAiProfile.overdue_after_hours);
    setDidApplyAiAutofill(true);
    setLowConfidenceAiProfile(null);
    setNewPlantPhotoAiError(null);
    setMessage("Low-confidence AI suggestion applied.");
  }

  function closeCameraCapture() {
    stopCameraStream();
    setIsCameraCaptureOpen(false);
    setCameraCaptureTarget(null);
    setIsStartingCamera(false);
    setCameraError(null);
  }

  async function handleOpenCameraCapture(target: "plant" | "room" | "editPlant" = "plant") {
    setCameraError(null);
    setIsStartingCamera(true);
    setCameraCaptureTarget(target);
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
    const nextTarget = cameraCaptureTarget;
    cameraCaptureCounterRef.current += 1;
    const capturedFile = new File(
      [blob],
      `${nextTarget === "room" ? "room" : "plant"}-capture-${cameraCaptureCounterRef.current}.jpg`,
      { type: "image/jpeg" },
    );
    if (nextTarget === "room") {
      const targetRoomId = roomPhotoPickerRoomId;
      if (!targetRoomId) {
        setCameraError("Room photo picker is not open.");
        return;
      }
      handleRoomFileChange(targetRoomId, capturedFile);
      closeCameraCapture();
      setMessage("Photo captured. Uploading...");
      await uploadRoomImageFile(targetRoomId, capturedFile);
      closeRoomPhotoPicker();
      setMessage("Room photo uploaded");
      return;
    }
    if (nextTarget === "editPlant") {
      await handleReplacePlantPhoto(capturedFile);
    } else {
      handleNewPlantPhotoSelected(capturedFile);
    }
    closeCameraCapture();
    setMessage("Photo captured");
  }

  function getRoomImageUrl(room: Room) {
    if (roomVisualMode === "cartoon" && room.signed_stylized_background_url) {
      const base = room.signed_stylized_background_url;
      if (roomStylizeNonce > 0) {
        return base.includes("?") ? `${base}&cb=${roomStylizeNonce}` : `${base}?cb=${roomStylizeNonce}`;
      }
      return base;
    }
    return room.signed_background_url ?? room.background_url;
  }

  function hasStylizedRoomImage(room: Room) {
    return Boolean(room.stylized_background_path?.trim()) || Boolean(room.signed_stylized_background_url);
  }

  function getStoredRoomVisualMode(): RoomVisualMode {
    return readRoomVisualModeFromStorage();
  }

  function setPreferredRoomVisualMode(mode: RoomVisualMode) {
    setRoomVisualMode(mode);
    window.localStorage.setItem(ROOM_VISUAL_MODE_STORAGE_KEY, mode);
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
    setWateringFocusMarkerId((prev) => {
      if (!prev) {
        return prev;
      }
      return nextMarkers.some((marker) => marker.id === prev) ? prev : null;
    });
    setMarkerQuickMenuMarkerId((prev) => {
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

      telegramInitDataRef.current = telegramInitDataValue;

      await bootstrapUser(telegramInitDataValue, telegramUser?.username ?? null);

      if (isMounted) {
        await loadHouseholds();
        await fetchRoomsForHousehold();
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
    const isLegacyInviteException = code === "ZFXQSB";
    setMessage("");
    if (!code) {
      setMessage("Enter invite code");
      return;
    }
    if (!/^[A-Z2-9]{10}$/.test(code) && !isLegacyInviteException) {
      setMessage("Invite code must be 10 chars (A-Z, 2-9)");
      return;
    }

    const targetHome = await joinHousehold(getCurrentInitData(), code);
    if (targetHome.join_status === "pending_approval") {
      setIsJoinHomeOpen(false);
      setJoinCode("");
      if (targetHome.owner_notified === false) {
        setMessage(
          `Join request sent to ${targetHome.household_name}. Bot could not notify owner automatically - ask owner to start bot chat and open /settings.`,
        );
      } else {
        setMessage(`Join request sent to ${targetHome.household_name} owner`);
      }
      return;
    }

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
    try {
      await fetchRoomsForHousehold();
    } catch {
      // Fallback for race/transition cases when last home is deleted and auto-bootstrap just recreated a default home.
      await loadHouseholds();
      await fetchRoomsForHousehold();
    }
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

  async function handleCreatePlant() {
    if (isCreatingPlant) {
      return;
    }
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
    const nextThirstyAfterHours = Number(plantThirstyAfterHours.toFixed(2));
    const nextOverdueAfterHours = Number(plantOverdueAfterHours.toFixed(2));
    if (
      !Number.isFinite(plantThirstyAfterHours) ||
      !Number.isFinite(plantOverdueAfterHours) ||
      plantThirstyAfterHours <= 0 ||
      plantOverdueAfterHours <= 0 ||
      nextThirstyAfterHours <= 0 ||
      nextOverdueAfterHours <= 0 ||
      nextOverdueAfterHours < nextThirstyAfterHours
    ) {
      setMessage("Cannot save plant: invalid watering thresholds");
      return;
    }
    setIsCreatingPlant(true);
    setMessage("Adding plant...");
    try {
      const photoToUpload = newPlantPhotoFile;
      let photoUploadErrorText: string | null = null;
      const createdPlant = await createPlant(getCurrentInitData(), {
        roomId: selectedRoom.id,
        name: newPlantName,
        species: plantSpecies.trim() || null,
        status: "healthy",
        thirstyAfterHours: nextThirstyAfterHours,
        overdueAfterHours: nextOverdueAfterHours,
      });

      if (createdPlant?.id && photoToUpload) {
        try {
          const compressedResult = await compressPhotoForUpload(photoToUpload, {
            maxBytes: MAX_PLANT_UPLOAD_BYTES,
            photoLabel: "Plant photo",
          });
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
            aiMode: didApplyAiAutofill && latestAiProfile ? "auto" : "manual",
          });
        } catch (error) {
          photoUploadErrorText =
            error instanceof Error
              ? error.message
              : "Photo upload failed. Plant was added without photo.";
        }
      }

      setPlantName("");
      setPlantSpecies("");
      setPlantThirstyAfterHours(DEFAULT_THIRSTY_AFTER_HOURS);
      setPlantOverdueAfterHours(DEFAULT_OVERDUE_AFTER_HOURS);
      clearNewPlantPhotoSelection();
      setIsAddPlantOpen(false);
      await fetchRoomDetails(selectedRoom.id);
      const aiMessage = didApplyAiAutofill ? " AI profile applied." : "";
      if (createdPlant?.id) {
        setSelectedPlantIdForMarker(createdPlant.id);
        setIsMarkerEditMode(true);
        if (photoUploadErrorText) {
          setMessage(
            `Plant added. Photo upload failed: ${photoUploadErrorText}. Tap image to place marker.${aiMessage}`,
          );
        } else {
          setMessage(`Plant added. Tap image to place marker.${aiMessage}`);
        }
      } else {
        if (photoUploadErrorText) {
          setMessage(`Plant added without photo: ${photoUploadErrorText}${aiMessage}`);
        } else {
          setMessage(`Plant added.${aiMessage}`);
        }
      }
    } finally {
      setIsCreatingPlant(false);
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
    setMarkerQuickMenuMarkerId(null);
    setWateringFocusMarkerId(markerId);
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
        setWateringFocusMarkerId((prev) => (prev === markerId ? null : prev));
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
    setWateringFocusMarkerId((prev) => (prev === markerId ? null : prev));
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
      setMarkerQuickMenuMarkerId(markerId);
    }, 550);
  }

  function stopMarkerLongPress() {
    clearMarkerLongPressTimer();
  }

  function openEditPlantDialog(plant: Plant) {
    setMarkerQuickMenuMarkerId(null);
    setWateringFocusMarkerId(null);
    setEditingPlantId(plant.id);
    setEditPlantName(plant.name);
    setEditPlantSpecies(plant.species ?? "");
    setEditPlantStatus(plant.status);
    setEditPlantThirstyAfterHours(plant.thirsty_after_hours ?? DEFAULT_THIRSTY_AFTER_HOURS);
    setEditPlantOverdueAfterHours(plant.overdue_after_hours ?? DEFAULT_OVERDUE_AFTER_HOURS);
    setEditPlantAiSummary(plant.watering_summary ?? null);
    setEditPlantAiWaterAmount(plant.watering_amount_recommendation);
    setIsEditPlantNameFieldOpen(false);
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
    const nextEditThirstyAfterHours = Number(editPlantThirstyAfterHours.toFixed(2));
    const nextEditOverdueAfterHours = Number(editPlantOverdueAfterHours.toFixed(2));
    if (
      !Number.isFinite(editPlantThirstyAfterHours) ||
      !Number.isFinite(editPlantOverdueAfterHours) ||
      editPlantThirstyAfterHours <= 0 ||
      editPlantOverdueAfterHours <= 0 ||
      nextEditThirstyAfterHours <= 0 ||
      nextEditOverdueAfterHours <= 0 ||
      nextEditOverdueAfterHours < nextEditThirstyAfterHours
    ) {
      setMessage("Cannot save plant: invalid watering thresholds");
      return;
    }

    await updatePlant(getCurrentInitData(), {
      plantId: editingPlantId,
      name: nextName,
      species: editPlantSpecies.trim() || null,
      status: editPlantStatus,
      thirstyAfterHours: nextEditThirstyAfterHours,
      overdueAfterHours: nextEditOverdueAfterHours,
    });

    setIsEditPlantOpen(false);
    setIsEditPlantNameFieldOpen(false);
    setEditPlantAiSummary(null);
    setEditPlantAiWaterAmount(null);
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
    setIsEditPlantNameFieldOpen(false);
    setEditPlantAiSummary(null);
    setEditPlantAiWaterAmount(null);
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
      const compressedResult = await compressPhotoForUpload(file, {
        maxBytes: MAX_PLANT_UPLOAD_BYTES,
        photoLabel: "Plant photo",
      });
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

  async function handleAnalyzeEditPlantPhotoWithAi() {
    if (!editingPlantId || !selectedRoom) {
      return;
    }
    const editingPlant = plants.find((plant) => plant.id === editingPlantId);
    if (!editingPlant?.photo_path) {
      setMessage("Add a plant photo first, then run AI analysis.");
      return;
    }
    setIsAnalyzingEditPlantPhoto(true);
    try {
      const result = await reanalyzePlantPhoto(getCurrentInitData(), { plantId: editingPlantId });
      if (result.ai_profile) {
        setEditPlantName(result.ai_profile.plant_name);
        setEditPlantThirstyAfterHours(result.ai_profile.thirsty_after_hours);
        setEditPlantOverdueAfterHours(result.ai_profile.overdue_after_hours);
        setEditPlantAiSummary(result.ai_profile.watering_summary);
        setEditPlantAiWaterAmount(result.ai_profile.watering_amount_recommendation);
        await fetchRoomDetails(selectedRoom.id);
        setMessage(
          result.ai_status === "low_confidence"
            ? "AI analysis applied with low confidence. Please review values."
            : "AI analysis complete. Recommendations saved.",
        );
        return;
      }
      if (result.ai_status === "disabled_missing_api_key") {
        setMessage("AI is disabled on server (missing GEMINI_API_KEY).");
      } else if (result.ai_status === "not_plant") {
        setMessage("This photo does not look like a plant. Use another photo.");
      } else if (result.ai_status === "low_confidence") {
        setMessage("AI is not confident enough. Try another photo.");
      } else if (result.ai_status === "request_failed") {
        setMessage("AI request failed. Please try again.");
      } else {
        setMessage("AI returned invalid response. Please try again.");
      }
    } catch {
      setMessage("AI analysis failed. Try again.");
    } finally {
      setIsAnalyzingEditPlantPhoto(false);
    }
  }

  function requestDeleteRoom(roomId: string, roomLabel: string) {
    setPendingDeleteTarget({ kind: "room", id: roomId, label: roomLabel });
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
    setIsConfirmDeletePending(true);
    try {
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
    } finally {
      setIsConfirmDeletePending(false);
    }
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
      setMarkerQuickMenuMarkerId(null);
      setWateringFocusMarkerId(null);
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
    const plantIdForMarker = selectedPlantIdForMarker;
    setOptimisticMarkerPlacement({ plantId: plantIdForMarker, x, y });
    if (markerPlacementFeedbackTimerRef.current !== null) {
      window.clearTimeout(markerPlacementFeedbackTimerRef.current);
    }
    setMarkerPlacementFeedback({ x, y });
    markerPlacementFeedbackTimerRef.current = window.setTimeout(() => {
      setMarkerPlacementFeedback(null);
      markerPlacementFeedbackTimerRef.current = null;
    }, 700);

    try {
      await upsertMarker(getCurrentInitData(), {
        roomId: selectedRoom.id,
        plantId: plantIdForMarker,
        x,
        y,
      });
      await fetchRoomDetails(selectedRoom.id);
      setMessage("Marker saved");
      setIsMarkerEditMode(false);
    } finally {
      setOptimisticMarkerPlacement(null);
    }
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

  function openRoomPhotoPicker(roomId: string) {
    setRoomPhotoPickerRoomId(roomId);
  }

  function closeRoomPhotoPicker() {
    setRoomPhotoPickerRoomId(null);
    if (roomPhotoUploadInputRef.current) {
      roomPhotoUploadInputRef.current.value = "";
    }
  }

  async function uploadRoomImageFile(roomId: string, file: File) {
    setRoomUploadStatus((prev) => ({
      ...prev,
      [roomId]: "Compressing photo...",
    }));

    const compressedResult = await compressPhotoForUpload(file, {
      maxBytes: MAX_ROOM_UPLOAD_BYTES,
      photoLabel: "Room photo",
    });
    setRoomUploadStatus((prev) => ({
      ...prev,
      [roomId]: compressedResult.compressed
        ? `Uploading compressed photo (${formatBytes(compressedResult.originalBytes)} -> ${formatBytes(compressedResult.resultBytes)})...`
        : `Uploading photo (${formatBytes(compressedResult.resultBytes)})...`,
    }));

    await uploadRoomImage(getCurrentInitData(), { roomId, file: compressedResult.file });

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

    await uploadRoomImageFile(roomId, file);
  }

  async function handleShowCartoonRoom() {
    if (!selectedRoom) {
      return;
    }
    if (roomVisualMode === "cartoon") {
      return;
    }
    const hasStylized = hasStylizedRoomImage(selectedRoom);
    if (hasStylized) {
      setPreferredRoomVisualMode("cartoon");
      setMessage("Cartoon mode enabled");
      return;
    }
    if (!selectedRoom.background_path && !selectedRoom.background_url) {
      setMessage("Upload a room photo first, then generate cartoon mode.");
      return;
    }
    if (isStylizingRoom) {
      return;
    }

    setIsStylizingRoom(true);
    setMessage("Generating cartoon room with AI...");
    try {
      const stylizedRoom = await stylizeRoomImage(getCurrentInitData(), {
        roomId: selectedRoom.id,
        force: false,
        preset: roomStylizationPreset,
      });
      setRooms((prev) => prev.map((room) => (room.id === stylizedRoom.id ? stylizedRoom : room)));
      setSelectedRoom((prev) => (prev?.id === stylizedRoom.id ? { ...prev, ...stylizedRoom } : prev));
      setPreferredRoomVisualMode("cartoon");
      setMessage("Cartoon room generated");
    } finally {
      setIsStylizingRoom(false);
    }
  }

  async function handleRegenerateCartoonRoom() {
    if (!selectedRoom) {
      return;
    }
    if (!selectedRoom.background_path && !selectedRoom.background_url) {
      setMessage("Upload a room photo first, then regenerate cartoon mode.");
      return;
    }
    if (isStylizingRoom) {
      return;
    }

    setIsStylizingRoom(true);
    setMessage("Regenerating cartoon room with AI...");
    try {
      const stylizedRoom = await stylizeRoomImage(getCurrentInitData(), {
        roomId: selectedRoom.id,
        force: true,
        preset: roomStylizationPreset,
      });
      setRooms((prev) => prev.map((room) => (room.id === stylizedRoom.id ? stylizedRoom : room)));
      setSelectedRoom((prev) => (prev?.id === stylizedRoom.id ? { ...prev, ...stylizedRoom } : prev));
      setRoomStylizeNonce((n) => n + 1);
      setPreferredRoomVisualMode("cartoon");
      setMessage("Cartoon room regenerated");
    } finally {
      setIsStylizingRoom(false);
    }
  }

  async function handleAutoDetectPlantsInRoom() {
    if (!selectedRoom) {
      return;
    }
    if (isDetectingRoomPlants) {
      return;
    }

    setIsDetectingRoomPlants(true);
    setMessage("Analyzing room photo with AI...");
    try {
      const result = await analyzeRoomPlantsPreview(getCurrentInitData(), { roomId: selectedRoom.id });
      if (result.ai_status === "ok") {
        setRoomDetectionPreview(result.detections);
        setSelectedRoomDetectionIndexes(result.detections.map((_, index) => index));
        setIsRoomDetectionPreviewOpen(true);
        setMessage(`AI found ${result.detections.length} plant${result.detections.length === 1 ? "" : "s"}.`);
        return;
      }
      if (result.ai_status === "no_plants") {
        setMessage("AI could not find plants on this room photo.");
        return;
      }
      if (result.ai_status === "disabled_missing_api_key") {
        setMessage("AI is disabled on server (missing GEMINI_API_KEY).");
        return;
      }
      const fallbackError = result.ai_error?.trim() || "AI room analysis failed.";
      setMessage(fallbackError);
    } finally {
      setIsDetectingRoomPlants(false);
    }
  }

  async function handleApplyRoomDetections() {
    if (!selectedRoom) {
      return;
    }
    if (isApplyingRoomDetections) {
      return;
    }
    const detectionsToCreate = roomDetectionPreview.filter((_, index) =>
      selectedRoomDetectionIndexes.includes(index),
    );
    if (detectionsToCreate.length === 0) {
      setMessage("Select at least one plant to create.");
      return;
    }

    setIsApplyingRoomDetections(true);
    setMessage("Creating plants and markers...");
    try {
      const result = await createRoomPlantsFromDetections(getCurrentInitData(), {
        roomId: selectedRoom.id,
        detections: detectionsToCreate,
      });
      await fetchRoomDetails(selectedRoom.id);
      setIsRoomDetectionPreviewOpen(false);
      setRoomDetectionPreview([]);
      setSelectedRoomDetectionIndexes([]);
      setMessage(
        `${result.created_count} plant${result.created_count === 1 ? "" : "s"} added with markers automatically.`,
      );
    } finally {
      setIsApplyingRoomDetections(false);
    }
  }

  function toggleRoomDetectionSelection(index: number) {
    setSelectedRoomDetectionIndexes((prev) =>
      prev.includes(index) ? prev.filter((value) => value !== index) : [...prev, index],
    );
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

  function openRoom(room: Room) {
    const preferredMode = getStoredRoomVisualMode();
    setRoomVisualMode(preferredMode === "cartoon" && hasStylizedRoomImage(room) ? "cartoon" : "photo");
    setRoomStylizeNonce(0);
    setSelectedRoom(room);
    void runSafely(() => fetchRoomDetails(room.id));
  }

  function handleRoomCardKeyDown(event: React.KeyboardEvent<HTMLElement>, room: Room) {
    if (event.key !== "Enter" && event.key !== " ") {
      return;
    }
    event.preventDefault();
    openRoom(room);
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
  const roomForPhotoPicker = roomPhotoPickerRoomId
    ? rooms.find((room) => room.id === roomPhotoPickerRoomId) ?? null
    : null;
  const roomPhotoPickerStatus = roomPhotoPickerRoomId ? roomUploadStatus[roomPhotoPickerRoomId] : null;
  const selectedRoomPhotoFile = roomPhotoPickerRoomId ? roomFiles[roomPhotoPickerRoomId] ?? null : null;
  const markerPlantForEdit = selectedPlantIdForMarker
    ? plants.find((plant) => plant.id === selectedPlantIdForMarker) ?? null
    : null;

  useEffect(() => {
    return () => {
      clearMarkerLongPressTimer();
      if (markerPlacementFeedbackTimerRef.current !== null) {
        window.clearTimeout(markerPlacementFeedbackTimerRef.current);
      }
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

  const savingMarkerGlow = getPlantGlowClasses("healthy");

  return (
  <MobileShell>
    <main className="min-h-screen pb-32 text-[#1f1b17]">
      {selectedRoom ? (
        <div className="mx-auto flex w-full max-w-5xl flex-col">
          <header className="fixed top-0 z-30 w-full border-b border-white/70 bg-[#fbfaf6]/88 shadow-[0_8px_28px_rgba(31,27,23,0.06)] backdrop-blur-xl">
            <div className="mx-auto flex w-full max-w-5xl flex-col gap-1.5 px-4 py-2">
              <div className="flex items-center justify-between gap-2">
                <div className="flex min-w-0 flex-1 items-center gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedRoom(null);
                      clearRoomDetailState();
                    }}
                    className="shrink-0 rounded-full bg-white/90 p-2 text-[#3c4a42] shadow-sm active:scale-95"
                    aria-label="Back to rooms"
                  >
                    <ArrowLeft className="h-5 w-5" />
                  </button>
                  <Sprout className="h-5 w-5 shrink-0 text-[#006c49]" />
                  <p className="min-w-0 truncate text-sm font-semibold text-[#006c49]">GreenHouse</p>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => {
                      clearNewPlantPhotoSelection();
                      setAddPlantNameError(null);
                      setPlantThirstyAfterHours(DEFAULT_THIRSTY_AFTER_HOURS);
                      setPlantOverdueAfterHours(DEFAULT_OVERDUE_AFTER_HOURS);
                      setIsAddPlantOpen(true);
                    }}
                    className="rounded-full border-b-2 border-[#005236] bg-[#006c49] px-3 py-1.5 text-[10px] font-bold text-white shadow-[0_6px_16px_rgba(0,108,73,0.28)] sm:px-4 sm:py-2 sm:text-xs"
                  >
                    Add Plant
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      void runSafely(handleAutoDetectPlantsInRoom);
                    }}
                    disabled={isDetectingRoomPlants}
                    className="rounded-full border border-[#0f766e]/45 bg-white/95 px-2.5 py-1.5 text-[10px] font-semibold text-[#0f766e] shadow-sm disabled:cursor-not-allowed disabled:opacity-60 sm:px-4 sm:py-2 sm:text-xs"
                  >
                    {isDetectingRoomPlants ? "Detect…" : "AI Plants"}
                  </button>
                </div>
              </div>
              <div className="flex items-center justify-center gap-1 border-t border-[#e8e4df]/80 pt-1.5">
                <p className="min-w-0 max-w-[min(100%,14rem)] truncate text-center text-xs font-medium text-[#6c7a71] sm:max-w-[min(100%,24rem)]">
                  {selectedRoom.name}
                </p>
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
            </div>
          </header>

          <section className="px-5 pt-28">
            {message ? (
              <div className="mb-3 rounded-xl border border-[#e8ddd6] bg-white/85 px-3 py-2 text-xs text-[#3c4a42] shadow-sm">
                {message}
              </div>
            ) : null}
            <div className="mb-3 space-y-2">
              <div className="flex items-center justify-between gap-3 rounded-2xl border border-white/80 bg-white/90 p-2 shadow-sm">
                <div className="min-w-0">
                  <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-[#006c49]">
                    Room style
                  </p>
                  <p className="truncate text-[11px] text-[#6c7a71]">
                    Switch between the original photo and AI cartoon view.
                  </p>
                </div>
                <div className="flex shrink-0 rounded-full border border-[#d5ddd9] bg-[#f8fcfa] p-1">
                  <button
                    type="button"
                    onClick={() => {
                      setPreferredRoomVisualMode("photo");
                      setMessage("Photo mode enabled");
                    }}
                    className={`rounded-full px-3 py-1.5 text-[11px] font-bold transition ${
                      roomVisualMode === "photo"
                        ? "bg-[#006c49] text-white shadow-sm"
                        : "text-[#3c4a42] hover:bg-white"
                    }`}
                  >
                    Photo
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      void runSafely(handleShowCartoonRoom);
                    }}
                    disabled={isStylizingRoom}
                    className={`inline-flex items-center gap-1 rounded-full px-3 py-1.5 text-[11px] font-bold transition disabled:cursor-not-allowed disabled:opacity-70 ${
                      roomVisualMode === "cartoon"
                        ? "bg-[#006c49] text-white shadow-sm"
                        : "text-[#3c4a42] hover:bg-white"
                    }`}
                  >
                    <Sparkles className="h-3.5 w-3.5" />
                    {isStylizingRoom ? "Working..." : "Cartoon"}
                  </button>
                </div>
              </div>
              <div className="flex items-center justify-between gap-2 rounded-2xl border border-[#e8ddd6] bg-[#fbfaf6]/90 px-3 py-2 shadow-sm">
                <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[#6c7a71]">
                  Cartoon preset
                </p>
                <div className="flex rounded-full border border-[#d5ddd9] bg-white p-1">
                  {(["soft", "medium", "strong"] as RoomStylizationPreset[]).map((preset) => (
                    <button
                      key={preset}
                      type="button"
                      onClick={() => {
                        setRoomStylizationPreset(preset);
                        setMessage(`Cartoon preset: ${preset}`);
                      }}
                      className={`rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide transition ${
                        roomStylizationPreset === preset
                          ? "bg-[#0f766e] text-white shadow-sm"
                          : "text-[#3c4a42] hover:bg-[#f3f7f5]"
                      }`}
                    >
                      {preset}
                    </button>
                  ))}
                </div>
              </div>
              {selectedRoom.stylized_background_path ||
              selectedRoom.signed_stylized_background_url ? (
                <div className="flex items-center justify-end gap-2 rounded-2xl border border-[#e8ddd6] bg-[#fbfaf6]/90 px-2 py-2 shadow-sm">
                  <button
                    type="button"
                    onClick={() => {
                      void runSafely(handleRegenerateCartoonRoom);
                    }}
                    disabled={isStylizingRoom}
                    className="inline-flex w-full items-center justify-center gap-2 rounded-xl border border-[#0f766e]/35 bg-white px-3 py-2 text-[11px] font-bold text-[#0f766e] shadow-sm disabled:cursor-not-allowed disabled:opacity-70 sm:w-auto"
                  >
                    <RefreshCw className={`h-3.5 w-3.5 ${isStylizingRoom ? "animate-spin" : ""}`} />
                    Regenerate cartoon
                  </button>
                </div>
              ) : null}
            </div>
            <div
              className="relative overflow-hidden rounded-[28px] border border-white/80 bg-[#f6ece6] shadow-[0_16px_40px_rgba(81,55,37,0.10)]"
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
                  markerPlant?.thirsty_after_hours ?? DEFAULT_THIRSTY_AFTER_HOURS,
                  markerPlant?.overdue_after_hours ?? DEFAULT_OVERDUE_AFTER_HOURS,
                );
                const colors = getPlantGlowClasses(status);
                const shimmerIntensity = isPendingWatering
                  ? "animate-pulse opacity-100"
                  : `${colors.shimmer} ${colors.shimmerOpacity}`;
                const popoverAlign =
                  marker.x >= 0.67 ? "right" : marker.x <= 0.33 ? "left" : "center";
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
                      className={`group relative flex h-12 w-12 items-center justify-center rounded-full border-2 transition-all active:scale-95 ${
                        isJustWatered ? "scale-110 ring-4 ring-[#10b981]/40" : ""
                      } ${colors.glow}`}
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
                        setMarkerQuickMenuMarkerId(null);
                        void runSafely(() =>
                          handleMarkerTap(marker.plant_id, marker.id, selectedRoom.id, event.timeStamp),
                        );
                      }}
                      title={markerPlant?.name ?? "Plant marker"}
                      aria-label={markerPlant?.name ?? "Plant marker"}
                    >
                      <span
                        className={`pointer-events-none absolute -inset-1 rounded-full border-2 bg-transparent transition ${shimmerIntensity} ${colors.pulse}`}
                      />
                      <span
                        className={`pointer-events-none relative h-2.5 w-2.5 rounded-full border border-white/90 shadow-sm ${colors.dot}`}
                      />
                    </button>
                    {markerQuickMenuMarkerId === marker.id && markerPlant ? (
                      <div
                        className={`absolute bottom-14 z-20 min-w-32 max-w-[min(15rem,calc(100vw-1.25rem))] rounded-2xl border border-white/80 bg-white/95 px-2.5 py-2 text-[#1f1b17] shadow-[0_10px_28px_rgba(31,27,23,0.16)] backdrop-blur-md ${
                          popoverAlign === "right"
                            ? "right-0 left-auto"
                            : popoverAlign === "left"
                              ? "left-0 right-auto"
                              : "left-1/2 -translate-x-1/2"
                        }`}
                        onClick={(event) => event.stopPropagation()}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <div className="min-w-0">
                            <p className="truncate text-xs font-bold">{markerPlant.name}</p>
                            <p className="text-[9px] font-semibold uppercase tracking-wide text-[#6c7a71]">
                              {status}
                            </p>
                          </div>
                          <button
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation();
                              setMarkerQuickMenuMarkerId(null);
                              openEditPlantDialog(markerPlant);
                            }}
                            className="shrink-0 rounded-full border border-[#d5ddd9] bg-[#f8fcfa] p-1.5 text-[#006c49] shadow-sm active:scale-95"
                            aria-label={`Edit ${markerPlant.name}`}
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </button>
                        </div>
                        <span
                          className={`absolute top-full h-2.5 w-2.5 -translate-y-1 rotate-45 border-b border-r border-white/80 bg-white/95 ${
                            popoverAlign === "right"
                              ? "right-5"
                              : popoverAlign === "left"
                                ? "left-5"
                                : "left-1/2 -translate-x-1/2"
                          }`}
                        />
                      </div>
                    ) : null}
                    {isPendingWatering ? (
                      <div
                        className="absolute bottom-10 left-1/2 -translate-x-1/2 rounded-lg bg-white px-2 py-1 text-[10px] font-semibold text-[#3c4a42] shadow-md"
                      >
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
              {optimisticMarkerPlacement ? (
                <div
                  className="pointer-events-none absolute -translate-x-1/2 -translate-y-1/2"
                  style={{
                    left: roomImageContentBox
                      ? `${roomImageContentBox.left + optimisticMarkerPlacement.x * roomImageContentBox.width}px`
                      : `${optimisticMarkerPlacement.x * 100}%`,
                    top: roomImageContentBox
                      ? `${roomImageContentBox.top + optimisticMarkerPlacement.y * roomImageContentBox.height}px`
                      : `${optimisticMarkerPlacement.y * 100}%`,
                  }}
                >
                  <div
                    className={`relative flex h-12 w-12 items-center justify-center rounded-full border-2 ${savingMarkerGlow.glow}`}
                  >
                    <span
                      className={`pointer-events-none absolute -inset-1 animate-pulse rounded-full border-2 bg-transparent opacity-90 ${savingMarkerGlow.pulse}`}
                    />
                    <span
                      className={`pointer-events-none relative h-2.5 w-2.5 rounded-full border border-white/90 shadow-sm ${savingMarkerGlow.dot}`}
                    />
                  </div>
                  <span className="absolute -bottom-7 left-1/2 -translate-x-1/2 rounded-md bg-white/95 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-[#006c49] shadow">
                    Saving...
                  </span>
                </div>
              ) : null}
              {markerPlacementFeedback ? (
                <div
                  className="pointer-events-none absolute -translate-x-1/2 -translate-y-1/2"
                  style={{
                    left: roomImageContentBox
                      ? `${roomImageContentBox.left + markerPlacementFeedback.x * roomImageContentBox.width}px`
                      : `${markerPlacementFeedback.x * 100}%`,
                    top: roomImageContentBox
                      ? `${roomImageContentBox.top + markerPlacementFeedback.y * roomImageContentBox.height}px`
                      : `${markerPlacementFeedback.y * 100}%`,
                  }}
                >
                  <div
                    className={`relative flex h-12 w-12 items-center justify-center rounded-full border-2 ${savingMarkerGlow.glow}`}
                  >
                    <span
                      className={`pointer-events-none absolute -inset-1 animate-ping rounded-full border-2 bg-transparent opacity-80 ${savingMarkerGlow.pulse}`}
                    />
                    <span
                      className={`pointer-events-none relative h-2.5 w-2.5 rounded-full border border-white/90 shadow-sm ${savingMarkerGlow.dot}`}
                    />
                  </div>
                </div>
              ) : null}
              {isMarkerEditMode ? (
                <div className="pointer-events-none absolute inset-0 z-20">
                  <div className="pointer-events-auto absolute left-3 right-3 top-3 flex items-center justify-between gap-2 rounded-lg border border-[#d4e8df]/70 bg-white/70 px-2.5 py-1.5 text-xs shadow-sm backdrop-blur-[2px]">
                    <div className="min-w-0">
                      <p className="text-[10px] font-bold uppercase tracking-wide text-[#006c49]">
                        Place marker
                      </p>
                      <p className="truncate text-[10px] text-[#3c4a42]">
                        Tap photo for{" "}
                        <span className="font-semibold">
                          {markerPlantForEdit?.name ?? "selected plant"}
                        </span>
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        setIsMarkerEditMode(false);
                      }}
                      className="rounded-md bg-[#ffdad6]/85 px-1.5 py-0.5 text-[10px] font-semibold text-[#93000a]"
                    >
                      Cancel
                    </button>
                  </div>
                  <div className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full border border-[#d4e8df]/70 bg-white/65 px-3 py-1 text-[10px] font-semibold text-[#006c49] shadow-sm backdrop-blur-[2px]">
                    Tap on photo to place marker
                  </div>
                </div>
              ) : null}
            </div>
            <div className="mt-4 rounded-[28px] border border-white/80 bg-white/92 p-4 shadow-[0_12px_32px_rgba(81,55,37,0.08)]">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-[#006c49]">
                    Room plants
                  </p>
                  <h3 className="mt-0.5 text-lg font-bold text-[#1f1b17]">Plants in this room</h3>
                </div>
                <span className="rounded-full bg-[#f4faf7] px-3 py-1 text-xs font-bold text-[#006c49]">
                  {plants.length}
                </span>
              </div>
              {plants.length === 0 ? (
                <div className="mt-3 rounded-2xl border border-dashed border-[#c5d4cc] bg-[#fbfaf6] p-5 text-center">
                  <p className="text-sm font-semibold text-[#3c4a42]">No plants here yet</p>
                  <p className="mt-1 text-xs text-[#6c7a71]">
                    Add your first plant, then tap the room photo to place its marker.
                  </p>
                </div>
              ) : (
                <ul className="mt-2 space-y-2">
                  {plants.map((plant) => {
                    const hasMarker = markers.some((marker) => marker.plant_id === plant.id);
                    return (
                    <li
                      key={plant.id}
                      className="rounded-2xl border border-[#eee6dc] bg-[#fffaf5] px-3 py-3 text-sm text-[#1f1b17] shadow-sm"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex min-w-0 items-start gap-3">
                          {plant.signed_photo_url ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img
                              src={plant.signed_photo_url}
                              alt={plant.name}
                              className="h-16 w-16 shrink-0 rounded-2xl border border-[#e8ddd6] object-cover"
                            />
                          ) : (
                            <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-2xl border border-dashed border-[#d5ccc6] bg-[#fff8f5] text-[10px] font-semibold uppercase tracking-wide text-[#9b8a80]">
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
                              plant.thirsty_after_hours ?? DEFAULT_THIRSTY_AFTER_HOURS,
                              plant.overdue_after_hours ?? DEFAULT_OVERDUE_AFTER_HOURS,
                            )}
                          </p>
                          <p className="text-[10px] text-[#6c7a71]">
                            Last watered: {formatLastWatered(plant.last_watered_at)}
                          </p>
                          <p className="text-[10px] text-[#6c7a71]">
                            Thresholds: thirsty after{" "}
                            {formatHours(plant.thirsty_after_hours ?? DEFAULT_THIRSTY_AFTER_HOURS)}
                            h, overdue after{" "}
                            {formatHours(plant.overdue_after_hours ?? DEFAULT_OVERDUE_AFTER_HOURS)}
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
                            className="rounded-xl border-b-2 border-[#005236] bg-[#006c49] px-3 py-2 text-[11px] font-bold text-white shadow-[0_3px_10px_rgba(0,108,73,0.24)]"
                          >
                            Watered
                          </button>
                          <button
                            type="button"
                            onClick={() => openEditPlantDialog(plant)}
                            className="rounded-xl border border-[#bbcabf] bg-white px-3 py-2 text-[11px] font-bold text-[#3c4a42]"
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
          <header className="mb-4 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-[#e6f5ef] text-[#006c49] shadow-sm">
                <Sprout className="h-5 w-5" />
              </span>
              <div>
                <p className="text-base font-extrabold tracking-tight text-[#006c49]">GreenHouse</p>
                <p className="text-[11px] font-medium text-[#6c7a71] truncate max-w-[12rem]">
                  {currentHousehold?.name ?? "Home"}
                </p>
              </div>
            </div>
            <Link
              href="/settings"
              className="rounded-full bg-white/90 p-2.5 text-[#6c7a71] shadow-sm hover:text-[#006c49]"
              aria-label="Settings"
            >
              <Settings className="h-5 w-5" />
            </Link>
          </header>

          {message ? (
            <p className="mb-4 rounded-2xl border border-[#e7ddd6] bg-white/85 px-3 py-2 text-xs font-medium text-[#3c4a42]">
              {message}
            </p>
          ) : null}

          <section className="mb-5 rounded-2xl border border-[#d8e5de] bg-white/92 p-3 shadow-[0_8px_24px_rgba(81,55,37,0.06)]">
            {homesForPicker.length === 0 ? (
              <div className="rounded-xl border border-dashed border-[#c5d4cc] bg-[#fbfaf6] px-3 py-4 text-center">
                <p className="text-xs font-medium text-[#6c7a71]">Loading your homes…</p>
              </div>
            ) : (
              <div className="relative">
                <select
                  value={householdId ?? homesForPicker[0]?.household_id ?? ""}
                  onChange={(event) => {
                    const nextHouseholdId = event.target.value;
                    if (nextHouseholdId && nextHouseholdId !== householdId) {
                      void runSafely(() => handleSwitchHousehold(nextHouseholdId));
                    }
                  }}
                  className="w-full appearance-none rounded-xl border border-[#c8d8cf] bg-[#f8fcfa] py-2.5 pl-3 pr-10 text-sm font-semibold text-[#1f1b17] outline-none transition focus:border-[#006c49] focus:ring-2 focus:ring-[#006c49]/20"
                  aria-label="Active home"
                >
                  {homesForPicker.map((home) => (
                    <option key={home.household_id} value={home.household_id}>
                      {home.household_name}
                    </option>
                  ))}
                </select>
                <span className="pointer-events-none absolute inset-y-0 right-3 inline-flex items-center text-[#6c7a71]">
                  <ChevronsUpDown className="h-4 w-4" />
                </span>
              </div>
            )}
          </section>

          <section className="mb-4 flex items-center justify-between gap-3 rounded-2xl border border-white/80 bg-white/90 p-2 shadow-sm">
            <div className="min-w-0">
              <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-[#006c49]">Room style</p>
              <p className="truncate text-[11px] text-[#6c7a71]">
                Previews use cartoon when a room has a generated cartoon.
              </p>
            </div>
            <div className="flex shrink-0 rounded-full border border-[#d5ddd9] bg-[#f8fcfa] p-1">
              <button
                type="button"
                onClick={() => {
                  setPreferredRoomVisualMode("photo");
                  setMessage("Photo previews");
                }}
                className={`rounded-full px-3 py-1.5 text-[11px] font-bold transition ${
                  roomVisualMode === "photo"
                    ? "bg-[#006c49] text-white shadow-sm"
                    : "text-[#3c4a42] hover:bg-white"
                }`}
              >
                Photo
              </button>
              <button
                type="button"
                onClick={() => {
                  setPreferredRoomVisualMode("cartoon");
                  setMessage("Cartoon previews (where available)");
                }}
                className={`inline-flex items-center gap-1 rounded-full px-3 py-1.5 text-[11px] font-bold transition ${
                  roomVisualMode === "cartoon"
                    ? "bg-[#006c49] text-white shadow-sm"
                    : "text-[#3c4a42] hover:bg-white"
                }`}
              >
                <Sparkles className="h-3.5 w-3.5" />
                Cartoon
              </button>
            </div>
          </section>

          <section className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {rooms.length === 0 ? (
              <div className="rounded-[28px] border border-dashed border-[#c5d4cc] bg-white/80 p-8 text-center shadow-[0_10px_28px_rgba(81,55,37,0.07)] md:col-span-2">
                <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-[#e6f5ef] text-[#006c49]">
                  <Sprout className="h-7 w-7" />
                </div>
                <h2 className="mt-4 text-lg font-bold text-[#1f1b17]">Create your first room</h2>
                <p className="mx-auto mt-2 max-w-sm text-sm leading-6 text-[#6c7a71]">
                  Add a living room, balcony, or kitchen, then upload a photo so plant markers feel
                  natural.
                </p>
                <button
                  type="button"
                  onClick={() => setIsCreateRoomOpen(true)}
                  className="mt-5 inline-flex items-center justify-center gap-2 rounded-2xl border-b-2 border-[#005236] bg-[#006c49] px-5 py-3 text-sm font-bold text-white shadow-[0_6px_18px_rgba(0,108,73,0.28)]"
                >
                  <Plus className="h-5 w-5" />
                  Add room
                </button>
              </div>
            ) : (
              rooms.map((room) => (
                <article
                  key={room.id}
                  className="group cursor-pointer overflow-hidden rounded-[28px] border border-white/80 bg-white shadow-[0_10px_28px_rgba(81,55,37,0.07)] transition hover:-translate-y-0.5 hover:shadow-[0_16px_36px_rgba(81,55,37,0.12)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#006c49]/35 focus-visible:ring-offset-2"
                  onClick={() => openRoom(room)}
                  onKeyDown={(event) => handleRoomCardKeyDown(event, room)}
                  role="button"
                  tabIndex={0}
                  aria-label={`Open ${room.name}`}
                >
                  <div className="relative h-48 bg-[#f6ece6]">
                    {getRoomImageUrl(room) ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={getRoomImageUrl(room) ?? undefined}
                        alt={room.name}
                        className="h-full w-full object-cover transition duration-300 group-hover:scale-[1.03]"
                      />
                    ) : (
                      <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-[#6c7a71]">
                        <ImagePlus className="h-8 w-8 text-[#9b8a80]" />
                        <span>No room photo yet</span>
                      </div>
                    )}
                    <div className="pointer-events-none absolute inset-x-0 bottom-0 h-24 bg-gradient-to-t from-black/40 to-transparent" />
                    <button
                      type="button"
                      className="absolute left-3 top-3 rounded-full bg-white/95 p-2 text-[#006c49] shadow-md active:scale-95"
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
                      className="absolute right-3 top-3 rounded-full bg-white/95 p-2 text-[#93000a] shadow-md active:scale-95"
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
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="text-lg font-bold text-[#1f1b17]">{room.name}</p>
                        <p className="mt-1 text-xs font-medium text-[#6c7a71]">
                          Open room details and plant markers
                        </p>
                      </div>
                      <span className="rounded-full bg-[#e6f5ef] px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide text-[#006c49]">
                        Open
                      </span>
                    </div>

                    <div
                      className="mt-4 rounded-2xl border border-[#eee6dc] bg-[#fbfaf6] px-3 py-2.5"
                      onClick={(event) => event.stopPropagation()}
                    >
                      <div className="flex items-center justify-between gap-3">
                        <p className="text-[11px] font-bold uppercase tracking-[0.12em] text-[#6c7a71]">
                          Room photo
                        </p>
                        <button
                          type="button"
                          onClick={() => openRoomPhotoPicker(room.id)}
                          className="inline-flex min-h-8 items-center justify-center rounded-lg border border-[#d5ddd9] bg-white px-2.5 py-1 text-[11px] font-bold text-[#3c4a42] shadow-sm hover:border-[#bbcabf]"
                        >
                          Change
                        </button>
                      </div>
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
            className="fixed bottom-24 right-6 z-30 flex h-14 w-14 items-center justify-center rounded-2xl border-b-2 border-[#005236] bg-[#006c49] text-white shadow-[0_14px_30px_rgba(0,108,73,0.34)]"
            aria-label="Add room"
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

      {!selectedRoom && roomForPhotoPicker ? (
        <div className="fixed inset-0 z-[60] flex items-end justify-center overflow-y-auto bg-black/35 p-4 pb-28 pt-16 sm:items-center sm:pb-4 sm:pt-4">
          <div className="relative max-h-[85vh] w-full max-w-md overflow-y-auto rounded-[24px] bg-white p-4 shadow-xl">
            <h3 className="text-base font-semibold text-[#1f1b17]">Room photo</h3>
            <p className="mt-1 text-sm text-[#6c7a71]">{roomForPhotoPicker.name}</p>
            <div className="mt-4 grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => {
                  void runSafely(() => handleOpenCameraCapture("room"));
                }}
                className="rounded-xl border border-[#bbcabf] bg-white px-3 py-2 text-xs font-semibold text-[#3c4a42]"
              >
                Take photo
              </button>
              <button
                type="button"
                onClick={() => roomPhotoUploadInputRef.current?.click()}
                className="rounded-xl border border-[#bbcabf] bg-white px-3 py-2 text-xs font-semibold text-[#3c4a42]"
              >
                Choose photo
              </button>
            </div>
            <input
              ref={roomPhotoUploadInputRef}
              type="file"
              accept="image/*"
              onChange={(event) =>
                handleRoomFileChange(roomForPhotoPicker.id, event.target.files?.[0] ?? null)
              }
              className="hidden"
            />
            {selectedRoomPhotoFile ? (
              <p className="mt-3 rounded-lg border border-[#e8ddd6] bg-[#fbfaf6] px-2.5 py-2 text-xs text-[#3c4a42]">
                Selected: {selectedRoomPhotoFile.name}
              </p>
            ) : (
              <p className="mt-3 text-xs text-[#6c7a71]">No photo selected yet.</p>
            )}
            {roomPhotoPickerStatus ? (
              <p className="mt-2 text-xs text-[#6c7a71]">{roomPhotoPickerStatus}</p>
            ) : null}
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={closeRoomPhotoPicker}
                className="rounded-xl border border-[#bbcabf] px-4 py-2 text-sm font-medium text-[#3c4a42]"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  void runSafely(async () => {
                    await handleUploadImage(roomForPhotoPicker.id);
                    closeRoomPhotoPicker();
                  });
                }}
                className="rounded-xl border-b-2 border-[#005236] bg-[#006c49] px-4 py-2 text-sm font-semibold text-white"
              >
                Upload
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {!selectedRoom && isCreateHomeOpen ? (
        <div className="fixed inset-0 z-50 flex items-end justify-center overflow-y-auto bg-black/30 p-3 pb-24 pt-3 sm:items-center sm:p-4">
          <div className="relative max-h-[calc(100dvh-7rem)] w-full max-w-md overflow-y-auto rounded-[24px] bg-white p-4 shadow-xl sm:max-h-[85vh]">
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
              placeholder="AB7D9K2Q4M"
              className="mt-4 w-full rounded-xl border border-[#bbcabf] bg-white px-3 py-2 text-sm uppercase outline-none focus:border-[#006c49]"
              maxLength={10}
              autoFocus
            />
            {message ? <p className="mt-2 text-xs text-[#8a3b1c]">{message}</p> : null}
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
                    setPlantThirstyAfterHours(parseHoursInput(event.target.value));
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
                    setPlantOverdueAfterHours(parseHoursInput(event.target.value));
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
                        {newPlantPhotoAiError}
                        {lowConfidenceAiProfile
                          ? " You can retry, use another photo, apply anyway, or continue manually."
                          : " You can retry or continue manually."}
                      </p>
                    ) : null}
                    {lowConfidenceAiProfile ? (
                      <button
                        type="button"
                        onClick={handleApplyLowConfidenceAiSuggestion}
                        className="mt-2 w-full rounded-lg border border-[#bbcabf] bg-white px-3 py-2 text-xs font-semibold text-[#3c4a42]"
                      >
                        Apply anyway
                      </button>
                    ) : null}
                    {didApplyAiAutofill ? (
                      <p className="mt-2 text-[11px] text-[#006c49]">
                        AI filled fields automatically.
                      </p>
                    ) : null}
                    {didApplyAiAutofill && latestAiProfile ? (
                      <p className="mt-2 text-[11px] text-[#6c7a71]">
                        Suggested water amount:{" "}
                        <span className="font-semibold text-[#3c4a42]">
                          {formatWateringAmount(latestAiProfile.watering_amount_recommendation)}
                        </span>
                        . {latestAiProfile.watering_summary}
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
                  setPlantThirstyAfterHours(DEFAULT_THIRSTY_AFTER_HOURS);
                  setPlantOverdueAfterHours(DEFAULT_OVERDUE_AFTER_HOURS);
                  setIsAddPlantOpen(false);
                }}
                disabled={isCreatingPlant}
                className="rounded-xl border border-[#bbcabf] px-4 py-2 text-sm font-medium text-[#3c4a42]"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  void runSafely(handleCreatePlant);
                }}
                disabled={isCreatingPlant}
                aria-busy={isCreatingPlant}
                className="inline-flex min-w-[8.75rem] items-center justify-center gap-2 rounded-xl border-b-2 border-[#005236] bg-[#006c49] px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-80"
              >
                {isCreatingPlant ? (
                  <>
                    <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/40 border-t-white" />
                    Adding plant...
                  </>
                ) : (
                  "Add Plant"
                )}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {selectedRoom && isRoomDetectionPreviewOpen ? (
        <div className="fixed inset-0 z-[65] flex items-end justify-center overflow-y-auto bg-black/40 p-4 pb-28 pt-16 sm:items-center sm:pb-4 sm:pt-4">
          <div className="w-full max-w-md rounded-[24px] bg-white p-4 shadow-xl">
            <h3 className="text-base font-semibold text-[#1f1b17]">AI detected plants</h3>
            <p className="mt-1 text-sm text-[#6c7a71]">
              Select items to create in <span className="font-semibold">{selectedRoom.name}</span>.
            </p>
            <div className="mt-3 max-h-72 space-y-2 overflow-y-auto pr-1">
              {roomDetectionPreview.map((detection, index) => {
                const isSelected = selectedRoomDetectionIndexes.includes(index);
                return (
                  <label
                    key={`${detection.plant_name}-${index}`}
                    className={`flex cursor-pointer items-start gap-2 rounded-xl border p-2 ${
                      isSelected ? "border-[#006c49] bg-[#e6f5ef]/60" : "border-[#e8ddd6] bg-white"
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => toggleRoomDetectionSelection(index)}
                      className="mt-1 h-4 w-4 accent-[#006c49]"
                    />
                    <div className="min-w-0 text-xs text-[#3c4a42]">
                      <p className="truncate text-sm font-semibold text-[#1f1b17]">{detection.plant_name}</p>
                      <p className="mt-0.5 text-[#6c7a71]">
                        {detection.species ? `Species: ${detection.species}` : "Species: not specified"}
                      </p>
                      <p className="mt-0.5 text-[#6c7a71]">
                        Marker: x={detection.marker_x.toFixed(2)}, y={detection.marker_y.toFixed(2)}
                      </p>
                    </div>
                  </label>
                );
              })}
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setIsRoomDetectionPreviewOpen(false);
                  setRoomDetectionPreview([]);
                  setSelectedRoomDetectionIndexes([]);
                }}
                disabled={isApplyingRoomDetections}
                className="rounded-xl border border-[#bbcabf] px-4 py-2 text-sm font-medium text-[#3c4a42]"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  void runSafely(handleApplyRoomDetections);
                }}
                disabled={isApplyingRoomDetections}
                className="rounded-xl border-b-2 border-[#005236] bg-[#006c49] px-4 py-2 text-sm font-semibold text-white disabled:opacity-70"
              >
                {isApplyingRoomDetections ? "Creating..." : "Create selected"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {isCameraCaptureOpen ? (
        <div className="fixed inset-0 z-[70] flex items-end justify-center overflow-y-auto bg-black/50 p-4 pb-28 pt-16 sm:items-center sm:pb-4 sm:pt-4">
          <div className="w-full max-w-md rounded-[24px] bg-white p-4 shadow-xl">
            <h3 className="text-base font-semibold text-[#1f1b17]">Take photo</h3>
            <p className="mt-1 text-sm text-[#6c7a71]">
              {cameraCaptureTarget === "room"
                ? "Point camera at the room and tap Capture."
                : "Point camera at the plant and tap Capture."}
            </p>
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
        <div className="fixed inset-0 z-50 flex items-end justify-center overflow-y-auto bg-black/30 p-3 pb-20 pt-6 sm:items-center sm:p-4">
          <div className="w-full max-w-md overflow-hidden rounded-[24px] bg-white shadow-xl">
            <div
              className="max-h-[calc(100dvh-8.5rem)] overflow-y-auto px-4 pb-3 pt-3 sm:max-h-[85vh]"
              style={{ paddingTop: "calc(0.75rem + env(safe-area-inset-top, 0px))" }}
            >
              {editingPlantId ? (
                (() => {
                  const editingPlant = plants.find((plant) => plant.id === editingPlantId);
                  if (!editingPlant) {
                    return null;
                  }
                  return (
                    <>
                      <div className="rounded-xl border border-[#e7ddd6] bg-[#fffaf7] p-3">
                        <div className="flex items-start gap-3">
                          {editingPlant.signed_photo_url ? (
                            <div className="h-24 w-24 shrink-0 overflow-hidden rounded-lg border border-[#e8ddd6] bg-white p-1">
                              {/* eslint-disable-next-line @next/next/no-img-element */}
                              <img
                                src={editingPlant.signed_photo_url}
                                alt={editingPlant.name}
                                className="h-full w-full object-contain object-left-top"
                              />
                            </div>
                          ) : (
                            <div className="flex h-24 w-24 shrink-0 items-center justify-center rounded-lg border border-dashed border-[#d5ccc6] bg-white text-[10px] font-semibold uppercase tracking-wide text-[#9b8a80]">
                              no photo
                            </div>
                          )}
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center justify-between gap-2">
                              <p className="truncate text-sm font-semibold text-[#1f1b17]">{editPlantName}</p>
                              <button
                                type="button"
                                onClick={() => {
                                  setIsEditPlantNameFieldOpen(true);
                                  window.requestAnimationFrame(() => {
                                    document.getElementById("edit-plant-name-input")?.focus();
                                  });
                                }}
                                className="rounded-lg border border-[#bbcabf] p-1.5 text-[#6c7a71]"
                                aria-label="Edit plant name"
                              >
                                <Pencil className="h-3.5 w-3.5" />
                              </button>
                            </div>
                            {editingPlant.ai_inferred_at ? (
                              <p className="mt-1 inline-flex rounded-full bg-[#e6f5ef] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[#006c49]">
                                AI detected
                              </p>
                            ) : null}
                            <p className="mt-1 text-xs text-[#6c7a71]">
                              Last watered: {formatLastWatered(editingPlant.last_watered_at)}
                            </p>
                          </div>
                        </div>
                      </div>

                      <div className="rounded-xl border border-[#e7ddd6] bg-[#fffaf7] p-3">
                        <p className="text-[11px] font-bold uppercase tracking-[0.12em] text-[#6c7a71]">
                          Watering recommendations
                        </p>
                        <p className="mt-1 text-xs leading-relaxed text-[#3c4a42]">
                          {editPlantAiSummary ? (
                            editPlantAiSummary
                          ) : (
                            <>Not available yet. Tap "Analyze with AI" below to refresh guidance.</>
                          )}
                        </p>
                        <p className="mt-2 text-[11px] text-[#6c7a71]">
                          Suggested amount:{" "}
                          <span className="font-semibold text-[#3c4a42]">
                            {formatWateringAmount(
                              editPlantAiWaterAmount ?? editingPlant.watering_amount_recommendation,
                            )}
                          </span>
                        </p>
                      </div>
                    </>
                  );
                })()
              ) : null}

              {isEditPlantNameFieldOpen ? (
                <input
                  id="edit-plant-name-input"
                  value={editPlantName}
                  onChange={(event) => setEditPlantName(event.target.value)}
                  placeholder="Plant name"
                  className="mt-3 w-full rounded-xl border border-[#bbcabf] bg-white px-3 py-2 text-sm outline-none focus:border-[#006c49]"
                  autoFocus
                />
              ) : null}
              <details className="mt-3 rounded-xl border border-[#e7ddd6] bg-[#fffaf7] p-3">
                <summary className="cursor-pointer text-xs font-semibold text-[#3c4a42]">
                  Advanced settings
                </summary>
                <div className="mt-3">
                  <div className="grid grid-cols-2 gap-2">
                    <label className="text-xs text-[#6c7a71]">
                      Thirsty after (hours)
                      <input
                        type="number"
                        min={0.1}
                        step={0.1}
                        value={editPlantThirstyAfterHours}
                        onChange={(event) => {
                          setEditPlantThirstyAfterHours(parseHoursInput(event.target.value));
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
                          setEditPlantOverdueAfterHours(parseHoursInput(event.target.value));
                        }}
                        className="mt-1 w-full rounded-xl border border-[#bbcabf] bg-white px-3 py-2 text-sm outline-none focus:border-[#006c49]"
                      />
                    </label>
                  </div>
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
                  <div className="mt-3 rounded-xl border border-[#e7ddd6] bg-white p-3">
                    <p className="text-xs font-semibold text-[#3c4a42]">Plant photo</p>
                    <div className="mt-2 flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          void runSafely(() => handleOpenCameraCapture("editPlant"));
                        }}
                        disabled={isReplacingPlantPhoto || isRemovingPlantPhoto || isAnalyzingEditPlantPhoto}
                        className="inline-flex items-center gap-1 rounded-lg border border-[#bbcabf] bg-white px-3 py-1.5 text-xs font-semibold text-[#3c4a42]"
                      >
                        <Camera className="h-4 w-4" />
                        Take photo
                      </button>
                      <button
                        type="button"
                        onClick={() => editPlantPhotoInputRef.current?.click()}
                        disabled={isReplacingPlantPhoto || isRemovingPlantPhoto || isAnalyzingEditPlantPhoto}
                        className="inline-flex items-center gap-1 rounded-lg border border-[#bbcabf] bg-white px-3 py-1.5 text-xs font-semibold text-[#3c4a42]"
                      >
                        <ImagePlus className="h-4 w-4" />
                        {isReplacingPlantPhoto ? "Uploading..." : "Replace photo"}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          void runSafely(handleAnalyzeEditPlantPhotoWithAi);
                        }}
                        disabled={isReplacingPlantPhoto || isRemovingPlantPhoto || isAnalyzingEditPlantPhoto}
                        className="inline-flex items-center gap-1 rounded-lg border border-[#006c49] bg-[#e6f5ef] px-3 py-1.5 text-xs font-semibold text-[#006c49]"
                      >
                        {isAnalyzingEditPlantPhoto ? "Analyzing..." : "Analyze with AI"}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          void runSafely(handleRemovePlantPhoto);
                        }}
                        disabled={isReplacingPlantPhoto || isRemovingPlantPhoto || isAnalyzingEditPlantPhoto}
                        className="inline-flex items-center rounded-lg border border-[#ba1a1a]/30 px-3 py-1.5 text-xs font-semibold text-[#93000a]"
                      >
                        {isRemovingPlantPhoto ? "Removing..." : "Remove photo"}
                      </button>
                    </div>
                  </div>
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
              </details>

              <div className="mt-4 flex flex-wrap justify-end gap-2 pb-1">
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
              </div>
            </div>

            <div className="shrink-0 border-t border-[#e8ddd6] bg-white/95 px-4 pb-3 pt-3 backdrop-blur sm:rounded-b-[24px]">
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setIsEditPlantNameFieldOpen(false);
                    setIsEditPlantOpen(false);
                  }}
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
                disabled={isConfirmDeletePending}
                className="rounded-xl border border-[#bbcabf] px-4 py-2 text-sm font-medium text-[#3c4a42]"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={isConfirmDeletePending}
                onClick={() => {
                  void runSafely(handleConfirmDelete);
                }}
                className="rounded-xl border-b-2 border-[#7a0007] bg-[#ba1a1a] px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
              >
                {isConfirmDeletePending ? "Deleting..." : "Continue"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

    </main>
    </MobileShell>
  );
}
