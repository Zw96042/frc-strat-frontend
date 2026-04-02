'use client';
/* eslint-disable @next/next/no-img-element */

import Link from "next/link";
import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  fetchFuelState,
  fetchMatch,
  fetchMatches,
  processFuel,
  resolveArtifactUrl,
  sampleFuelBaseColor,
  updateFuelCalibration,
} from "@/lib/api";
import { FuelAnalysisRecord, FuelCalibration, MatchRecord, MatchSummary } from "@/lib/types";

type CalibrationTarget = "ground_quad" | "left_wall_quad" | "right_wall_quad";
type Point = [number, number];
type InteractionMode = "calibrate" | "video";

const TARGET_LABELS: Record<CalibrationTarget, string> = {
  ground_quad: "Ground corners",
  left_wall_quad: "Left wall",
  right_wall_quad: "Right wall",
};

function colorToHex(color: number[]) {
  return `#${color.map((channel) => Math.max(0, Math.min(255, Math.round(channel))).toString(16).padStart(2, "0")).join("")}`;
}

function progressPercent(analysis: FuelAnalysisRecord | null) {
  const progress = analysis?.processing_progress;
  if (!progress || progress.total <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((progress.current / progress.total) * 100)));
}

function getMatchTitle(match: MatchSummary | MatchRecord) {
  return String(match.metadata.display_name ?? match.id);
}

function pointsForTarget(calibration: FuelCalibration | null, target: CalibrationTarget): Point[] {
  const raw = calibration?.[target];
  if (!Array.isArray(raw)) return [];
  const points = raw
    .filter((point): point is number[] => Array.isArray(point) && point.length === 2)
    .map((point) => [Number(point[0]), Number(point[1])] as Point);
  return points.length === 4 ? orderQuadPoints(points) : points;
}

function formatJson(value: unknown) {
  return JSON.stringify(value ?? {}, null, 2);
}

function formatTime(seconds: number) {
  if (!Number.isFinite(seconds)) return "0:00";
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${String(secs).padStart(2, "0")}`;
}

function orderQuadPoints(points: Point[]): Point[] {
  if (points.length !== 4) {
    return points;
  }

  const centerX = points.reduce((sum, [x]) => sum + x, 0) / points.length;
  const centerY = points.reduce((sum, [, y]) => sum + y, 0) / points.length;
  const sortedByAngle = [...points].sort((left, right) => {
    const leftAngle = Math.atan2(left[1] - centerY, left[0] - centerX);
    const rightAngle = Math.atan2(right[1] - centerY, right[0] - centerX);
    return leftAngle - rightAngle;
  });

  let topEdgeStartIndex = 0;
  let bestTopEdgeScore = Number.POSITIVE_INFINITY;
  for (let index = 0; index < sortedByAngle.length; index += 1) {
    const a = sortedByAngle[index];
    const b = sortedByAngle[(index + 1) % sortedByAngle.length];
    const edgeScore = (a[1] + b[1]) * 0.5;
    if (edgeScore < bestTopEdgeScore) {
      bestTopEdgeScore = edgeScore;
      topEdgeStartIndex = index;
    }
  }

  const rotated = sortedByAngle.map((_, index) => sortedByAngle[(topEdgeStartIndex + index) % sortedByAngle.length]);
  const [edgeTopA, edgeTopB, edgeBottomA, edgeBottomB] = rotated;
  const [topLeft, topRight] = edgeTopA[0] <= edgeTopB[0] ? [edgeTopA, edgeTopB] : [edgeTopB, edgeTopA];
  const [bottomLeft, bottomRight] = edgeBottomA[0] <= edgeBottomB[0] ? [edgeBottomA, edgeBottomB] : [edgeBottomB, edgeBottomA];
  return [topLeft, topRight, bottomRight, bottomLeft];
}

function FuelPageContent() {
  const searchParams = useSearchParams();
  const initialMatchId = searchParams.get("match");

  const [matches, setMatches] = useState<MatchSummary[]>([]);
  const [selectedMatchId, setSelectedMatchId] = useState<string | null>(initialMatchId);
  const [selectedMatch, setSelectedMatch] = useState<MatchRecord | null>(null);
  const [fuelCalibration, setFuelCalibration] = useState<FuelCalibration | null>(null);
  const [fuelAnalysis, setFuelAnalysis] = useState<FuelAnalysisRecord | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [videoError, setVideoError] = useState<string | null>(null);
  const [selectedTarget, setSelectedTarget] = useState<CalibrationTarget>("ground_quad");
  const [interactionMode, setInteractionMode] = useState<InteractionMode>("calibrate");
  const [draftPoints, setDraftPoints] = useState<Record<CalibrationTarget, Point[]>>({
    ground_quad: [],
    left_wall_quad: [],
    right_wall_quad: [],
  });
  const [dirtyTargets, setDirtyTargets] = useState<Record<CalibrationTarget, boolean>>({
    ground_quad: false,
    left_wall_quad: false,
    right_wall_quad: false,
  });
  const [pickFuelColor, setPickFuelColor] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [videoDuration, setVideoDuration] = useState<number>(0);

  const videoRef = useRef<HTMLVideoElement>(null);
  const videoWrapRef = useRef<HTMLDivElement>(null);
  const dirtyTargetsRef = useRef(dirtyTargets);

  useEffect(() => {
    dirtyTargetsRef.current = dirtyTargets;
  }, [dirtyTargets]);

  const refreshSelected = useCallback(async (matchId: string) => {
    const [match, fuel] = await Promise.all([fetchMatch(matchId), fetchFuelState(matchId)]);
    setSelectedMatch(match);
    setFuelCalibration(fuel.fuel_calibration);
    setFuelAnalysis(fuel.fuel_analysis);
    const dirty = dirtyTargetsRef.current;
    setDraftPoints((current) => ({
      ground_quad: dirty.ground_quad ? current.ground_quad : pointsForTarget(fuel.fuel_calibration, "ground_quad"),
      left_wall_quad: dirty.left_wall_quad ? current.left_wall_quad : pointsForTarget(fuel.fuel_calibration, "left_wall_quad"),
      right_wall_quad: dirty.right_wall_quad ? current.right_wall_quad : pointsForTarget(fuel.fuel_calibration, "right_wall_quad"),
    }));
  }, []);

  const refreshMatches = useCallback(async () => {
    const nextMatches = await fetchMatches();
    setMatches(nextMatches);

    const preferredId = selectedMatchId ?? initialMatchId ?? nextMatches[0]?.id ?? null;
    if (preferredId) {
      setSelectedMatchId(preferredId);
      setDirtyTargets({
        ground_quad: false,
        left_wall_quad: false,
        right_wall_quad: false,
      });
      await refreshSelected(preferredId);
    } else {
      setSelectedMatchId(null);
      setSelectedMatch(null);
      setFuelCalibration(null);
      setFuelAnalysis(null);
      setDirtyTargets({
        ground_quad: false,
        left_wall_quad: false,
        right_wall_quad: false,
      });
    }
  }, [initialMatchId, refreshSelected, selectedMatchId]);

  useEffect(() => {
    const kickoff = window.setTimeout(() => {
      refreshMatches().catch((error: Error) => setStatusMessage(error.message));
    }, 0);
    return () => window.clearTimeout(kickoff);
  }, [refreshMatches]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      if (!selectedMatchId) return;
      refreshSelected(selectedMatchId).catch(() => undefined);
    }, 5000);
    return () => window.clearInterval(interval);
  }, [refreshSelected, selectedMatchId]);

  const sourceVideoUrl = useMemo(() => (
    resolveArtifactUrl(selectedMatch?.artifacts.source_video ?? selectedMatch?.artifacts.annotated_video)
  ), [selectedMatch]);

  const overlayVideoUrl = useMemo(() => resolveArtifactUrl(fuelAnalysis?.artifacts.overlay_video), [fuelAnalysis]);
  const overlayImageUrl = useMemo(() => resolveArtifactUrl(fuelAnalysis?.artifacts.overlay_image), [fuelAnalysis]);
  const transparentOverlayUrl = useMemo(() => resolveArtifactUrl(fuelAnalysis?.artifacts.overlay_transparent_image), [fuelAnalysis]);
  const fieldMapUrl = useMemo(() => resolveArtifactUrl(fuelAnalysis?.artifacts.field_map), [fuelAnalysis]);
  const airProfileUrl = useMemo(() => resolveArtifactUrl(fuelAnalysis?.artifacts.air_profile), [fuelAnalysis]);
  const statsUrl = useMemo(() => resolveArtifactUrl(fuelAnalysis?.artifacts.stats_file), [fuelAnalysis]);
  const processLogUrl = useMemo(() => resolveArtifactUrl(fuelAnalysis?.artifacts.process_log), [fuelAnalysis]);

  const activePoints = draftPoints[selectedTarget];
  const activeColor = fuelCalibration?.fuel_base_color ?? [255, 255, 0];

  async function handleMatchChange(matchId: string) {
    try {
      setSelectedMatchId(matchId);
      setVideoError(null);
      setDirtyTargets({
        ground_quad: false,
        left_wall_quad: false,
        right_wall_quad: false,
      });
      await refreshSelected(matchId);
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : "Failed to load the selected match.");
    }
  }

  async function handleSaveTarget(target: CalibrationTarget) {
    if (!selectedMatchId) return;
    try {
      const orderedPoints = draftPoints[target].length === 4 ? orderQuadPoints(draftPoints[target]) : draftPoints[target];
      const payload = { [target]: orderedPoints } as Partial<FuelCalibration>;
      const updated = await updateFuelCalibration(selectedMatchId, payload);
      setFuelCalibration(updated);
      setFuelAnalysis((current) => current ? { ...current, status: updated.ground_quad ? "ready" : "idle", artifacts: {}, stats: {} } : current);
      setDraftPoints((current) => ({
        ...current,
        [target]: orderedPoints,
      }));
      setDirtyTargets((current) => ({ ...current, [target]: false }));
      setStatusMessage(`Saved ${TARGET_LABELS[target].toLowerCase()}.`);
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : `Failed to save ${TARGET_LABELS[target].toLowerCase()}.`);
    }
  }

  async function handleClearTarget(target: CalibrationTarget) {
    if (!selectedMatchId) return;
    try {
      setDraftPoints((current) => ({ ...current, [target]: [] }));
      const updated = await updateFuelCalibration(selectedMatchId, { [target]: null } as Partial<FuelCalibration>);
      setFuelCalibration(updated);
      setDirtyTargets((current) => ({ ...current, [target]: false }));
      setStatusMessage(`Cleared ${TARGET_LABELS[target].toLowerCase()}.`);
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : `Failed to clear ${TARGET_LABELS[target].toLowerCase()}.`);
    }
  }

  async function handleProcessFuel() {
    if (!selectedMatchId) return;
    try {
      setStatusMessage("Fuel processing started.");
      const response = await processFuel(selectedMatchId);
      setFuelCalibration(response.fuel_calibration);
      setFuelAnalysis(response.fuel_analysis);
      setStatusMessage("Fuel processing finished.");
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : "Fuel processing failed.");
    }
  }

  async function handleVideoPointer(event: React.PointerEvent<HTMLDivElement>) {
    event.preventDefault();
    event.stopPropagation();
    if (!selectedMatchId || !videoWrapRef.current) return;
    const video = videoRef.current;
    if (!video || video.clientWidth <= 0 || video.clientHeight <= 0 || video.videoWidth <= 0 || video.videoHeight <= 0) {
      setStatusMessage("Load the match video first.");
      return;
    }

    const bounds = video.getBoundingClientRect();
    const scale = Math.min(bounds.width / video.videoWidth, bounds.height / video.videoHeight);
    const drawWidth = video.videoWidth * scale;
    const drawHeight = video.videoHeight * scale;
    const drawLeft = bounds.left + (bounds.width - drawWidth) / 2;
    const drawTop = bounds.top + (bounds.height - drawHeight) / 2;
    const x = (event.clientX - drawLeft) / drawWidth;
    const y = (event.clientY - drawTop) / drawHeight;
    if (x < 0 || x > 1 || y < 0 || y > 1) return;

    if (pickFuelColor) {
      try {
        const sampled = await sampleFuelBaseColor(selectedMatchId, x, y, currentTime);
        setFuelCalibration(sampled.fuel_calibration);
        setPickFuelColor(false);
        setInteractionMode("calibrate");
        setStatusMessage("Sampled fuel color from the current frame.");
      } catch (error) {
        setStatusMessage(error instanceof Error ? error.message : "Fuel color sampling failed.");
      }
      return;
    }

    setDraftPoints((current) => {
      const nextRaw = [...current[selectedTarget], [x, y] as Point].slice(0, 4);
      const next = nextRaw.length === 4 ? orderQuadPoints(nextRaw) : nextRaw;
      return {
        ...current,
        [selectedTarget]: next,
      };
    });
    setDirtyTargets((current) => ({
      ...current,
      [selectedTarget]: true,
    }));
  }

  const displayedPoints = activePoints;

  return (
    <div className="desk-root min-h-screen">
      <header className="desk-titlebar">
        <div className="desk-titlebar-brand">
          <span className="desk-logo" aria-hidden />
          <div className="min-w-0">
            <p className="desk-kicker">Fuel lab</p>
            <p className="desk-titlebar-title truncate font-medium">Calibrate · process · review</p>
          </div>
        </div>
        <div className="desk-titlebar-actions">
          {statusMessage ? (
            <div className="desk-toast max-w-[min(48vw,400px)] truncate" title={statusMessage}>
              {statusMessage}
            </div>
          ) : null}
          <Link href="/" className="desk-btn desk-btn--ghost text-[12px]">
            Workbench
          </Link>
          <Link href={selectedMatchId ? `/calibrate?match=${selectedMatchId}` : "/calibrate"} className="desk-btn desk-btn--accent text-[12px]">
            Robot calibrate
          </Link>
        </div>
      </header>

      <div className="flex flex-1 flex-col overflow-auto p-4">
        <div className="mx-auto w-full max-w-[1600px] space-y-4">
          <div className="desk-card grid gap-4 lg:grid-cols-[1.2fr_1fr]">
            <div>
              <p className="desk-section-label">Match</p>
              <div className="relative mt-2">
                <select
                  value={selectedMatchId ?? ""}
                  onChange={(event) => void handleMatchChange(event.target.value)}
                  className="desk-select-compact h-auto w-full py-2.5"
                >
                  {matches.map((match) => (
                    <option key={match.id} value={match.id}>
                      {getMatchTitle(match)}
                    </option>
                  ))}
                </select>
              </div>
              <p className="mt-2 text-[13px] text-[var(--desk-text-muted)]">
                {selectedMatch ? `${getMatchTitle(selectedMatch)} · ${String(selectedMatch.metadata.status ?? "idle")}` : "No match selected"}
              </p>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div className="rounded-lg border border-[var(--desk-border)] bg-[var(--desk-bg-surface)] p-3">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-[var(--desk-text-faint)]">Status</p>
                <p className="mt-1 text-lg font-semibold">{fuelAnalysis?.status ?? "idle"}</p>
              </div>
              <div className="rounded-lg border border-[var(--desk-border)] bg-[var(--desk-bg-surface)] p-3">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-[var(--desk-text-faint)]">Progress</p>
                <p className="mt-1 text-lg font-semibold">{progressPercent(fuelAnalysis)}%</p>
              </div>
              <div className="rounded-lg border border-[var(--desk-border)] bg-[var(--desk-bg-surface)] p-3">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-[var(--desk-text-faint)]">Fuel color</p>
                <div className="mt-2 flex items-center gap-2">
                  <span className="h-7 w-7 shrink-0 rounded-md border border-[var(--desk-border)]" style={{ backgroundColor: colorToHex(activeColor) }} />
                  <span className="font-mono text-[11px] text-[var(--desk-text-muted)]">{activeColor.join(", ")}</span>
                </div>
              </div>
            </div>
          </div>

          <div className="grid gap-4 xl:grid-cols-[minmax(0,1.2fr)_minmax(300px,0.8fr)]">
            <section className="desk-stage-panel overflow-hidden border-[var(--desk-border)] bg-black">
              <div className="desk-stage-toolbar">
                <div>
                  <p className="desk-section-label mb-0.5">Calibration video</p>
                  <p className="text-[14px] font-medium">{selectedMatch ? getMatchTitle(selectedMatch) : "Select a match"}</p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <div className="desk-segmented">
                    <button
                      type="button"
                      className={interactionMode === "calibrate" ? "desk-segmented__btn desk-segmented__btn--on" : "desk-segmented__btn"}
                      onClick={() => setInteractionMode("calibrate")}
                    >
                      Place points
                    </button>
                    <button
                      type="button"
                      className={interactionMode === "video" ? "desk-segmented__btn desk-segmented__btn--on" : "desk-segmented__btn"}
                      onClick={() => setInteractionMode("video")}
                    >
                      Video
                    </button>
                  </div>
                  <button
                    type="button"
                    className={pickFuelColor ? "desk-segmented__btn desk-segmented__btn--on rounded-md px-3 py-1.5 text-[12px]" : "desk-btn desk-btn--ghost text-[12px]"}
                    onClick={() => {
                      setPickFuelColor((c) => !c);
                      setInteractionMode("calibrate");
                    }}
                  >
                    {pickFuelColor ? "Cancel pick" : "Pick color"}
                  </button>
                  <button
                    type="button"
                    className="desk-btn desk-btn--primary text-[12px] disabled:opacity-40"
                    disabled={!selectedMatchId || draftPoints[selectedTarget].length !== 4}
                    onClick={() => void handleSaveTarget(selectedTarget)}
                  >
                    Save {TARGET_LABELS[selectedTarget]}
                  </button>
                  <button
                    type="button"
                    className="desk-btn desk-btn--ghost text-[12px] disabled:opacity-40"
                    disabled={!selectedMatchId}
                    onClick={() => void handleClearTarget(selectedTarget)}
                  >
                    Clear
                  </button>
                </div>
              </div>
              <div ref={videoWrapRef} className="relative bg-black" style={{ aspectRatio: "16 / 10" }}>
                {sourceVideoUrl ? (
                  <>
                    <video
                      ref={videoRef}
                      src={sourceVideoUrl}
                      className="h-full w-full object-contain"
                      controls
                      playsInline
                      preload="metadata"
                      onLoadStart={() => setVideoError(null)}
                      onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
                      onLoadedMetadata={(event) => setVideoDuration(event.currentTarget.duration || 0)}
                      onError={() => setVideoError(`Video failed to load`)}
                    />
                    <div
                      className={`absolute inset-0 ${interactionMode === "calibrate" || pickFuelColor ? "pointer-events-auto cursor-crosshair" : "pointer-events-none"}`}
                      onPointerDown={(event) => void handleVideoPointer(event)}
                    />
                    {displayedPoints.map((point, index) => (
                      <div
                        key={`${selectedTarget}-${index}-${point[0]}-${point[1]}`}
                        className="pointer-events-none absolute h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-[var(--desk-warn)] shadow-[0_0_0_3px_rgba(210,153,34,0.2)]"
                        style={{
                          left: `${point[0] * 100}%`,
                          top: `${point[1] * 100}%`,
                        }}
                      />
                    ))}
                  </>
                ) : (
                  <div className="flex h-full min-h-[240px] items-center justify-center text-[13px] text-[var(--desk-text-muted)]">
                    No playable source video for this match.
                  </div>
                )}
              </div>
              <div className="border-t border-[var(--desk-border)] bg-[var(--desk-bg-elevated)] px-4 py-3 text-[12px] text-[var(--desk-text-muted)]">
                {pickFuelColor
                  ? "Click a fuel pixel on the paused frame."
                  : interactionMode === "calibrate"
                    ? `${TARGET_LABELS[selectedTarget]}: ${activePoints.length}/4 · ${formatTime(currentTime)} / ${formatTime(videoDuration)}`
                    : `Scrub with native controls · ${formatTime(currentTime)} / ${formatTime(videoDuration)}`}
                {videoError ? <p className="mt-1 text-[var(--desk-danger)]">{videoError}</p> : null}
              </div>
            </section>

            <aside className="flex flex-col gap-4">
              <section className="desk-card">
                <p className="desk-section-label">Targets</p>
                <div className="mt-3 grid gap-2">
                  {(Object.keys(TARGET_LABELS) as CalibrationTarget[]).map((target) => (
                    <button
                      key={target}
                      type="button"
                      onClick={() => setSelectedTarget(target)}
                      className={
                        selectedTarget === target
                          ? "rounded-lg border border-[rgba(59,142,234,0.45)] bg-[var(--desk-accent-muted)] px-3 py-2.5 text-left text-[13px] text-[var(--desk-text)]"
                          : "rounded-lg border border-[var(--desk-border)] bg-[var(--desk-bg-surface)] px-3 py-2.5 text-left text-[13px] text-[var(--desk-text-muted)] hover:bg-[var(--desk-bg-hover)]"
                      }
                    >
                      <span className="flex justify-between gap-2">
                        <span>{TARGET_LABELS[target]}</span>
                        <span className="font-mono text-[11px]">{draftPoints[target].length}/4</span>
                      </span>
                    </button>
                  ))}
                </div>
                <button
                  type="button"
                  className="desk-btn desk-btn--primary mt-4 w-full"
                  disabled={!selectedMatchId || !fuelCalibration?.ground_quad || fuelAnalysis?.status === "processing"}
                  onClick={() => void handleProcessFuel()}
                >
                  {fuelAnalysis?.status === "processing" ? "Processing…" : "Run fuel processing"}
                </button>
                {fuelAnalysis?.last_error ? (
                  <p className="mt-3 rounded-lg border border-[rgba(248,81,73,0.35)] bg-[rgba(248,81,73,0.08)] px-3 py-2 text-[12px] text-[#ffb4b0]">
                    {fuelAnalysis.last_error}
                  </p>
                ) : null}
              </section>

              <section className="desk-card">
                <p className="desk-section-label">Artifacts</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  {overlayVideoUrl ? <a href={overlayVideoUrl} target="_blank" rel="noreferrer" className="desk-btn desk-btn--ghost text-[11px] py-1">Overlay video</a> : null}
                  {overlayImageUrl ? <a href={overlayImageUrl} target="_blank" rel="noreferrer" className="desk-btn desk-btn--ghost text-[11px] py-1">Overlay image</a> : null}
                  {transparentOverlayUrl ? <a href={transparentOverlayUrl} target="_blank" rel="noreferrer" className="desk-btn desk-btn--ghost text-[11px] py-1">Transparent</a> : null}
                  {fieldMapUrl ? <a href={fieldMapUrl} target="_blank" rel="noreferrer" className="desk-btn desk-btn--ghost text-[11px] py-1">Field map</a> : null}
                  {airProfileUrl ? <a href={airProfileUrl} target="_blank" rel="noreferrer" className="desk-btn desk-btn--ghost text-[11px] py-1">Air profile</a> : null}
                  {statsUrl ? <a href={statsUrl} target="_blank" rel="noreferrer" className="desk-btn desk-btn--ghost text-[11px] py-1">Stats</a> : null}
                  {processLogUrl ? <a href={processLogUrl} target="_blank" rel="noreferrer" className="desk-btn desk-btn--ghost text-[11px] py-1">Log</a> : null}
                </div>
                {overlayVideoUrl ? (
                  <video src={overlayVideoUrl} className="mt-3 w-full rounded-lg border border-[var(--desk-border)] bg-black object-contain" style={{ aspectRatio: "16 / 9" }} controls playsInline preload="metadata" />
                ) : overlayImageUrl ? (
                  <img src={overlayImageUrl} alt="Fuel overlay" className="mt-3 w-full rounded-lg border border-[var(--desk-border)] bg-black object-contain" />
                ) : (
                  <p className="mt-3 text-[12px] text-[var(--desk-text-muted)]">Run processing to generate outputs.</p>
                )}
              </section>

              <section className="desk-card">
                <p className="desk-section-label">Stats</p>
                <pre className="mt-3 max-h-[280px] overflow-auto rounded-lg border border-[var(--desk-border)] bg-[#0b0f16] p-3 font-mono text-[11px] leading-relaxed text-[#c8d2e0]">
                  {formatJson(fuelAnalysis?.stats)}
                </pre>
              </section>
            </aside>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function FuelPage() {
  return (
    <Suspense fallback={<div className="desk-root min-h-screen bg-[var(--desk-bg)]" />}>
      <FuelPageContent />
    </Suspense>
  );
}
