// DomBook SaaS backend entry point: Cloudflare Worker exposing a plain HTTP
// API. Composition root — wires the D1 binding into the Repository and the
// route tables. No Cloudflare-specific logic lives outside this file + the
// D1 binding, which keeps the VPS portability path open.

import { AuthService } from "./auth";
import { buildAdminRouter } from "./admin";
import { handleError, json } from "./http";
import { Repository } from "./repository";
import { buildRouter } from "./routes";
import type { Env } from "./env";

function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", "*");
  headers.set("access-control-allow-methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  headers.set("access-control-allow-headers", "content-type, authorization, x-client-id");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function handleOptions(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
      "access-control-allow-headers": "content-type, authorization, x-client-id",
      "access-control-max-age": "86400",
    },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") return handleOptions();

    const repo = new Repository(env.DB);
    const auth = new AuthService(env, repo);
    const customerRouter = buildRouter(repo, auth);
    const adminRouter = buildAdminRouter(repo);

    try {
      const url = new URL(request.url);
      if (url.pathname.startsWith("/admin/")) {
        return withCors(await adminRouter.handle(request, env));
      }
      return withCors(await customerRouter.handle(request, env));
    } catch (error) {
      return withCors(handleError(error));
    }
  },
} satisfies ExportedHandler<Env>;
