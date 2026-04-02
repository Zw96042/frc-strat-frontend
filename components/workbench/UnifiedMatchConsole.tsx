'use client';

import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import {
  ApiError,
  createSourceJob,
  deleteJob,
  deleteMatch,
  fetchCalibrationPresets,
  fetchFuelState,
  fetchJob,
  fetchJobs,
  fetchMatch,
  fetchMatches,
  fetchTeamSchedule,
  fetchWatchbot,
  processFuel,
  resolveArtifactUrl,
  startWatchbot,
  stopWatchbot,
  updateMatchLabels,
} from "@/lib/api";
import { FIELD_HEIGHT, FIELD_WIDTH } from "@/lib/fieldGeometry";
import {
  airProfileFromFieldMap,
  drawAirProfileFrame,
  drawCombinedFieldFrame,
  fetchJsonAirProfile,
  fetchJsonFieldMap,
} from "@/lib/fuelFieldVisualization";
import type { AirProfileData, CalibrationPreset, FieldMapData, FuelAnalysisRecord, FuelCalibration, JobRecord, MatchRecord, MatchSummary, TbaMatch, TrackRecord, WatchbotState } from "@/lib/types";

const FUEL_FIELD_IMAGE_SRC = "/assets/rebuilt-field.png";

const FIELD_MARGIN = 36;
const TRACK_SNAPSHOT_TOLERANCE_SECONDS = 0.2;
const TRACK_INTERPOLATION_MAX_GAP_SECONDS = 0.5;
const TRACK_HOLD_MAX_GAP_SECONDS = 1.0;
const TRACK_SWITCH_DEDUPE_DISTANCE_IN = 24;
const DETECTION_SNAPSHOT_TOLERANCE_SECONDS = 0.2;
const VIEW_ORDER = ["left", "main", "right"] as const;
const VIEW_LABELS: Record<(typeof VIEW_ORDER)[number], string> = {
  left: "Left",
  main: "Main",
  right: "Right",
};
const SELECT_CLASS =
  "appearance-none rounded-full border border-white/10 bg-[linear-gradient(180deg,rgba(255,255,255,0.08),rgba(255,255,255,0.03))] px-4 py-2 pr-10 text-sm text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.05)] outline-none transition hover:bg-white/10 focus:border-emerald-300/40";
const INPUT_CLASS =
  "rounded-2xl border border-white/10 bg-[linear-gradient(180deg,rgba(255,255,255,0.08),rgba(255,255,255,0.03))] px-4 py-3 text-sm text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.05)] outline-none transition placeholder:text-white/35 focus:border-emerald-300/40";

function isTrackOnField(track: { x: number; y: number }) {
  return (
    track.x >= -(FIELD_WIDTH / 2) - FIELD_MARGIN &&
    track.x <= (FIELD_WIDTH / 2) + FIELD_MARGIN &&
    track.y >= -(FIELD_HEIGHT / 2) - FIELD_MARGIN &&
    track.y <= (FIELD_HEIGHT / 2) + FIELD_MARGIN
  );
}

function formatTime(seconds: number) {
  if (!Number.isFinite(seconds)) return "0:00";
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${String(secs).padStart(2, "0")}`;
}

function parseMatchMetadata(match: MatchSummary) {
  const displayName = String(match.metadata.display_name ?? match.id);
  const normalized = displayName.toLowerCase();

  let compLevel = "other";
  if (normalized.startsWith("q")) compLevel = "qual";
  else if (normalized.startsWith("sf")) compLevel = "playoff";
  else if (normalized.startsWith("f")) compLevel = "final";
  else if (normalized.startsWith("p")) compLevel = "practice";
  else if (normalized.startsWith("m")) compLevel = "match";

  return {
    displayName,
    eventName: String(match.metadata.event_name ?? "Local Imports"),
    compLevel,
  };
}

function scheduleLabel(match: TbaMatch) {
  const level = match.comp_level ?? "match";
  return `${level.toUpperCase()} ${match.match_number ?? "?"}`;
}

function estimateJobProgress(job: JobRecord) {
  if (job.status === "completed") return 100;
  if (job.status === "failed") return 100;
  if (job.status === "queued") return 12;
  const logBoost = Math.min(job.logs.length * 12, 72);
  return Math.min(24 + logBoost, 92);
}

function jobStatusClasses(job: JobRecord) {
  if (job.status === "completed") return "bg-emerald-400/15 text-emerald-200";
  if (job.status === "failed") return "bg-rose-400/15 text-rose-200";
  return "bg-amber-300/15 text-amber-100";
}

function mergeTrackViews(...tracks: Array<TrackRecord | null | undefined>) {
  const merged = new Set<(typeof VIEW_ORDER)[number]>();
  tracks.forEach((track) => {
    if (!track) return;
    if (track.source_views.length > 0) {
      track.source_views.forEach((view) => merged.add(view));
      return;
    }
    if (track.image_view) {
      merged.add(track.image_view);
    }
  });
  return [...merged];
}

function interpolateTrackState(before: TrackRecord, after: TrackRecord, targetTime: number): TrackRecord {
  const duration = after.time - before.time;
  if (duration <= 1e-6) {
    return {
      ...after,
      time: targetTime,
      source_views: mergeTrackViews(before, after),
    };
  }

  const t = Math.min(Math.max((targetTime - before.time) / duration, 0), 1);
  const nearest = t <= 0.5 ? before : after;
  return {
    ...nearest,
    time: targetTime,
    x: before.x + ((after.x - before.x) * t),
    y: before.y + ((after.y - before.y) * t),
    confidence: before.confidence + ((after.confidence - before.confidence) * t),
    source_views: mergeTrackViews(before, after),
    source_detection_indices: [...new Set([...before.source_detection_indices, ...after.source_detection_indices])].sort((a, b) => a - b),
    image_anchor: null,
    image_bbox: null,
  };
}

function mergeVisibleTrackViews(primary: TrackRecord, secondary: TrackRecord): TrackRecord {
  return {
    ...primary,
    source_views: [...new Set([...(primary.source_views ?? []), ...(secondary.source_views ?? [])])],
    source_detection_indices: [...new Set([...(primary.source_detection_indices ?? []), ...(secondary.source_detection_indices ?? [])])].sort((a, b) => a - b),
  };
}

function dedupeVisibleTracks(tracks: TrackRecord[]): TrackRecord[] {
  const preferred = [...tracks].sort((left, right) => {
    const leftDetection = left.tracking_source === "detection" ? 1 : 0;
    const rightDetection = right.tracking_source === "detection" ? 1 : 0;
    if (leftDetection !== rightDetection) return rightDetection - leftDetection;
    if (left.confidence !== right.confidence) return right.confidence - left.confidence;
    return left.track_id - right.track_id;
  });

  const deduped: TrackRecord[] = [];
  for (const track of preferred) {
    const existingIndex = deduped.findIndex((kept) => (
      kept.track_id === track.track_id || (
        kept.tracking_source === "detection" &&
        track.tracking_source === "detection" &&
        Math.hypot(track.x - kept.x, track.y - kept.y) <= TRACK_SWITCH_DEDUPE_DISTANCE_IN
      )
    ));

    if (existingIndex === -1) {
      deduped.push(track);
      continue;
    }

    deduped[existingIndex] = mergeVisibleTrackViews(deduped[existingIndex], track);
  }

  return deduped.sort((a, b) => a.track_id - b.track_id);
}

type VideoFrameSyncVideo = HTMLVideoElement & {
  requestVideoFrameCallback?: (callback: VideoFrameRequestCallback) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
};

export default function UnifiedMatchConsole() {
  const router = useRouter();
  const [jobs, setJobs] = useState<JobRecord[]>([]);
  const [matches, setMatches] = useState<MatchSummary[]>([]);
  const [calibrationPresets, setCalibrationPresets] = useState<CalibrationPreset[]>([]);
  const [selectedMatchId, setSelectedMatchId] = useState<string | null>(null);
  const [selectedMatch, setSelectedMatch] = useState<MatchRecord | null>(null);
  const [watchbot, setWatchbot] = useState<WatchbotState | null>(null);
  const [matchName, setMatchName] = useState("");
  const [youtubeUrl, setYoutubeUrl] = useState("");
  const [watchbotUrl, setWatchbotUrl] = useState("");
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [selectedCalibrationPresetId, setSelectedCalibrationPresetId] = useState<string>("");
  const [calibrateBeforeProcessing, setCalibrateBeforeProcessing] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [videoError, setVideoError] = useState<string | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [videoDuration, setVideoDuration] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackSpeed, setPlaybackSpeed] = useState(1);
  const [videoMode, setVideoMode] = useState<"source" | "annotated">("source");
  const [labelDrafts, setLabelDrafts] = useState<Record<string, string>>({});
  const [selectedTrackId, setSelectedTrackId] = useState<number | null>(null);
  const [matchSearch, setMatchSearch] = useState("");
  const [teamSearch, setTeamSearch] = useState("");
  const [scheduleYear, setScheduleYear] = useState<number>(2025);
  const [teamSchedule, setTeamSchedule] = useState<TbaMatch[]>([]);
  const [teamScheduleError, setTeamScheduleError] = useState<string | null>(null);
  const [selectedEvent, setSelectedEvent] = useState<string>("All Events");
  const [selectedCompLevel, setSelectedCompLevel] = useState<string>("all");
  const [heatmapTeam, setHeatmapTeam] = useState<string>("all");
  const [visibleMapViews, setVisibleMapViews] = useState<Record<(typeof VIEW_ORDER)[number], boolean>>({
    left: true,
    main: true,
    right: true,
  });
  const [stageMode, setStageMode] = useState<"match" | "field">("match");
  const [explorerOpen, setExplorerOpen] = useState(true);
  const [inspectorOpen, setInspectorOpen] = useState(true);

  const videoRef = useRef<HTMLVideoElement>(null);
  const combinedFieldCanvasRef = useRef<HTMLCanvasElement>(null);
  const fuelFieldImageRef = useRef<HTMLImageElement | null>(null);
  const airProfileCanvasRef = useRef<HTMLCanvasElement>(null);

  const [fuelFieldImageVersion, setFuelFieldImageVersion] = useState(0);
  const [fuelCalibration, setFuelCalibration] = useState<FuelCalibration | null>(null);
  const [fuelAnalysis, setFuelAnalysis] = useState<FuelAnalysisRecord | null>(null);
  const [fieldMapData, setFieldMapData] = useState<FieldMapData | null>(null);
  const [airProfileData, setAirProfileData] = useState<AirProfileData | null>(null);
  const [fuelArtifactsError, setFuelArtifactsError] = useState<string | null>(null);
  const [fuelProcessing, setFuelProcessing] = useState(false);

  useEffect(() => {
    const image = new window.Image();
    image.onload = () => setFuelFieldImageVersion((v) => v + 1);
    image.src = FUEL_FIELD_IMAGE_SRC;
    fuelFieldImageRef.current = image;
  }, []);

  const syncFuelState = useCallback(async (matchId: string | null) => {
    if (!matchId) {
      setFuelCalibration(null);
      setFuelAnalysis(null);
      return;
    }
    try {
      const fuel = await fetchFuelState(matchId);
      setFuelCalibration(fuel.fuel_calibration);
      setFuelAnalysis(fuel.fuel_analysis);
    } catch {
      setFuelCalibration(null);
      setFuelAnalysis(null);
    }
  }, []);

  const applySelectedMatch = useCallback((matchId: string | null, match: MatchRecord | null, resetView = false) => {
    setSelectedMatchId(matchId);
    setSelectedMatch(match);
    setLabelDrafts(match?.labels ?? {});
    if (resetView) {
      setHeatmapTeam("all");
      setSelectedTrackId(null);
      setVideoMode("source");
      setVideoDuration(0);
      setCurrentTime(0);
      setVideoError(null);
    }
  }, []);

  const refreshDashboard = useCallback(async (preferredMatchId?: string | null) => {
    const [jobItems, matchItems, presetItems, watchbotState] = await Promise.all([
      fetchJobs(),
      fetchMatches(),
      fetchCalibrationPresets(),
      fetchWatchbot().then((response) => response.watchbot),
    ]);
    setJobs(jobItems);
    setMatches(matchItems);
    setCalibrationPresets(presetItems);
    setWatchbot(watchbotState);

    const availableMatchIds = new Set(matchItems.map((match) => match.id));
    const preferredTargetMatchId = preferredMatchId ?? selectedMatchId ?? null;
    const targetMatchId = (
      preferredTargetMatchId && availableMatchIds.has(preferredTargetMatchId)
        ? preferredTargetMatchId
        : matchItems[0]?.id
    ) ?? null;

    if (targetMatchId) {
      try {
        const match = await fetchMatch(targetMatchId);
        applySelectedMatch(targetMatchId, match, targetMatchId !== selectedMatchId);
        await syncFuelState(targetMatchId);
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) {
          const fallbackMatchId = matchItems.find((match) => match.id !== targetMatchId)?.id ?? null;
          if (fallbackMatchId) {
            const fallbackMatch = await fetchMatch(fallbackMatchId);
            applySelectedMatch(fallbackMatchId, fallbackMatch, true);
            await syncFuelState(fallbackMatchId);
            return;
          }
          applySelectedMatch(null, null, true);
          await syncFuelState(null);
          return;
        }
        throw error;
      }
    } else {
      applySelectedMatch(null, null, true);
      await syncFuelState(null);
    }
  }, [applySelectedMatch, selectedMatchId, syncFuelState]);

  useEffect(() => {
    const kickoff = window.setTimeout(() => {
      refreshDashboard().catch((error: Error) => setStatusMessage(error.message));
    }, 0);
    const interval = window.setInterval(() => {
      refreshDashboard().catch(() => undefined);
    }, 5000);
    return () => {
      window.clearTimeout(kickoff);
      window.clearInterval(interval);
    };
  }, [refreshDashboard]);

  useEffect(() => {
    const video = videoRef.current as VideoFrameSyncVideo | null;
    if (!video) return;

    let animationFrameId: number | null = null;
    let videoFrameCallbackId: number | null = null;

    const updateCurrentTime = (nextTime?: number) => {
      setCurrentTime(nextTime ?? video.currentTime ?? 0);
    };

    const stopFrameSync = () => {
      if (animationFrameId !== null) {
        window.cancelAnimationFrame(animationFrameId);
        animationFrameId = null;
      }
      if (videoFrameCallbackId !== null && typeof video.cancelVideoFrameCallback === "function") {
        video.cancelVideoFrameCallback(videoFrameCallbackId);
        videoFrameCallbackId = null;
      }
    };

    const startFrameSync = () => {
      stopFrameSync();
      updateCurrentTime();

      if (typeof video.requestVideoFrameCallback === "function") {
        const handleFrame: VideoFrameRequestCallback = (_now, metadata) => {
          updateCurrentTime(metadata.mediaTime);
          if (!video.paused && !video.ended) {
            videoFrameCallbackId = video.requestVideoFrameCallback!(handleFrame);
          }
        };
        videoFrameCallbackId = video.requestVideoFrameCallback(handleFrame);
        return;
      }

      const tick = () => {
        updateCurrentTime();
        if (!video.paused && !video.ended) {
          animationFrameId = window.requestAnimationFrame(tick);
        }
      };
      animationFrameId = window.requestAnimationFrame(tick);
    };

    const onTimeUpdate = () => updateCurrentTime();
    const onPlay = () => startFrameSync();
    const onPause = () => {
      updateCurrentTime();
      stopFrameSync();
    };
    const onEnded = () => setIsPlaying(false);
    const onLoadedMetadata = () => {
      setVideoDuration(video.duration || 0);
      updateCurrentTime();
    };
    const onSeeked = () => updateCurrentTime();

    video.addEventListener("timeupdate", onTimeUpdate);
    video.addEventListener("play", onPlay);
    video.addEventListener("pause", onPause);
    video.addEventListener("ended", onEnded);
    video.addEventListener("loadedmetadata", onLoadedMetadata);
    video.addEventListener("seeked", onSeeked);
    video.addEventListener("seeking", onSeeked);

    if (!video.paused && !video.ended) {
      startFrameSync();
    } else {
      updateCurrentTime();
    }

    return () => {
      stopFrameSync();
      video.removeEventListener("timeupdate", onTimeUpdate);
      video.removeEventListener("play", onPlay);
      video.removeEventListener("pause", onPause);
      video.removeEventListener("ended", onEnded);
      video.removeEventListener("loadedmetadata", onLoadedMetadata);
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("seeking", onSeeked);
    };
  }, [selectedMatch?.id]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.playbackRate = playbackSpeed;
    if (isPlaying) void video.play();
    else video.pause();
  }, [isPlaying, playbackSpeed, selectedMatch?.id]);

  const enrichedMatches = useMemo(
    () => matches.map((match) => ({ match, ...parseMatchMetadata(match) })),
    [matches],
  );

  const eventNames = useMemo(
    () => ["All Events", ...new Set(enrichedMatches.map((entry) => entry.eventName))],
    [enrichedMatches],
  );

  const filteredMatches = useMemo(() => {
    const query = matchSearch.trim().toLowerCase();
    const teamQuery = teamSearch.trim().toLowerCase();
    return enrichedMatches.filter(({ match, displayName, eventName, compLevel }) => {
      if (selectedEvent !== "All Events" && eventName !== selectedEvent) return false;
      if (selectedCompLevel !== "all" && compLevel !== selectedCompLevel) return false;
      if (query && !displayName.toLowerCase().includes(query)) return false;
      if (teamQuery) {
        const labels = Object.values(match.labels).map((value) => value.toLowerCase());
        if (!labels.some((value) => value.includes(teamQuery))) return false;
      }
      return true;
    });
  }, [enrichedMatches, matchSearch, selectedCompLevel, selectedEvent, teamSearch]);

  const usableTracks = useMemo(() => {
    if (!selectedMatch) return [];
    return selectedMatch.tracks.filter(isTrackOnField);
  }, [selectedMatch]);

  const tracksById = useMemo(() => {
    const grouped = new Map<number, TrackRecord[]>();
    for (const track of usableTracks) {
      const bucket = grouped.get(track.track_id) ?? [];
      bucket.push(track);
      grouped.set(track.track_id, bucket);
    }
    for (const bucket of grouped.values()) {
      bucket.sort((a, b) => a.time - b.time);
    }
    return grouped;
  }, [usableTracks]);

  const trackUsesVisibleView = useCallback((track: TrackRecord) => {
    const candidateViews = track.source_views.length > 0
      ? track.source_views
      : track.image_view
        ? [track.image_view]
        : VIEW_ORDER;
    return candidateViews.some((view) => visibleMapViews[view]);
  }, [visibleMapViews]);

  const playbackFrameInterval = useMemo(() => {
    const fps = Number(selectedMatch?.metadata.fps ?? selectedMatch?.metadata.source_fps ?? 0);
    if (Number.isFinite(fps) && fps > 0) {
      return 1 / fps;
    }
    return 1 / 20;
  }, [selectedMatch]);

  const trackInterpolationGap = useMemo(
    () => Math.max(TRACK_INTERPOLATION_MAX_GAP_SECONDS, playbackFrameInterval * 8),
    [playbackFrameInterval],
  );

  const trackHoldGap = useMemo(
    () => Math.max(TRACK_HOLD_MAX_GAP_SECONDS, playbackFrameInterval * 12),
    [playbackFrameInterval],
  );

  const visibleTracks = useMemo(() => {
    if (!tracksById.size) return [];

    const currentTracks: TrackRecord[] = [];
    for (const bucket of tracksById.values()) {
      let before: TrackRecord | null = null;
      let after: TrackRecord | null = null;

      for (const track of bucket) {
        if (track.time <= currentTime) {
          before = track;
          continue;
        }
        after = track;
        break;
      }

      if (before && after) {
        const gap = after.time - before.time;
        if (gap <= trackInterpolationGap && before.time <= currentTime && currentTime <= after.time) {
          currentTracks.push(interpolateTrackState(before, after, currentTime));
          continue;
        }
      }

      if (before && currentTime >= before.time && currentTime - before.time <= trackHoldGap) {
        currentTracks.push({
          ...before,
          time: currentTime,
        });
        continue;
      }

      if (after && after.time >= currentTime && after.time - currentTime <= trackHoldGap) {
        currentTracks.push({
          ...after,
          time: currentTime,
        });
        continue;
      }

      const nearestCandidates = [before, after].filter((track): track is TrackRecord => track !== null);
      if (nearestCandidates.length === 0) {
        continue;
      }

      const nearest = nearestCandidates.reduce((best, candidate) => (
        Math.abs(candidate.time - currentTime) < Math.abs(best.time - currentTime) ? candidate : best
      ));

      if (Math.abs(nearest.time - currentTime) <= Math.max(TRACK_SNAPSHOT_TOLERANCE_SECONDS, playbackFrameInterval * 2)) {
        currentTracks.push({
          ...nearest,
          time: currentTime,
        });
      }
    }

    return dedupeVisibleTracks(currentTracks);
  }, [currentTime, playbackFrameInterval, trackHoldGap, trackInterpolationGap, tracksById]);

  const uniqueTrackIds = useMemo(
    () => [...new Set(usableTracks.map((track) => track.track_id))].sort((a, b) => a - b),
    [usableTracks],
  );

  const labeledTeams = useMemo(
    () => ["all", ...new Set(Object.values(selectedMatch?.labels ?? {}).filter(Boolean))],
    [selectedMatch],
  );

  const heatmapTracks = useMemo(() => {
    if (!selectedMatch || heatmapTeam === "all") return [];
    const trackIds = Object.entries(selectedMatch.labels)
      .filter(([, label]) => label === heatmapTeam)
      .map(([trackId]) => Number(trackId));
    return usableTracks.filter((track) => trackIds.includes(track.track_id));
  }, [heatmapTeam, selectedMatch, usableTracks]);

  const visibleDetections = useMemo(() => {
    if (!selectedMatch) return [];
    const grouped = new Map<string, { time: number; detections: typeof selectedMatch.detections }>();

    for (const detection of selectedMatch.detections) {
      if (!visibleMapViews[detection.view]) continue;
      if (!isTrackOnField({ x: detection.field_point[0], y: detection.field_point[1] })) continue;

      const key = `${detection.frame}:${detection.time}`;
      const bucket = grouped.get(key);
      if (bucket) {
        bucket.detections.push(detection);
      } else {
        grouped.set(key, {
          time: detection.time,
          detections: [detection],
        });
      }
    }

    if (!grouped.size) return [];

    const nearestFrame = [...grouped.values()].reduce((best, candidate) => (
      Math.abs(candidate.time - currentTime) < Math.abs(best.time - currentTime) ? candidate : best
    ));

    const tolerance = Math.max(DETECTION_SNAPSHOT_TOLERANCE_SECONDS, playbackFrameInterval * 1.5);
    if (Math.abs(nearestFrame.time - currentTime) > tolerance) {
      return [];
    }

    return nearestFrame.detections;
  }, [currentTime, playbackFrameInterval, selectedMatch, visibleMapViews]);

  const visibleHeatmapTracks = useMemo(
    () => heatmapTracks.filter(trackUsesVisibleView),
    [heatmapTracks, trackUsesVisibleView],
  );

  const visibleTracksOnMap = useMemo(
    () => visibleTracks.filter(trackUsesVisibleView),
    [visibleTracks, trackUsesVisibleView],
  );

  const visibleTrackHistory = useMemo(() => {
    const historyByTrack = new Map<number, TrackRecord[]>();
    usableTracks
      .filter((track) => track.time <= currentTime && currentTime - track.time <= 4)
      .filter(trackUsesVisibleView)
      .forEach((track) => {
        const bucket = historyByTrack.get(track.track_id) ?? [];
        bucket.push(track);
        historyByTrack.set(track.track_id, bucket);
      });
    return historyByTrack;
  }, [currentTime, trackUsesVisibleView, usableTracks]);

  const playableVideoUrl = useMemo(() => {
    if (!selectedMatch) return null;
    if (videoMode === "annotated") {
      return resolveArtifactUrl(selectedMatch.artifacts.annotated_video ?? selectedMatch.artifacts.source_video);
    }
    return resolveArtifactUrl(selectedMatch.artifacts.source_video ?? selectedMatch.artifacts.annotated_video);
  }, [selectedMatch, videoMode]);

  const selectedSummary = useMemo(
    () => matches.find((match) => match.id === selectedMatchId) ?? null,
    [matches, selectedMatchId],
  );

  const recentJobs = useMemo(() => jobs.slice(0, 8), [jobs]);

  const airProfileForViz = useMemo(
    () => airProfileData ?? airProfileFromFieldMap(fieldMapData),
    [airProfileData, fieldMapData],
  );

  const fieldMapArtifactUrl = useMemo(
    () => resolveArtifactUrl(fuelAnalysis?.artifacts?.field_map),
    [fuelAnalysis],
  );
  const airProfileArtifactUrl = useMemo(
    () => resolveArtifactUrl(fuelAnalysis?.artifacts?.air_profile),
    [fuelAnalysis],
  );

  const fuelOverlayTiming = useMemo(() => {
    const stats = fuelAnalysis?.stats as Record<string, unknown> | undefined;
    const overlayFps = Number(stats?.overlayFps ?? 30) || 30;
    const overlayFrameCount = Number(stats?.overlayFrameCount ?? 0) || 0;
    return { overlayFps, overlayFrameCount };
  }, [fuelAnalysis]);

  const fuelFrameIndex = useMemo(() => {
    if (!fieldMapData?.frames?.length) {
      return 0;
    }
    const len = fieldMapData.frames.length;
    const cap =
      fuelOverlayTiming.overlayFrameCount > 0
        ? Math.min(len, fuelOverlayTiming.overlayFrameCount)
        : len;
    const max = Math.max(0, cap - 1);
    const idx = Math.floor(currentTime * fuelOverlayTiming.overlayFps);
    return Math.max(0, Math.min(max, idx));
  }, [currentTime, fieldMapData, fuelOverlayTiming]);

  useEffect(() => {
    setFieldMapData(null);
    setFuelArtifactsError(null);
    if (!fieldMapArtifactUrl) {
      return;
    }
    let cancelled = false;
    void fetchJsonFieldMap(fieldMapArtifactUrl)
      .then((data) => {
        if (!cancelled) {
          setFieldMapData(data);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setFuelArtifactsError(err instanceof Error ? err.message : "Could not load field map JSON.");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [fieldMapArtifactUrl]);

  useEffect(() => {
    setAirProfileData(null);
    if (!airProfileArtifactUrl) {
      return;
    }
    let cancelled = false;
    void fetchJsonAirProfile(airProfileArtifactUrl)
      .then((data) => {
        if (!cancelled) {
          setAirProfileData(data);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setAirProfileData(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [airProfileArtifactUrl]);

  useLayoutEffect(() => {
    if (stageMode !== "field") {
      return;
    }
    const canvas = combinedFieldCanvasRef.current;
    if (!canvas) {
      return;
    }
    const render = () => {
      drawCombinedFieldFrame(
        canvas,
        fuelFieldImageRef.current,
        fieldMapData,
        airProfileForViz,
        fuelFrameIndex,
        {
          labels: selectedMatch?.labels ?? {},
          selectedTrackId,
          heatmapTracks: visibleHeatmapTracks,
          visibleDetections,
          visibleTrackHistory,
          visibleTracksOnMap,
        },
      );
    };
    render();
    const resizeTarget = canvas.parentElement ?? canvas;
    const resizeObserver = new ResizeObserver(() => {
      requestAnimationFrame(render);
    });
    resizeObserver.observe(resizeTarget);
    return () => resizeObserver.disconnect();
  }, [
    stageMode,
    fieldMapData,
    airProfileForViz,
    fuelFrameIndex,
    fuelFieldImageVersion,
    selectedMatch?.labels,
    selectedTrackId,
    visibleHeatmapTracks,
    visibleDetections,
    visibleTrackHistory,
    visibleTracksOnMap,
  ]);

  useEffect(() => {
    const canvas = airProfileCanvasRef.current;
    if (!canvas || !airProfileForViz || stageMode !== "field") {
      return;
    }
    const render = () => {
      drawAirProfileFrame(canvas, airProfileForViz, fuelFrameIndex);
    };
    render();
    const resizeObserver = new ResizeObserver(render);
    resizeObserver.observe(canvas);
    return () => resizeObserver.disconnect();
  }, [airProfileForViz, fuelFrameIndex, stageMode]);

  function toggleMapView(view: (typeof VIEW_ORDER)[number]) {
    setVisibleMapViews((current) => {
      const enabledCount = VIEW_ORDER.filter((name) => current[name]).length;
      if (current[view] && enabledCount === 1) {
        return current;
      }
      return {
        ...current,
        [view]: !current[view],
      };
    });
  }

  async function handleSourceSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      const formData = new FormData();
      if (pendingFile) formData.set("file", pendingFile);
      if (youtubeUrl.trim()) formData.set("youtube_url", youtubeUrl.trim());
      if (matchName.trim()) formData.set("match_name", matchName.trim());
      if (selectedCalibrationPresetId) formData.set("calibration_preset_id", selectedCalibrationPresetId);
      if (calibrateBeforeProcessing) formData.set("calibrate_first", "true");
      const response = await createSourceJob(formData);
      setVideoError(null);
      if (response.match) {
        setStatusMessage(`Created calibration draft ${response.match.id}.`);
        await refreshDashboard(response.match.id);
        router.push(`/calibrate?match=${response.match.id}`);
        return;
      }
      if (!response.job) {
        throw new Error("Backend did not return a job or match draft.");
      }
      setStatusMessage(`Queued job ${response.job.id}`);
      setPendingFile(null);
      setYoutubeUrl("");
      setMatchName("");
      setSelectedCalibrationPresetId("");
      setCalibrateBeforeProcessing(false);
      await refreshDashboard(response.job.match_id ?? undefined);
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : "Failed to queue source.");
    }
  }

  async function handleSaveLabels() {
    if (!selectedMatch) return;
    try {
      await updateMatchLabels(selectedMatch.id, labelDrafts);
      await refreshDashboard(selectedMatch.id);
      setStatusMessage("Saved track labels.");
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : "Failed to save labels.");
    }
  }

  async function handleWatchbotStart() {
    if (!watchbotUrl.trim()) return;
    try {
      const response = await startWatchbot(watchbotUrl.trim());
      setWatchbot(response.watchbot);
      setStatusMessage("Watchbot armed.");
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : "Failed to start watchbot.");
    }
  }

  async function handleWatchbotStop() {
    try {
      const response = await stopWatchbot();
      setWatchbot(response.watchbot);
      setStatusMessage("Watchbot stopped.");
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : "Failed to stop watchbot.");
    }
  }

  async function handleTeamScheduleLookup() {
    if (!teamSearch.trim()) return;
    try {
      const response = await fetchTeamSchedule(teamSearch.trim(), scheduleYear);
      setTeamSchedule(response.matches);
      setTeamScheduleError(null);
    } catch (error) {
      setTeamSchedule([]);
      setTeamScheduleError(error instanceof Error ? error.message : "Failed to load TBA schedule.");
    }
  }

  async function handleDeleteMatch(matchId: string) {
    try {
      setMatches((current) => current.filter((match) => match.id !== matchId));
      setJobs((current) => current.filter((job) => job.match_id !== matchId));
      await deleteMatch(matchId);
      setStatusMessage("Deleted stored match.");
      const deletingSelected = selectedMatchId === matchId;
      if (deletingSelected) {
        applySelectedMatch(null, null, true);
      }
      const fallbackMatchId = deletingSelected ? undefined : selectedMatchId ?? undefined;
      await refreshDashboard(fallbackMatchId);
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : "Failed to delete match.");
    }
  }

  async function handleDeleteJob(jobId: string) {
    try {
      const linkedMatchId = jobs.find((job) => job.id === jobId)?.match_id ?? null;
      setJobs((current) => current.filter((job) => job.id !== jobId && job.match_id !== linkedMatchId));
      if (linkedMatchId) {
        setMatches((current) => current.filter((match) => match.id !== linkedMatchId));
        if (selectedMatchId === linkedMatchId) {
          applySelectedMatch(null, null, true);
        }
      }
      await deleteJob(jobId);
      setStatusMessage("Deleted job record.");
      await refreshDashboard(selectedMatchId);
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : "Failed to delete job.");
    }
  }

  async function handleProcessFuel() {
    if (!selectedMatchId) return;
    try {
      setFuelProcessing(true);
      const response = await processFuel(selectedMatchId);
      setFuelCalibration(response.fuel_calibration);
      setFuelAnalysis(response.fuel_analysis);
      setStatusMessage("Fuel processing finished.");
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : "Fuel processing failed.");
    } finally {
      setFuelProcessing(false);
    }
  }

  const matchTitle = selectedSummary ? parseMatchMetadata(selectedSummary).displayName : "No match";
  const matchStatusDot =
    selectedMatch?.metadata.status === "completed" || selectedMatch?.metadata.status === "ready"
      ? "bg-[var(--desk-success)]"
      : selectedMatch?.metadata.status === "processing" || selectedMatch?.metadata.status === "running"
        ? "bg-[var(--desk-warn)]"
        : selectedMatch?.metadata.status === "error" || selectedMatch?.metadata.status === "failed"
          ? "bg-[var(--desk-danger)]"
          : "bg-[var(--desk-text-faint)]";

  return (
    <div className="desk-root desk-root--viewport-lock text-[var(--desk-text)]">
      <header className="desk-titlebar">
        <div className="desk-titlebar-brand">
          <span className="desk-logo" aria-hidden />
          <div className="min-w-0">
            <p className="desk-kicker">FRC Strat · Workbench</p>
            <p className="desk-titlebar-title truncate font-medium">{matchTitle}</p>
          </div>
        </div>
        <div className="desk-titlebar-center hidden md:flex">
          <span className={`h-2 w-2 shrink-0 rounded-full shadow-[0_0_0_2px_rgba(0,0,0,0.35)] ${matchStatusDot}`} title="Match status" />
          <span className="truncate text-[13px] text-[var(--desk-text-muted)]">
            {matches.length} matches · {jobs.length} jobs · fuel {fuelAnalysis?.status ?? "—"} · watchbot{" "}
            {watchbot?.active ? "armed" : "idle"}
          </span>
        </div>
        <div className="desk-titlebar-actions">
          {statusMessage ? (
            <div className="desk-toast max-w-[min(42vw,360px)] truncate" title={statusMessage}>
              {statusMessage}
            </div>
          ) : null}
          <button
            type="button"
            className="desk-btn desk-btn--ghost text-[12px] max-xl:hidden"
            title={explorerOpen ? "Hide match explorer" : "Show match explorer"}
            aria-pressed={explorerOpen}
            onClick={() => setExplorerOpen((open) => !open)}
          >
            {explorerOpen ? "◀ Explorer" : "Explorer ▶"}
          </button>
          <button
            type="button"
            className="desk-btn desk-btn--ghost text-[12px] max-xl:hidden"
            title={inspectorOpen ? "Hide right inspector" : "Show right inspector"}
            aria-pressed={inspectorOpen}
            onClick={() => setInspectorOpen((open) => !open)}
          >
            {inspectorOpen ? "Inspect ◀" : "▶ Inspect"}
          </button>
          <button
            type="button"
            className="desk-btn desk-btn--ghost text-[12px]"
            onClick={() => refreshDashboard().catch((error: Error) => setStatusMessage(error.message))}
          >
            Refresh
          </button>
          <Link href={selectedMatchId ? `/calibrate?match=${selectedMatchId}` : "/calibrate"} className="desk-btn desk-btn--ghost text-[12px]">
            Calibrate
          </Link>
          <Link href={selectedMatchId ? `/fuel?match=${selectedMatchId}` : "/fuel"} className="desk-btn desk-btn--accent text-[12px]">
            Fuel lab
          </Link>
        </div>
      </header>

      <div className="desk-workspace">
        <nav className="desk-rail" aria-label="Primary">
          <div className="desk-rail-spacer" />
          <span className="desk-rail-icon text-[10px] font-semibold tracking-tight" title="Matches">
            M
          </span>
          <span className="desk-rail-icon text-[10px] text-[var(--desk-text-faint)]" title="Jobs">
            J
          </span>
          <button
            type="button"
            className="desk-rail-toggle mt-1"
            title={explorerOpen ? "Collapse explorer" : "Expand explorer"}
            aria-expanded={explorerOpen}
            aria-label={explorerOpen ? "Collapse match explorer" : "Expand match explorer"}
            onClick={() => setExplorerOpen((open) => !open)}
          >
            {explorerOpen ? "‹" : "›"}
          </button>
          <button
            type="button"
            className="desk-rail-toggle"
            title={inspectorOpen ? "Collapse inspector" : "Expand inspector"}
            aria-expanded={inspectorOpen}
            aria-label={inspectorOpen ? "Collapse timeline inspector" : "Expand timeline inspector"}
            onClick={() => setInspectorOpen((open) => !open)}
          >
            {inspectorOpen ? "›" : "‹"}
          </button>
        </nav>

        <aside className={`desk-sidebar${explorerOpen ? "" : " desk-sidebar--collapsed"}`} aria-hidden={!explorerOpen}>
          <div className="desk-sidebar-inner">
            <section className="desk-card">
              <p className="desk-section-label">Explorer</p>
              <p className="mt-2 text-[11px] leading-snug text-white/40">Matches live under <span className="font-mono text-white/55">backend/data</span>.</p>
              <div className="mt-4 space-y-3">
                <input value={matchSearch} onChange={(event) => setMatchSearch(event.target.value)} placeholder="Search analyzed matches" className="w-full border-b border-white/15 bg-transparent px-1 py-3 text-sm outline-none placeholder:text-white/35" />
                <input value={teamSearch} onChange={(event) => setTeamSearch(event.target.value)} placeholder="Team number search" className="w-full border-b border-white/15 bg-transparent px-1 py-3 text-sm outline-none placeholder:text-white/35" />
                <div className="grid grid-cols-[1fr_auto] gap-3">
                  <div className="relative">
                    <select value={selectedCompLevel} onChange={(event) => setSelectedCompLevel(event.target.value)} className={`w-full ${SELECT_CLASS}`}>
                      <option value="all">All match types</option>
                      <option value="qual">Qual</option>
                      <option value="practice">Practice</option>
                      <option value="playoff">Playoff</option>
                      <option value="final">Final</option>
                      <option value="match">Match</option>
                    </select>
                    <span className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-white/50">⌄</span>
                  </div>
                  <button onClick={handleTeamScheduleLookup} className="rounded-2xl border border-white/10 px-4 py-3 text-sm hover:bg-white/10">
                    TBA
                  </button>
                </div>
              </div>

              <div className="mt-5 flex flex-wrap gap-2">
                {eventNames.map((eventName) => (
                  <button
                    key={eventName}
                    onClick={() => setSelectedEvent(eventName)}
                    className={`rounded-full px-3 py-1.5 text-xs transition ${
                      selectedEvent === eventName
                        ? "bg-emerald-400 text-slate-950"
                        : "border border-white/10 bg-white/5 text-white/70 hover:bg-white/10"
                    }`}
                  >
                    {eventName}
                  </button>
                ))}
              </div>

              <div className="mt-5 max-h-[min(40dvh,380px)] space-y-2 overflow-auto pr-1">
                {filteredMatches.map(({ match, displayName, eventName, compLevel }) => (
                  <div
                    key={match.id}
                    className={`w-full border-l-2 px-3 py-3 transition ${
                      selectedMatchId === match.id
                        ? "border-emerald-300 bg-emerald-300/8"
                        : "border-white/10 bg-white/[0.03] hover:bg-white/[0.06]"
                    }`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <button
                        onClick={async () => {
                          setSelectedMatchId(match.id);
                          const fullMatch = await fetchMatch(match.id);
                          applySelectedMatch(match.id, fullMatch, match.id !== selectedMatchId);
                          await syncFuelState(match.id);
                        }}
                        className="min-w-0 flex-1 text-left"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-medium">{displayName}</span>
                          <span className="text-[11px] uppercase tracking-[0.2em] text-white/40">{compLevel}</span>
                        </div>
                        <p className="mt-1 text-xs text-white/45">{eventName}</p>
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleDeleteMatch(match.id)}
                        className="rounded-full border border-white/10 px-2 py-1 text-[10px] uppercase tracking-[0.15em] text-white/50 hover:border-rose-300/30 hover:bg-rose-300/10 hover:text-rose-100"
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                ))}
                {filteredMatches.length === 0 ? <p className="text-sm text-white/40">No analyzed matches match these filters.</p> : null}
              </div>
            </section>

            <section className="rounded-[28px] border border-white/10 bg-white/[0.03] p-5">
              <p className="text-xs uppercase tracking-[0.28em] text-white/45">Queue Source</p>
              <form className="mt-4 space-y-4" onSubmit={handleSourceSubmit}>
                <input value={matchName} onChange={(event) => setMatchName(event.target.value)} placeholder="Optional match name" className="w-full border-b border-white/15 bg-transparent px-1 py-3 text-sm outline-none placeholder:text-white/35" />
                <input value={youtubeUrl} onChange={(event) => setYoutubeUrl(event.target.value)} placeholder="YouTube URL" className="w-full border-b border-white/15 bg-transparent px-1 py-3 text-sm outline-none placeholder:text-white/35" />
                <div className="space-y-2">
                  <p className="text-[11px] uppercase tracking-[0.2em] text-white/45">Calibration Preset</p>
                  <div className="relative">
                    <select value={selectedCalibrationPresetId} onChange={(event) => setSelectedCalibrationPresetId(event.target.value)} className={`w-full ${SELECT_CLASS}`}>
                      <option value="">Default calibration</option>
                      {calibrationPresets.map((preset) => (
                        <option key={preset.id} value={preset.id}>{preset.name}</option>
                      ))}
                    </select>
                    <span className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-white/50">⌄</span>
                  </div>
                  <p className="text-xs text-white/45">Pick a saved calibration before processing so the match only runs once.</p>
                </div>
                <label className="flex items-center justify-between rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3 text-sm text-white/75">
                  <span>Calibrate this match before processing</span>
                  <input type="checkbox" checked={calibrateBeforeProcessing} onChange={(event) => setCalibrateBeforeProcessing(event.target.checked)} className="h-4 w-4 accent-emerald-300" />
                </label>
                <label className="flex cursor-pointer items-center justify-between rounded-2xl border border-dashed border-white/15 bg-white/5 px-4 py-4 text-sm text-white/70 hover:border-emerald-300/35 hover:bg-white/8">
                  <span>{pendingFile ? pendingFile.name : "Choose local match video"}</span>
                  <span className="rounded-full bg-white/10 px-3 py-1 text-xs">Browse</span>
                  <input type="file" accept="video/*" className="hidden" onChange={(event) => setPendingFile(event.target.files?.[0] ?? null)} />
                </label>
                <button type="submit" disabled={!pendingFile && !youtubeUrl.trim()} className="w-full rounded-2xl bg-emerald-400 px-4 py-3 text-sm font-semibold text-slate-950 disabled:cursor-not-allowed disabled:bg-white/15 disabled:text-white/50">
                  Create Processing Job
                </button>
              </form>
            </section>

            <section className="rounded-[28px] border border-white/10 bg-white/[0.03] p-5">
              <p className="text-xs uppercase tracking-[0.28em] text-white/45">Watchbot + TBA</p>
              <div className="mt-4 space-y-3">
                <input value={watchbotUrl} onChange={(event) => setWatchbotUrl(event.target.value)} placeholder="Live YouTube stream URL" className="w-full border-b border-white/15 bg-transparent px-1 py-3 text-sm outline-none placeholder:text-white/35" />
                <div className="flex gap-3">
                  <button onClick={handleWatchbotStart} className="flex-1 rounded-2xl border border-white/10 px-4 py-3 text-sm hover:bg-white/10">Start</button>
                  <button onClick={handleWatchbotStop} className="flex-1 rounded-2xl border border-white/10 px-4 py-3 text-sm hover:bg-white/10">Stop</button>
                </div>
                <div className="flex gap-3">
                  <input type="number" value={scheduleYear} onChange={(event) => setScheduleYear(Number(event.target.value))} className={`w-28 ${INPUT_CLASS}`} />
                  <button onClick={handleTeamScheduleLookup} className="rounded-2xl border border-white/10 px-4 py-3 text-sm hover:bg-white/10">
                    Load Team Schedule
                  </button>
                </div>
                {teamScheduleError ? <p className="text-sm text-amber-200">{teamScheduleError}</p> : null}
                {teamSchedule.length > 0 ? (
                  <div className="max-h-56 space-y-2 overflow-auto pr-1 text-sm text-white/70">
                    {teamSchedule.slice(0, 20).map((match) => (
                      <div key={match.key} className="border-l border-white/10 pl-3">
                        <p className="font-medium text-white">{scheduleLabel(match)}</p>
                        <p className="text-xs text-white/45">{match.event_key}</p>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            </section>

            <section className="desk-card">
              <p className="desk-section-label">Jobs</p>
              <div className="mt-2 max-h-[min(28dvh,240px)] space-y-1 overflow-y-auto pr-0.5">
                {recentJobs.length === 0 ? (
                  <p className="py-2 text-[11px] text-white/35">No jobs yet.</p>
                ) : (
                  recentJobs.map((job) => {
                    const progress = estimateJobProgress(job);
                    return (
                      <div
                        key={job.id}
                        className="flex items-center gap-2 rounded-md border border-white/[0.08] bg-white/[0.03] px-2 py-1.5"
                      >
                        <button
                          type="button"
                          onClick={async () => {
                            const freshJob = await fetchJob(job.id);
                            setStatusMessage(freshJob.logs.at(-1)?.message ?? `Job ${freshJob.id}`);
                            if (freshJob.match_id) {
                              const match = await fetchMatch(freshJob.match_id);
                              applySelectedMatch(freshJob.match_id, match, freshJob.match_id !== selectedMatchId);
                              await syncFuelState(freshJob.match_id);
                            }
                          }}
                          className="min-w-0 flex-1 truncate text-left text-[11px] font-medium text-white/85 hover:text-white"
                          title={job.logs.at(-1)?.message ?? job.source.source_name}
                        >
                          {job.source.source_name}
                        </button>
                        <span className={`shrink-0 rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide ${jobStatusClasses(job)}`}>
                          {job.status}
                        </span>
                        <span className="shrink-0 font-mono text-[10px] text-white/35">{progress}%</span>
                        <button
                          type="button"
                          onClick={() => void handleDeleteJob(job.id)}
                          className="shrink-0 rounded border border-white/10 px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-white/45 hover:border-rose-300/40 hover:text-rose-200"
                        >
                          Del
                        </button>
                      </div>
                    );
                  })
                )}
              </div>
            </section>
          </div>
        </aside>

        <main className="desk-main">
          <div className="desk-main-inner desk-main-inner--workbench">
            <div className="desk-main-workbench-primary">
            <section className="desk-stage-panel">
              <div className="desk-stage-toolbar">
                <div>
                  <p className="desk-section-label mb-1">{stageMode === "match" ? "Match" : "Field"}</p>
                  <p className="text-[15px] font-medium text-[var(--desk-text)]">{matchTitle}</p>
                </div>
                <div className="flex flex-wrap items-center justify-end gap-2">
                  <div className={`desk-mode-toggle ${stageMode === "field" ? "desk-mode-toggle--field" : ""}`} role="toolbar" aria-label="Stage mode">
                    <span className="desk-mode-toggle__glider" aria-hidden />
                    <button
                      type="button"
                      className="desk-mode-toggle__segment"
                      aria-pressed={stageMode === "match"}
                      onClick={() => setStageMode("match")}
                    >
                      Match
                    </button>
                    <button
                      type="button"
                      className="desk-mode-toggle__segment"
                      aria-pressed={stageMode === "field"}
                      onClick={() => setStageMode("field")}
                    >
                      Field
                    </button>
                  </div>

                  {stageMode === "match" ? (
                    <>
                      <div className="desk-segmented">
                        <button
                          type="button"
                          className={videoMode === "source" ? "desk-segmented__btn desk-segmented__btn--on" : "desk-segmented__btn"}
                          onClick={() => setVideoMode("source")}
                        >
                          Source
                        </button>
                        <button
                          type="button"
                          disabled={!selectedMatch?.artifacts.annotated_video}
                          className={videoMode === "annotated" ? "desk-segmented__btn desk-segmented__btn--on" : "desk-segmented__btn"}
                          onClick={() => setVideoMode("annotated")}
                        >
                          Annotated
                        </button>
                      </div>
                      {selectedMatchId ? (
                        <button type="button" className="desk-btn desk-btn--danger text-[12px]" onClick={() => void handleDeleteMatch(selectedMatchId)}>
                          Delete match
                        </button>
                      ) : null}
                    </>
                  ) : (
                    <>
                      <div className="flex flex-wrap gap-1">
                        {VIEW_ORDER.map((view) => {
                          const enabled = visibleMapViews[view];
                          return (
                            <button
                              key={view}
                              type="button"
                              onClick={() => toggleMapView(view)}
                              className={enabled ? "desk-chip desk-chip--on" : "desk-chip"}
                            >
                              {VIEW_LABELS[view]}
                            </button>
                          );
                        })}
                      </div>
                      <select
                        value={heatmapTeam}
                        onChange={(event) => setHeatmapTeam(event.target.value)}
                        className="desk-select-compact min-w-[140px]"
                      >
                        {labeledTeams.map((team) => (
                          <option key={team} value={team}>
                            {team === "all" ? "Heatmap: off" : `Heatmap: ${team}`}
                          </option>
                        ))}
                      </select>
                      <span className="hidden font-mono text-[11px] text-[var(--desk-text-faint)] sm:inline">
                        f {fuelFrameIndex}
                        {fieldMapData ? `/${fieldMapData.frames.length}` : ""} · {uniqueTrackIds.length} robots
                      </span>
                    </>
                  )}
                </div>
              </div>

              <div className="desk-stage-frame">
                <div
                  className={`desk-stage-media ${stageMode === "field" ? "desk-stage-media--field" : "desk-stage-media--match"}`}
                >
                  <video
                    ref={videoRef}
                    src={playableVideoUrl ?? undefined}
                    className={stageMode === "field" ? "desk-stage-video desk-stage-video--offscreen" : "desk-stage-video"}
                    playsInline
                    preload="metadata"
                    onError={() => setVideoError("This video artifact is not playable in the browser.")}
                  />
                  {!playableVideoUrl && stageMode === "match" ? (
                    <div className="pointer-events-none absolute inset-0 z-[1] flex items-center justify-center bg-black/75 text-center text-[13px] text-[var(--desk-text-muted)]">
                      Select a match with a video artifact to replay.
                    </div>
                  ) : null}
                  {stageMode === "field" ? (
                    <>
                      <canvas ref={combinedFieldCanvasRef} className="desk-stage-field-canvas" />
                      {fuelArtifactsError || (!fieldMapData && fieldMapArtifactUrl) || !fieldMapArtifactUrl ? (
                        <div className="desk-stage-field-overlay pointer-events-none">
                          {fuelArtifactsError ? (
                            <p className="max-w-md text-center text-[13px] text-[var(--desk-danger)]">{fuelArtifactsError}</p>
                          ) : null}
                          {!fieldMapData && fieldMapArtifactUrl && !fuelArtifactsError ? (
                            <p className="text-center text-[13px] text-[var(--desk-text-muted)]">Loading field map…</p>
                          ) : null}
                          {!fieldMapArtifactUrl && !fuelArtifactsError ? (
                            <p className="max-w-md text-center text-[13px] leading-relaxed text-[var(--desk-text-muted)]">
                              No field-map yet — robots still render from tracking. Run fuel after ground calibration.
                            </p>
                          ) : null}
                        </div>
                      ) : null}
                    </>
                  ) : null}
                </div>
                {videoError && stageMode === "match" ? (
                  <div className="border-t border-[var(--desk-warn-border)] bg-[var(--desk-warn-bg)] px-4 py-2 text-[13px] text-[var(--desk-warn-text)]">{videoError}</div>
                ) : null}
                <div className="desk-transport">
                  <button type="button" className="desk-transport-play" onClick={() => setIsPlaying((value) => !value)}>
                    {isPlaying ? "Pause" : "Play"}
                  </button>
                  <div className="desk-timeline">
                    <span>{formatTime(currentTime)}</span>
                    <input
                      type="range"
                      min={0}
                      max={videoDuration || 0}
                      step={0.01}
                      value={currentTime}
                      onChange={(event) => {
                        const value = Number(event.target.value);
                        setCurrentTime(value);
                        if (videoRef.current) videoRef.current.currentTime = value;
                      }}
                    />
                    <span>{formatTime(videoDuration)}</span>
                  </div>
                  <select
                    value={playbackSpeed}
                    onChange={(event) => setPlaybackSpeed(Number(event.target.value))}
                    className="desk-select-compact"
                  >
                    <option value={0.5}>0.5×</option>
                    <option value={1}>1×</option>
                    <option value={1.5}>1.5×</option>
                    <option value={2}>2×</option>
                  </select>
                </div>
              </div>
            </section>

            {stageMode === "field" ? (
              <section className="desk-air-panel desk-air-panel--below-stage desk-air-panel--compact" aria-label="Air height profile">
                <div className="desk-air-canvas-wrap">
                  <canvas ref={airProfileCanvasRef} className="h-full w-full" />
                  {!airProfileForViz ? (
                    <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-2 text-center text-[11px] text-[var(--desk-text-muted)]">
                      {fieldMapArtifactUrl && !fieldMapData ? "Loading…" : "No fuel frame data"}
                    </div>
                  ) : null}
                </div>
              </section>
            ) : null}
            </div>

            <div className="desk-main-workbench-scroll">
            <section className={`grid gap-6 min-h-0 ${inspectorOpen ? "xl:grid-cols-[minmax(0,1fr)_300px]" : "xl:grid-cols-[minmax(0,1fr)]"}`}>
              <div className="grid gap-6 lg:grid-cols-[0.9fr_1.1fr]">
                <div className="min-w-0 border-t border-white/10 pt-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <p className="text-xs uppercase tracking-[0.3em] text-white/45">Track labels</p>
                      <h3 className="mt-1 text-base font-semibold">Robot team numbers</h3>
                    </div>
                    <button onClick={handleSaveLabels} disabled={uniqueTrackIds.length === 0 || uniqueTrackIds.length > 6} className="rounded-full bg-emerald-400 px-4 py-2 text-sm font-semibold text-slate-950 disabled:cursor-not-allowed disabled:bg-white/15 disabled:text-white/50">
                      Save labels
                    </button>
                  </div>

                  {uniqueTrackIds.length > 6 ? (
                    <p className="mt-3 text-xs text-amber-200/85">&gt;6 tracks — labeling locked.</p>
                  ) : (
                    <div className="mt-5 grid gap-3 md:grid-cols-2">
                      {uniqueTrackIds.map((trackId) => (
                        <label key={trackId} className={`border-l-2 px-3 py-3 ${selectedTrackId === trackId ? "border-emerald-300 bg-emerald-300/8" : "border-white/10 bg-white/[0.03]"}`}>
                          <div className="flex items-center justify-between">
                            <span className="font-medium">Track {trackId}</span>
                            <button type="button" onClick={() => setSelectedTrackId(trackId)} className="text-xs text-emerald-200/80">
                              Focus
                            </button>
                          </div>
                          <input
                            value={labelDrafts[String(trackId)] ?? ""}
                            onChange={(event) => setLabelDrafts((current) => ({ ...current, [String(trackId)]: event.target.value }))}
                            placeholder="Team number"
                            className="mt-3 w-full border-b border-white/15 bg-transparent px-1 py-2 text-sm outline-none placeholder:text-white/35"
                          />
                        </label>
                      ))}
                    </div>
                  )}
                </div>

                <div className="min-w-0 border-t border-white/10 pt-4">
                  <p className="text-xs uppercase tracking-[0.3em] text-white/45">Debug</p>
                  <h3 className="mt-1 text-base font-semibold">Pipeline & calibration</h3>

                  <div className="mt-5 grid gap-4">
                    <div className="border-l border-white/10 pl-4">
                      <p className="font-medium text-white">Pipeline stages</p>
                      <p className="mt-2 text-sm text-white/60">{(selectedMatch?.debug.stages as string[] | undefined)?.join(" -> ") ?? "No debug stages recorded."}</p>
                    </div>
                    <div className="border-l border-white/10 pl-4">
                      <p className="font-medium text-white">Calibration quality</p>
                      <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-words text-xs text-white/65">
                        {JSON.stringify(selectedMatch?.calibration.quality_checks ?? {}, null, 2)}
                      </pre>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {selectedMatch?.artifacts.annotated_video ? <button onClick={() => setVideoMode("annotated")} className="rounded-full border border-white/10 px-3 py-1.5 text-xs hover:bg-white/10">Annotated video</button> : null}
                      {selectedMatch?.artifacts.source_video ? <button onClick={() => setVideoMode("source")} className="rounded-full border border-white/10 px-3 py-1.5 text-xs hover:bg-white/10">Raw match video</button> : null}
                      {selectedMatch?.artifacts.topdown_replay ? <a href={resolveArtifactUrl(selectedMatch.artifacts.topdown_replay) ?? "#"} target="_blank" className="rounded-full border border-white/10 px-3 py-1.5 text-xs hover:bg-white/10">Top-down snapshot</a> : null}
                      {selectedMatchId ? <Link href={`/calibrate?match=${selectedMatchId}`} className="rounded-full border border-white/10 px-3 py-1.5 text-xs hover:bg-white/10">Open calibration lab</Link> : null}
                      {selectedMatchId ? <Link href={`/fuel?match=${selectedMatchId}`} className="rounded-full border border-amber-300/20 px-3 py-1.5 text-xs text-amber-50 hover:bg-amber-300/10">Open fuel lab</Link> : null}
                    </div>
                  </div>
                </div>
              </div>

              {inspectorOpen ? (
              <div className="desk-inspector-col">
                <div className="desk-card mb-4">
                  <p className="desk-section-label">Fuel</p>
                  <div className="mt-2 flex flex-wrap gap-2 text-[12px]">
                    <span className="rounded-md border border-[var(--desk-border)] bg-[var(--desk-bg)] px-2 py-1 font-mono text-[var(--desk-text-muted)]">
                      {fuelAnalysis?.status ?? "—"}
                    </span>
                    {fuelCalibration?.ground_quad?.length === 4 ? (
                      <span className="text-[var(--desk-success)]">Calibrated</span>
                    ) : (
                      <span className="text-[var(--desk-warn-text)]">Needs quads</span>
                    )}
                  </div>
                  <button
                    type="button"
                    className="desk-btn desk-btn--primary mt-4 w-full text-[13px] disabled:opacity-40"
                    disabled={
                      !selectedMatchId ||
                      fuelCalibration?.ground_quad?.length !== 4 ||
                      fuelAnalysis?.status === "processing" ||
                      fuelProcessing
                    }
                    onClick={() => void handleProcessFuel()}
                  >
                    {fuelProcessing || fuelAnalysis?.status === "processing" ? "Processing…" : "Run fuel processing"}
                  </button>
                  {fuelAnalysis?.last_error ? (
                    <p className="mt-2 text-[12px] text-[var(--desk-danger)]">{fuelAnalysis.last_error}</p>
                  ) : null}
                </div>

                <p className="desk-section-label">Timeline</p>
                <h3 className="mt-1 text-[14px] font-semibold text-[var(--desk-text)]">Tracks</h3>
                <div className="mt-5 space-y-3 xl:max-h-[720px] xl:overflow-auto xl:pr-2">
                  {visibleTracks.length === 0 ? <p className="text-sm text-white/45">No active tracks at this timestamp.</p> : null}
                  {visibleTracks.map((track, index) => (
                    <button key={`${track.track_id}-${track.frame}-${track.time}-${index}`} onClick={() => setSelectedTrackId(track.track_id)} className={`w-full border-l-2 px-3 py-3 text-left transition ${selectedTrackId === track.track_id ? "border-amber-300 bg-amber-300/10" : "border-white/10 bg-white/[0.03] hover:bg-white/[0.06]"}`}>
                      <div className="flex items-center justify-between">
                        <span className="font-medium">{selectedMatch?.labels[String(track.track_id)] ?? `Track ${track.track_id}`}</span>
                        <span className="text-xs text-white/45">{formatTime(track.time)}</span>
                      </div>
                      <p className="mt-2 text-sm text-white/60">x {track.x.toFixed(1)} in, y {track.y.toFixed(1)} in</p>
                      <p className="mt-1 text-xs text-white/45">views: {track.source_views.join(", ") || "n/a"} | confidence {track.confidence.toFixed(2)}</p>
                    </button>
                  ))}
                </div>
              </div>
              ) : null}
            </section>
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
