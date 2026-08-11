// Minimal URLPattern-based router. A plain HTTP handler — no framework — so
// the worker can be re-hosted on a VPS (Node/Bun) with the same routes.

import type { Env } from "./env";
import { handleError, json } from "./http";
import { requireAdmin, requireAuth, type AuthContext } from "./middleware";
import { Repository } from "./repository";

export interface RouteContext {
  request: Request;
  env: Env;
  repo: Repository;
  params: Record<string, string>;
  url: URL;
  auth?: AuthContext;
}

export type Handler = (ctx: RouteContext) => Promise<Response> | Response;

interface Route {
  method: string;
  pattern: URLPattern;
  handler: Handler;
  auth?: "user" | "admin";
}

export class Router {
  private routes: Route[] = [];

  constructor(private repo: Repository) {}

  add(method: string, path: string, handler: Handler, auth?: "user" | "admin"): void {
    this.routes.push({ method, pattern: new URLPattern({ pathname: path }), handler, auth });
  }

  get(path: string, handler: Handler, auth?: "user" | "admin"): void {
    this.add("GET", path, handler, auth);
  }

  post(path: string, handler: Handler, auth?: "user" | "admin"): void {
    this.add("POST", path, handler, auth);
  }

  put(path: string, handler: Handler, auth?: "user" | "admin"): void {
    this.add("PUT", path, handler, auth);
  }

  patch(path: string, handler: Handler, auth?: "user" | "admin"): void {
    this.add("PATCH", path, handler, auth);
  }

  delete(path: string, handler: Handler, auth?: "user" | "admin"): void {
    this.add("DELETE", path, handler, auth);
  }

  async handle(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    for (const route of this.routes) {
      if (route.method !== request.method) continue;
      const match = route.pattern.exec(url);
      if (!match) continue;
      const ctx: RouteContext = {
        request,
        env,
        repo: this.repo,
        params: (match.pathname.groups ?? {}) as Record<string, string>,
        url,
      };
      try {
        if (route.auth === "user") ctx.auth = await requireAuth(request, env, this.repo);
        if (route.auth === "admin") await requireAdmin(request, env);
        return await route.handler(ctx);
      } catch (error) {
        return handleError(error);
      }
    }
    return json({ error: { code: "not_found", message: "Route not found" } }, 404);
  }
}
