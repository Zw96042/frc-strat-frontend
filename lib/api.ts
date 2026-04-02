import {
  CalibrationEnvelope,
  FuelCalibration,
  FuelAnalysisRecord,
  FuelStateResponse,
  JobRecord,
  MatchRecord,
  MatchSummary,
  TbaMatch,
  WatchbotState,
} from "@/lib/types";

const DEV_API_BASE = "http://127.0.0.1:8000";

function getApiBase(): string {
  const configuredBase = process.env.NEXT_PUBLIC_TRACKING_API_BASE?.trim();
  if (configuredBase) {
    return configuredBase.replace(/\/$/, "");
  }

  if (typeof window === "undefined") {
    return "";
  }

  const { hostname, origin } = window.location;
  if (hostname === "localhost" || hostname === "127.0.0.1") {
    return DEV_API_BASE;
  }

  return origin.replace(/\/$/, "");
}

export class ApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

function fuelEndpointMessage(action: string): string {
  return `Fuel ${action} is unavailable on the current backend. Restart the frc-strat backend so the new fuel API routes are loaded.`;
}

function buildUrl(path: string): string {
  return `${getApiBase()}${path}`;
}

function defaultFuelCalibration(match?: MatchRecord): FuelCalibration {
  return {
    ground_quad: match?.fuel_calibration?.ground_quad ?? null,
    left_wall_quad: match?.fuel_calibration?.left_wall_quad ?? null,
    right_wall_quad: match?.fuel_calibration?.right_wall_quad ?? null,
    fuel_base_color: match?.fuel_calibration?.fuel_base_color ?? [255, 255, 0],
    updated_at: match?.fuel_calibration?.updated_at ?? null,
  };
}

function defaultFuelAnalysis(match?: MatchRecord): FuelAnalysisRecord {
  return {
    status: match?.fuel_analysis?.status ?? ((match?.fuel_calibration?.ground_quad?.length ?? 0) === 4 ? "ready" : "idle"),
    artifacts: match?.fuel_analysis?.artifacts ?? {},
    stats: match?.fuel_analysis?.stats ?? {},
    last_error: match?.fuel_analysis?.last_error ?? null,
    processing_progress: match?.fuel_analysis?.processing_progress ?? null,
    updated_at: match?.fuel_analysis?.updated_at ?? null,
  };
}

async function handleJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const message = await response.text();
    throw new ApiError(message || `Request failed with ${response.status}`, response.status);
  }
  return response.json() as Promise<T>;
}

export async function fetchJobs(): Promise<JobRecord[]> {
  return handleJson<JobRecord[]>(await fetch(buildUrl("/jobs"), { cache: "no-store" }));
}

export async function fetchJob(jobId: string): Promise<JobRecord> {
  return handleJson<JobRecord>(await fetch(buildUrl(`/jobs/${jobId}`), { cache: "no-store" }));
}

export async function deleteJob(jobId: string): Promise<{ deleted: boolean; job_id: string }> {
  return handleJson<{ deleted: boolean; job_id: string }>(
    await fetch(buildUrl(`/jobs/${jobId}`), {
      method: "DELETE",
    }),
  );
}

export async function fetchMatches(): Promise<MatchSummary[]> {
  return handleJson<MatchSummary[]>(await fetch(buildUrl("/matches"), { cache: "no-store" }));
}

export async function fetchMatch(matchId: string): Promise<MatchRecord> {
  return handleJson<MatchRecord>(await fetch(buildUrl(`/matches/${matchId}`), { cache: "no-store" }));
}

export async function deleteMatch(matchId: string): Promise<{ deleted: boolean; match_id: string }> {
  return handleJson<{ deleted: boolean; match_id: string }>(
    await fetch(buildUrl(`/matches/${matchId}`), {
      method: "DELETE",
    }),
  );
}

export async function createSourceJob(formData: FormData): Promise<{ job: JobRecord }> {
  const file = formData.get("file");

  if (file instanceof File) {
    const params = new URLSearchParams();
    params.set("upload_name", file.name);
    const matchName = formData.get("match_name");
    if (typeof matchName === "string" && matchName.trim()) {
      params.set("match_name", matchName.trim());
    }

    return handleJson<{ job: JobRecord }>(
      await fetch(buildUrl(`/sources/upload?${params.toString()}`), {
        method: "POST",
        headers: {
          "Content-Type": file.type || "application/octet-stream",
        },
        body: file,
      }),
    );
  }

  return handleJson<{ job: JobRecord }>(
    await fetch(buildUrl("/sources"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        match_name: formData.get("match_name"),
        youtube_url: formData.get("youtube_url"),
      }),
    }),
  );
}

export async function fetchWatchbot(): Promise<{ watchbot: WatchbotState }> {
  return handleJson<{ watchbot: WatchbotState }>(await fetch(buildUrl("/watchbot"), { cache: "no-store" }));
}

export async function startWatchbot(streamUrl: string): Promise<{ watchbot: WatchbotState }> {
  return handleJson<{ watchbot: WatchbotState }>(
    await fetch(buildUrl("/watchbot/start"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stream_url: streamUrl }),
    }),
  );
}

export async function stopWatchbot(): Promise<{ watchbot: WatchbotState }> {
  return handleJson<{ watchbot: WatchbotState }>(
    await fetch(buildUrl("/watchbot/stop"), {
      method: "POST",
    }),
  );
}

export async function updateMatchLabels(matchId: string, labels: Record<string, string>): Promise<{ labels: Record<string, string> }> {
  return handleJson<{ labels: Record<string, string> }>(
    await fetch(buildUrl(`/matches/${matchId}/labels`), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ labels }),
    }),
  );
}

export async function fetchCalibration(matchId: string): Promise<CalibrationEnvelope> {
  return handleJson<CalibrationEnvelope>(await fetch(buildUrl(`/matches/${matchId}/calibration`), { cache: "no-store" }));
}

export async function updateCalibration(matchId: string, calibration: CalibrationEnvelope): Promise<CalibrationEnvelope> {
  return handleJson<CalibrationEnvelope>(
    await fetch(buildUrl(`/matches/${matchId}/calibration`), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(calibration),
    }),
  );
}

export async function fetchFuelState(matchId: string): Promise<FuelStateResponse> {
  try {
    return await handleJson<FuelStateResponse>(await fetch(buildUrl(`/matches/${matchId}/fuel`), { cache: "no-store" }));
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 404) {
      throw error;
    }

    const match = await fetchMatch(matchId);
    return {
      match_id: match.id,
      fuel_calibration: defaultFuelCalibration(match),
      fuel_analysis: defaultFuelAnalysis(match),
    };
  }
}

export async function updateFuelCalibration(
  matchId: string,
  calibration: Partial<FuelCalibration>,
): Promise<FuelCalibration> {
  try {
    return await handleJson<FuelCalibration>(
      await fetch(buildUrl(`/matches/${matchId}/fuel-calibration`), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(calibration),
      }),
    );
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      throw new ApiError(fuelEndpointMessage("saving"), 404);
    }
    throw error;
  }
}

export async function updateFuelBaseColor(matchId: string, fuelBaseColor: number[]): Promise<FuelStateResponse | { fuel_base_color: number[]; fuel_calibration: FuelCalibration }> {
  try {
    return await handleJson<FuelStateResponse | { fuel_base_color: number[]; fuel_calibration: FuelCalibration }>(
      await fetch(buildUrl(`/matches/${matchId}/fuel/base-color`), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fuel_base_color: fuelBaseColor }),
      }),
    );
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      throw new ApiError(fuelEndpointMessage("color updates"), 404);
    }
    throw error;
  }
}

export async function sampleFuelBaseColor(
  matchId: string,
  x: number,
  y: number,
  timeSec: number,
): Promise<{ fuel_base_color: number[]; fuel_calibration: FuelCalibration }> {
  try {
    return await handleJson<{ fuel_base_color: number[]; fuel_calibration: FuelCalibration }>(
      await fetch(buildUrl(`/matches/${matchId}/fuel/base-color/sample`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ x, y, time_sec: timeSec }),
      }),
    );
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      throw new ApiError(fuelEndpointMessage("color sampling"), 404);
    }
    throw error;
  }
}

export async function processFuel(matchId: string): Promise<FuelStateResponse> {
  try {
    return await handleJson<FuelStateResponse>(
      await fetch(buildUrl(`/matches/${matchId}/fuel/process`), {
        method: "POST",
      }),
    );
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      throw new ApiError(fuelEndpointMessage("processing"), 404);
    }
    throw error;
  }
}

export async function fetchTeamSchedule(teamKey: string, year: number): Promise<{ team_key: string; year: number; matches: TbaMatch[] }> {
  return handleJson<{ team_key: string; year: number; matches: TbaMatch[] }>(
    await fetch(buildUrl(`/tba/team/${teamKey}/matches?year=${year}`), { cache: "no-store" }),
  );
}

export function resolveArtifactUrl(path?: string | null): string | null {
  if (!path) return null;
  if (path.startsWith("http://") || path.startsWith("https://")) return path;
  return buildUrl(path);
}
