'use client';

import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  ApiError,
  createSourceJob,
  deleteJob,
  deleteMatch,
  fetchJob,
  fetchJobs,
  fetchCalibrationPresets,
  fetchMatch,
  fetchMatches,
  fetchTeamSchedule,
  fetchWatchbot,
  resolveArtifactUrl,
  startWatchbot,
  stopWatchbot,
  updateMatchLabels,
} from "@/lib/api";
import { drawFieldBackground, FIELD_HEIGHT, FIELD_IMAGE_SRC, FIELD_WIDTH, fieldPointToCanvas, getFieldCanvasLayout } from "@/lib/fieldGeometry";
import { CalibrationPreset, JobRecord, MatchRecord, MatchSummary, TbaMatch, TrackRecord, WatchbotState } from "@/lib/types";

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

function isFusedTrack(track: TrackRecord) {
  return new Set(track.source_views ?? []).size > 1;
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

export default function Home() {
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
  const [fieldImageVersion, setFieldImageVersion] = useState(0);

  const videoRef = useRef<HTMLVideoElement>(null);
  const fieldCanvasRef = useRef<HTMLCanvasElement>(null);
  const fieldImageRef = useRef<HTMLImageElement | null>(null);

  useEffect(() => {
    const image = new window.Image();
    image.onload = () => setFieldImageVersion((value) => value + 1);
    image.src = FIELD_IMAGE_SRC;
    fieldImageRef.current = image;
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
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) {
          const fallbackMatchId = matchItems.find((match) => match.id !== targetMatchId)?.id ?? null;
          if (fallbackMatchId) {
            const fallbackMatch = await fetchMatch(fallbackMatchId);
            applySelectedMatch(fallbackMatchId, fallbackMatch, true);
            return;
          }
          applySelectedMatch(null, null, true);
          return;
        }
        throw error;
      }
    } else {
      applySelectedMatch(null, null, true);
    }
  }, [applySelectedMatch, selectedMatchId]);

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

  const activeMapViews = useMemo(
    () => VIEW_ORDER.filter((view) => visibleMapViews[view]),
    [visibleMapViews],
  );

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

  const recentJobs = useMemo(() => jobs.slice(0, 3), [jobs]);

  useEffect(() => {
    const canvas = fieldCanvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;

    canvas.width = 1400;
    canvas.height = 900;
    context.clearRect(0, 0, canvas.width, canvas.height);
    const layout = getFieldCanvasLayout(canvas.width, canvas.height, 90);
    drawFieldBackground(context, layout, fieldImageRef.current, "#0d1f1d", "rgba(241, 245, 215, 0.45)");

    visibleHeatmapTracks.forEach((track) => {
      const [x, y] = fieldPointToCanvas([track.x, track.y], layout);
      const gradient = context.createRadialGradient(x, y, 0, x, y, 26);
      gradient.addColorStop(0, "rgba(214, 224, 230, 0.42)");
      gradient.addColorStop(1, "rgba(214, 224, 230, 0)");
      context.fillStyle = gradient;
      context.beginPath();
      context.arc(x, y, 26, 0, Math.PI * 2);
      context.fill();
    });

    visibleDetections.forEach((detection) => {
      const [x, y] = fieldPointToCanvas([detection.field_point[0], detection.field_point[1]], layout);
      context.beginPath();
      context.arc(x, y, 8, 0, Math.PI * 2);
      context.fillStyle = "rgba(214, 224, 230, 0.92)";
      context.fill();
      context.strokeStyle = "rgba(255, 255, 255, 0.92)";
      context.lineWidth = 1.5;
      context.stroke();
    });

    for (const trail of visibleTrackHistory.values()) {
      trail.sort((a, b) => a.time - b.time);
      if (trail.length < 2) continue;
      context.beginPath();
      trail.forEach((point, index) => {
        const [x, y] = fieldPointToCanvas([point.x, point.y], layout);
        if (index === 0) context.moveTo(x, y);
        else context.lineTo(x, y);
      });
      context.strokeStyle = "rgba(214, 224, 230, 0.26)";
      context.lineWidth = 3;
      context.stroke();
    }

    visibleTracksOnMap.forEach((track) => {
      const [x, y] = fieldPointToCanvas([track.x, track.y], layout);
      const label = selectedMatch?.labels[String(track.track_id)] ?? `T${track.track_id}`;
      const selected = selectedTrackId === track.track_id;
      const fused = isFusedTrack(track);

      if (fused) {
        context.fillStyle = selected ? "#f3e8ff" : "#c084fc";
        context.strokeStyle = selected ? "#ffffff" : "#e9d5ff";
      } else {
        context.fillStyle = selected ? "#f1f5f9" : "#cbd5e1";
        context.strokeStyle = selected ? "#ffffff" : "#e2e8f0";
      }
      context.lineWidth = selected ? 4 : 2;
      context.beginPath();
      context.roundRect(x - 18, y - 18, 36, 36, 8);
      context.fill();
      context.stroke();

      context.fillStyle = "#091114";
      context.font = "bold 12px sans-serif";
      context.textAlign = "center";
      context.textBaseline = "middle";
      context.fillText(label.slice(0, 5), x, y);

      if (fused) {
        context.fillStyle = "#f3e8ff";
        context.font = "bold 10px sans-serif";
        context.fillText("FUSED", x, y + 28);
      }
    });
  }, [currentTime, fieldImageVersion, selectedMatch, selectedTrackId, visibleDetections, visibleHeatmapTracks, visibleTrackHistory, visibleTracksOnMap]);

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

  return (
    <div className="min-h-screen bg-[linear-gradient(180deg,_#081012_0%,_#0d1620_52%,_#050709_100%)] text-white">
      <div className="mx-auto max-w-[1800px] px-6 py-6">
        <div className="mb-6 grid gap-4 lg:grid-cols-[1.2fr_0.8fr] lg:items-end">
          <div>
            <p className="text-sm uppercase tracking-[0.45em] text-emerald-300/70">FRC Analysis Desk</p>
            <h1 className="mt-3 text-5xl font-semibold tracking-tight">Replay first. Everything else supports that.</h1>
            <p className="mt-3 max-w-4xl text-white/60">
              Browse processed matches by event and match type, search local labels or TBA schedules by team number, and keep the video plus top-down replay as the center of the workflow.
            </p>
          </div>
          <div className="grid gap-3 rounded-[32px] border border-white/10 bg-[linear-gradient(135deg,_rgba(17,24,39,0.82),_rgba(3,12,10,0.88))] p-5">
            <div className="grid grid-cols-4 gap-3 text-sm">
              <div>
                <p className="text-[11px] uppercase tracking-[0.25em] text-white/45">Matches</p>
                <p className="mt-1 text-2xl font-semibold">{matches.length}</p>
              </div>
              <div>
                <p className="text-[11px] uppercase tracking-[0.25em] text-white/45">Jobs</p>
                <p className="mt-1 text-2xl font-semibold">{jobs.length}</p>
              </div>
              <div>
                <p className="text-[11px] uppercase tracking-[0.25em] text-white/45">Visible</p>
                <p className="mt-1 text-2xl font-semibold">{visibleTracks.length}</p>
              </div>
              <div>
                <p className="text-[11px] uppercase tracking-[0.25em] text-white/45">Watchbot</p>
                <p className="mt-1 text-2xl font-semibold">{watchbot?.active ? "Armed" : "Idle"}</p>
              </div>
            </div>
            <div className="flex flex-wrap gap-3">
              <Link href={selectedMatchId ? `/calibrate?match=${selectedMatchId}` : "/calibrate"} className="rounded-full border border-white/10 bg-white/5 px-4 py-2 text-sm hover:bg-white/10">
                Calibration Lab
              </Link>
              <button onClick={() => refreshDashboard().catch((error: Error) => setStatusMessage(error.message))} className="rounded-full bg-emerald-400 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-emerald-300">
                Refresh Data
              </button>
            </div>
          </div>
        </div>

        {statusMessage ? (
          <div className="mb-6 rounded-2xl border border-emerald-400/20 bg-emerald-400/10 px-4 py-3 text-sm text-emerald-100">
            {statusMessage}
          </div>
        ) : null}

        <div className="grid gap-6 xl:grid-cols-[340px_minmax(0,1fr)]">
          <aside className="space-y-5">
            <section className="rounded-[28px] border border-white/10 bg-white/[0.03] p-5">
              <p className="text-xs uppercase tracking-[0.28em] text-white/45">Match Browser</p>
              <p className="mt-2 text-xs leading-5 text-white/45">
                Stored across sessions in <span className="font-mono text-white/60">backend/data</span>. Delete matches here when you want to clear old artifacts and JSON.
              </p>
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

              <div className="mt-5 max-h-[620px] space-y-2 overflow-auto pr-1">
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
          </aside>

          <main className="grid min-w-0 gap-6">
            <section className="grid gap-6 xl:grid-cols-[minmax(0,1.25fr)_minmax(0,0.95fr)]">
              <div className="min-w-0 overflow-hidden rounded-[34px] border border-white/10 bg-[linear-gradient(180deg,_rgba(5,8,14,0.92),_rgba(4,10,8,0.92))]">
                <div className="flex items-center justify-between border-b border-white/10 px-6 py-4">
                  <div>
                    <p className="text-xs uppercase tracking-[0.3em] text-white/45">Match Video</p>
                    <h2 className="mt-1 text-2xl font-semibold">{selectedSummary ? parseMatchMetadata(selectedSummary).displayName : "No match selected"}</h2>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setVideoMode("source")}
                      className={`rounded-full px-3 py-1.5 text-xs transition ${videoMode === "source" ? "bg-emerald-400 text-slate-950" : "border border-white/10 bg-white/5 text-white/70 hover:bg-white/10"}`}
                    >
                      Match Video
                    </button>
                    <button
                      onClick={() => setVideoMode("annotated")}
                      disabled={!selectedMatch?.artifacts.annotated_video}
                      className={`rounded-full px-3 py-1.5 text-xs transition ${videoMode === "annotated" ? "bg-amber-300 text-slate-950" : "border border-white/10 bg-white/5 text-white/70 hover:bg-white/10"} disabled:cursor-not-allowed disabled:opacity-40`}
                    >
                      Annotated Video
                    </button>
                    <p className="ml-2 text-sm text-white/45">{String(selectedMatch?.metadata.status ?? "idle")}</p>
                    {selectedMatchId ? (
                      <button
                        onClick={() => void handleDeleteMatch(selectedMatchId)}
                        className="ml-2 rounded-full border border-white/10 px-3 py-1.5 text-xs text-white/70 hover:border-rose-300/35 hover:bg-rose-300/10 hover:text-rose-100"
                      >
                        Delete Match
                      </button>
                    ) : null}
                  </div>
                </div>

                <div className="relative">
                  {playableVideoUrl ? (
                    <video
                      ref={videoRef}
                      src={playableVideoUrl ?? undefined}
                      className="aspect-[16/10] w-full bg-black object-contain"
                      playsInline
                      preload="metadata"
                      onError={() => setVideoError("This video artifact is not playable in the browser.")}
                    />
                  ) : (
                    <div className="flex aspect-[16/10] items-center justify-center text-sm text-white/45">Select a completed match to replay it.</div>
                  )}
                </div>

                {videoError ? (
                  <div className="border-t border-amber-300/20 bg-amber-300/10 px-6 py-3 text-sm text-amber-100">
                    {videoError}
                  </div>
                ) : null}

                <div className="flex flex-wrap items-center gap-3 border-t border-white/10 px-6 py-4">
                  <button onClick={() => setIsPlaying((value) => !value)} className="rounded-full bg-white/10 px-4 py-2 text-sm hover:bg-white/15">
                    {isPlaying ? "Pause" : "Play"}
                  </button>
                  <input
                    type="range"
                    min={0}
                    max={videoDuration}
                    step={0.01}
                    value={currentTime}
                    onChange={(event) => {
                      const value = Number(event.target.value);
                      setCurrentTime(value);
                      if (videoRef.current) videoRef.current.currentTime = value;
                    }}
                    className="min-w-[220px] flex-1 accent-emerald-300"
                  />
                  <span className="w-20 text-right text-sm text-white/60">{formatTime(currentTime)}</span>
                  <div className="relative">
                    <select value={playbackSpeed} onChange={(event) => setPlaybackSpeed(Number(event.target.value))} className={SELECT_CLASS}>
                      <option value={0.5}>0.5x</option>
                      <option value={1}>1x</option>
                      <option value={1.5}>1.5x</option>
                      <option value={2}>2x</option>
                    </select>
                    <span className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-white/50">⌄</span>
                  </div>
                </div>
              </div>

              <div className="min-w-0 overflow-hidden rounded-[34px] border border-white/10 bg-[linear-gradient(180deg,_rgba(4,16,19,0.95),_rgba(8,12,16,0.95))]">
                <div className="flex items-center justify-between border-b border-white/10 px-6 py-4">
                  <div>
                    <p className="text-xs uppercase tracking-[0.3em] text-white/45">Top-Down Replay</p>
                    <h2 className="mt-1 text-2xl font-semibold">Field map + team heatmap</h2>
                  </div>
                  <div className="flex flex-wrap items-center justify-end gap-3">
                    <div className="flex flex-wrap items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] px-2 py-2">
                      <span className="px-2 text-[11px] uppercase tracking-[0.2em] text-white/40">Views</span>
                      {VIEW_ORDER.map((view) => {
                        const enabled = visibleMapViews[view];
                        return (
                          <button
                            key={view}
                            type="button"
                            onClick={() => toggleMapView(view)}
                            className={`rounded-full px-3 py-1.5 text-xs transition ${
                              enabled
                                ? "bg-emerald-400 text-slate-950"
                                : "border border-white/10 bg-white/5 text-white/55 hover:bg-white/10"
                            }`}
                          >
                            {VIEW_LABELS[view]}
                          </button>
                        );
                      })}
                    </div>
                    <div className="relative">
                      <select value={heatmapTeam} onChange={(event) => setHeatmapTeam(event.target.value)} className={SELECT_CLASS}>
                        {labeledTeams.map((team) => (
                          <option key={team} value={team}>
                            {team === "all" ? "All teams" : `Heatmap ${team}`}
                          </option>
                        ))}
                      </select>
                      <span className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-white/50">⌄</span>
                    </div>
                  </div>
                </div>

                <div className="relative aspect-[16/10]">
                  <canvas ref={fieldCanvasRef} className="absolute inset-0 h-full w-full" />
                  <div className="pointer-events-none absolute left-4 top-4 flex items-center gap-3 rounded-full border border-white/10 bg-slate-950/65 px-3 py-2 text-[11px] uppercase tracking-[0.2em] text-white/65 backdrop-blur">
                    <span className="flex items-center gap-2">
                      <span className="h-2.5 w-2.5 rounded-full bg-slate-300" />
                      Track
                    </span>
                    <span className="flex items-center gap-2">
                      <span className="h-2.5 w-2.5 rounded-full bg-violet-400" />
                      Fused
                    </span>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3 border-t border-white/10 px-6 py-4 text-sm text-white/60 md:grid-cols-3 xl:grid-cols-7">
                  <div>
                    <p className="text-[11px] uppercase tracking-[0.2em] text-white/40">Tracks</p>
                    <p className="mt-1 text-lg text-white">{uniqueTrackIds.length}</p>
                  </div>
                  <div>
                    <p className="text-[11px] uppercase tracking-[0.2em] text-white/40">Detections</p>
                    <p className="mt-1 text-lg text-white">{selectedMatch?.metadata.detection_count as number ?? 0}</p>
                  </div>
                  <div>
                    <p className="text-[11px] uppercase tracking-[0.2em] text-white/40">Status</p>
                    <p className="mt-1 text-lg text-white">{String(selectedMatch?.metadata.status ?? "idle")}</p>
                  </div>
                  <div>
                    <p className="text-[11px] uppercase tracking-[0.2em] text-white/40">Heatmap</p>
                    <p className="mt-1 text-lg text-white">{heatmapTeam === "all" ? "Off" : heatmapTeam}</p>
                  </div>
                  <div>
                    <p className="text-[11px] uppercase tracking-[0.2em] text-white/40">Tracking</p>
                    <p className="mt-1 text-lg text-white">{String(selectedMatch?.metadata.tracking_mode ?? "n/a")}</p>
                  </div>
                  <div>
                    <p className="text-[11px] uppercase tracking-[0.2em] text-white/40">Map Views</p>
                    <p className="mt-1 text-lg text-white">{activeMapViews.map((view) => VIEW_LABELS[view]).join(", ")}</p>
                  </div>
                  <div>
                    <p className="text-[11px] uppercase tracking-[0.2em] text-white/40">Visible Dets</p>
                    <p className="mt-1 text-lg text-white">{visibleDetections.length}</p>
                  </div>
                </div>
              </div>
            </section>

            <section className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_320px]">
              <div className="grid gap-6 lg:grid-cols-[0.9fr_1.1fr]">
                <div className="min-w-0 border-t border-white/10 pt-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-xs uppercase tracking-[0.3em] text-white/45">Track Labels</p>
                      <h3 className="mt-2 text-xl font-semibold">Tag robots when the tracker is stable</h3>
                    </div>
                    <button onClick={handleSaveLabels} disabled={uniqueTrackIds.length === 0 || uniqueTrackIds.length > 6} className="rounded-full bg-emerald-400 px-4 py-2 text-sm font-semibold text-slate-950 disabled:cursor-not-allowed disabled:bg-white/15 disabled:text-white/50">
                      Save Labels
                    </button>
                  </div>

                  {uniqueTrackIds.length > 6 ? (
                    <div className="mt-4 rounded-2xl border border-amber-300/20 bg-amber-300/10 p-4 text-sm text-amber-100">
                      Labeling is disabled until tracking settles closer to 6 robots. The replay and heatmap views still work while you tune calibration and merge behavior.
                    </div>
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
                  <p className="text-xs uppercase tracking-[0.3em] text-white/45">Debug + Calibration</p>
                  <h3 className="mt-2 text-xl font-semibold">Processing state and diagnostics</h3>

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
                    </div>
                  </div>
                </div>
              </div>

              <div className="min-w-0 border-l border-white/10 pl-6">
                <p className="text-xs uppercase tracking-[0.3em] text-white/45">Timeline Inspector</p>
                <h3 className="mt-2 text-xl font-semibold">Visible robots right now</h3>
                <div className="mt-5 space-y-3 xl:max-h-[720px] xl:overflow-auto xl:pr-2">
                  {visibleTracks.length === 0 ? <p className="text-sm text-white/45">No active tracks at this timestamp.</p> : null}
                  {visibleTracks.map((track, index) => (
                    <button key={`${track.track_id}-${track.frame}-${track.time}-${index}`} onClick={() => setSelectedTrackId(track.track_id)} className={`w-full border-l-2 px-3 py-3 text-left transition ${selectedTrackId === track.track_id ? "border-amber-300 bg-amber-300/10" : "border-white/10 bg-white/[0.03] hover:bg-white/[0.06]"}`}>
                      <div className="flex items-center justify-between">
                        <span className="font-medium">
                          {selectedMatch?.labels[String(track.track_id)] ?? `Track ${track.track_id}`}
                          {isFusedTrack(track) ? <span className="ml-2 rounded-full bg-violet-400/20 px-2 py-0.5 text-[10px] uppercase tracking-[0.18em] text-violet-200">Fused</span> : null}
                        </span>
                        <span className="text-xs text-white/45">{formatTime(track.time)}</span>
                      </div>
                      <p className="mt-2 text-sm text-white/60">x {track.x.toFixed(1)} in, y {track.y.toFixed(1)} in</p>
                      <p className="mt-1 text-xs text-white/45">views: {track.source_views.join(", ") || "n/a"} | confidence {track.confidence.toFixed(2)}</p>
                    </button>
                  ))}
                </div>
              </div>
            </section>

            <section className="border-t border-white/10 pt-4">
              <div className="flex items-end justify-between gap-4">
                <div>
                  <p className="text-xs uppercase tracking-[0.3em] text-white/45">Recent Jobs</p>
                  <p className="mt-2 text-sm text-white/50">Showing the 3 most recent jobs. Scroll sideways to browse them quickly.</p>
                </div>
              </div>
              <div className="mt-4 flex snap-x gap-4 overflow-x-auto pb-2">
                {recentJobs.map((job) => {
                  const progress = estimateJobProgress(job);
                  const dash = 2 * Math.PI * 24;
                  const offset = dash - (dash * progress) / 100;
                  return (
                  <div
                    key={job.id}
                    className="min-w-[320px] snap-start rounded-[28px] border border-white/10 bg-white/[0.03] px-4 py-4 text-left transition hover:bg-white/[0.06]"
                  >
                    <button
                      onClick={async () => {
                        const freshJob = await fetchJob(job.id);
                        setStatusMessage(freshJob.logs.at(-1)?.message ?? `Job ${freshJob.id}`);
                        if (freshJob.match_id) {
                          const match = await fetchMatch(freshJob.match_id);
                          applySelectedMatch(freshJob.match_id, match, freshJob.match_id !== selectedMatchId);
                        }
                      }}
                      className="w-full text-left"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <p className="font-medium">{job.source.source_name}</p>
                          <p className="mt-1 text-xs text-white/45">{job.id}</p>
                          <div className="mt-3 h-2 overflow-hidden rounded-full bg-white/10">
                            <div
                              className={`h-full rounded-full transition-all ${
                                job.status === "completed"
                                  ? "bg-emerald-300"
                                  : job.status === "failed"
                                    ? "bg-rose-300"
                                    : "bg-amber-300"
                              }`}
                              style={{ width: `${progress}%` }}
                            />
                          </div>
                          <p className="mt-2 text-[11px] uppercase tracking-[0.18em] text-white/35">{progress}%</p>
                        </div>
                        <div className="flex flex-col items-end gap-3">
                          <span className={`rounded-full px-3 py-1 text-xs font-semibold ${jobStatusClasses(job)}`}>
                            {job.status}
                          </span>
                          <svg width="56" height="56" viewBox="0 0 56 56" className="shrink-0">
                            <circle cx="28" cy="28" r="24" fill="none" stroke="rgba(255,255,255,0.1)" strokeWidth="5" />
                            <circle
                              cx="28"
                              cy="28"
                              r="24"
                              fill="none"
                              stroke={job.status === "completed" ? "#6ee7b7" : job.status === "failed" ? "#fda4af" : "#fcd34d"}
                              strokeWidth="5"
                              strokeLinecap="round"
                              strokeDasharray={dash}
                              strokeDashoffset={offset}
                              transform="rotate(-90 28 28)"
                            />
                            <text x="28" y="32" textAnchor="middle" className="fill-white text-[11px] font-semibold">
                              {progress}
                            </text>
                          </svg>
                        </div>
                      </div>
                      <p className="mt-3 line-clamp-2 text-xs text-white/55">{job.logs.at(-1)?.message ?? "Waiting for work."}</p>
                    </button>
                    <div className="mt-4 flex items-center justify-between gap-3">
                      <span className="text-[11px] uppercase tracking-[0.18em] text-white/30">
                        {new Date(job.updated_at * 1000).toLocaleString()}
                      </span>
                      <button
                        type="button"
                        onClick={() => void handleDeleteJob(job.id)}
                        className="rounded-full border border-white/10 px-3 py-1.5 text-[11px] uppercase tracking-[0.15em] text-white/55 hover:border-rose-300/35 hover:bg-rose-300/10 hover:text-rose-100"
                      >
                        Delete Job
                      </button>
                    </div>
                  </div>
                )})}
                {recentJobs.length === 0 ? (
                  <div className="min-w-[320px] rounded-[28px] border border-dashed border-white/10 px-5 py-8 text-sm text-white/40">
                    No jobs yet.
                  </div>
                ) : null}
              </div>
            </section>
          </main>
        </div>
      </div>
    </div>
  );
}
