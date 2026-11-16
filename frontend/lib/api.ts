import type {
  AnalyzeRequest,
  AnalyzeResponse,
  CoachRequest,
  CoachResponse,
  HealthResponse,
  StatusResponse,
} from "./types";

export const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE_URL}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    });
  } catch {
    throw new Error(
      `Could not reach the analysis server at ${API_BASE_URL}. Is the backend running?`,
    );
  }
  if (!res.ok) {
    let detail = `Request failed (${res.status})`;
    try {
      const body = (await res.json()) as { detail?: string; error?: string };
      detail = body.detail ?? body.error ?? detail;
    } catch {
      // keep generic detail
    }
    throw new Error(detail);
  }
  return (await res.json()) as T;
}

export function getHealth(): Promise<HealthResponse> {
  return request<HealthResponse>("/api/health");
}

export function startAnalysis(body: AnalyzeRequest): Promise<AnalyzeResponse> {
  return request<AnalyzeResponse>("/api/analyze", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function getJobStatus(jobId: string): Promise<StatusResponse> {
  return request<StatusResponse>(`/api/status/${encodeURIComponent(jobId)}`);
}

export function getCoaching(body: CoachRequest): Promise<CoachResponse> {
  return request<CoachResponse>("/api/coach", {
    method: "POST",
    body: JSON.stringify(body),
  });
}
