export type ViewName = "left" | "main" | "right";

export interface JobLogEntry {
  timestamp: number;
  level: "info" | "warning" | "error";
  message: string;
}

export interface SourceSubmission {
  source_kind: "upload" | "youtube" | "watchbot";
  source_url?: string | null;
  source_name: string;
  stored_path?: string | null;
  requested_match_name?: string | null;
}

export interface JobRecord {
  id: string;
  created_at: number;
  updated_at: number;
  status: "queued" | "running" | "completed" | "failed";
  source: SourceSubmission;
  logs: JobLogEntry[];
  match_id?: string | null;
  error?: string | null;
}

export interface FieldLandmark {
  name: string;
  image_point: number[];
  field_point: number[];
  confidence: number;
}

export interface ViewCalibration {
  view: ViewName;
  roi: number[];
  homography: number[][];
  landmarks: FieldLandmark[];
  distortion_strength?: number;
  distortion_x?: number;
  distortion_y?: number;
  reprojection_error?: number | null;
  confidence: number;
  fallback_reason?: string | null;
}

export interface CalibrationEnvelope {
  mode: "auto_calibration" | "manual_override" | "blended" | "manual_fallback";
  created_at: number;
  updated_at: number;
  quality_checks: Record<string, unknown>;
  views: ViewCalibration[];
}

export interface CalibrationPreset {
  id: string;
  name: string;
  created_at: number;
  updated_at: number;
  calibration: CalibrationEnvelope;
}

export interface DetectionRecord {
  frame: number;
  time: number;
  view: ViewName;
  source_confidence: number;
  image_anchor: number[];
  field_point: number[];
  bbox?: number[] | null;
}

export interface TrackRecord {
  frame: number;
  time: number;
  track_id: number;
  x: number;
  y: number;
  confidence: number;
  source_views: ViewName[];
  source_detection_indices: number[];
  tracking_source?: "detection" | "image_tracker";
  image_view?: ViewName | null;
  image_anchor?: number[] | null;
  image_bbox?: number[] | null;
}

export interface MatchArtifacts {
  source_video?: string | null;
  trimmed_video?: string | null;
  annotated_video?: string | null;
  topdown_replay?: string | null;
  calibration_preview?: string | null;
  debug_snapshot?: string | null;
}

export interface FuelCalibration {
  ground_quad?: number[][] | null;
  left_wall_quad?: number[][] | null;
  right_wall_quad?: number[][] | null;
  fuel_base_color: number[];
  updated_at?: number | null;
}

export interface FuelCalibrationPreset {
  id: string;
  name: string;
  created_at: number;
  updated_at: number;
  fuel_calibration: FuelCalibration;
}

export interface FuelArtifactSet {
  overlay_image?: string | null;
  overlay_transparent_image?: string | null;
  overlay_video?: string | null;
  raw_data?: string | null;
  field_map?: string | null;
  air_profile?: string | null;
  stats_file?: string | null;
  process_log?: string | null;
}

export interface FuelProcessingProgress {
  phase: string;
  current: number;
  total: number;
  started_at: number;
  updated_at: number;
}

export interface FuelAnalysisRecord {
  status: "idle" | "ready" | "processing" | "completed" | "error";
  artifacts: FuelArtifactSet;
  stats: Record<string, unknown>;
  last_error?: string | null;
  processing_progress?: FuelProcessingProgress | null;
  updated_at?: number | null;
}

export interface FuelStateResponse {
  match_id: string;
  fuel_calibration: FuelCalibration;
  fuel_analysis: FuelAnalysisRecord;
}

export interface MatchSummary {
  id: string;
  created_at: number;
  updated_at: number;
  metadata: Record<string, unknown>;
  artifacts: MatchArtifacts;
  labels: Record<string, string>;
}

export interface MatchRecord {
  id: string;
  created_at: number;
  updated_at: number;
  metadata: Record<string, unknown>;
  source: Record<string, unknown>;
  calibration: CalibrationEnvelope;
  detections: DetectionRecord[];
  tracks: TrackRecord[];
  artifacts: MatchArtifacts;
  fuel_calibration?: FuelCalibration;
  fuel_analysis?: FuelAnalysisRecord;
  labels: Record<string, string>;
  debug: Record<string, unknown>;
}

export interface WatchbotState {
  active: boolean;
  stream_url?: string | null;
  started_at?: number | null;
  updated_at?: number | null;
  last_message?: string | null;
  capture_directory?: string | null;
}

export interface TbaMatch {
  key: string;
  event_key?: string | null;
  comp_level?: string | null;
  match_number?: number | null;
  set_number?: number | null;
  alliances?: Record<string, unknown>;
  videos?: Array<Record<string, unknown>>;
}

/** Fuel processor `field-map.json` (see fuel-density-map processor export). */
export type FieldMapPoint = [number, number, number];

export interface FieldMapData {
  imageWidth: number;
  imageHeight: number;
  fps: number;
  frameCount: number;
  frames: FieldMapPoint[][];
}

export type AirProfilePoint = [number, number];

export interface AirProfileData {
  fps: number;
  frameCount: number;
  wallSide?: "top" | "bottom" | "left" | "right" | "mixed";
  frames: AirProfilePoint[][];
}
