export class ApiError extends Error {
  status: number;
  code: string;
  details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function badRequest(code: string, message: string, details?: unknown): ApiError {
  return new ApiError(400, code, message, details);
}

export function notFound(code = "not_found", message = "Not found"): ApiError {
  return new ApiError(404, code, message);
}

export function forbidden(code = "forbidden", message = "Forbidden"): ApiError {
  return new ApiError(403, code, message);
}

export function unauthorized(message = "Unauthorized"): ApiError {
  return new ApiError(401, "unauthorized", message);
}

export function json(data: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...headers,
    },
  });
}

export async function readJson(request: Request): Promise<Record<string, unknown>> {
  if (request.headers.get("content-type")?.includes("application/json")) {
    try {
      const body = await request.json();
      if (body && typeof body === "object") return body as Record<string, unknown>;
    } catch {
      throw badRequest("invalid_json", "Invalid JSON body");
    }
  }
  return {};
}

export function handleError(error: unknown): Response {
  if (error instanceof ApiError) {
    return json({ error: { code: error.code, message: error.message, details: error.details } }, error.status);
  }
  console.error("Unhandled error:", error);
  return json({ error: { code: "internal", message: "Internal server error" } }, 500);
}
