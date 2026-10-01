// RSS routes. Optional domain scopes the feed; unknown query parameters never change content.
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { RSS_CACHE_CONTROL } from "@aihot/contracts/http-policy";
import { dailyFeed, isFeedCategory, itemFeed, type ItemFeedKind } from "@aihot/backend/publication/feeds";
import { domainParam } from "./v1.ts";
import { looseQuery, applyPublicHeaders, sendTextWithEtag, QueryError, sendProblem } from "../http/respond.ts";

async function sendFeed(req: FastifyRequest, reply: FastifyReply, xml: string) {
  applyPublicHeaders(reply, { cors: false });
  return sendTextWithEtag(req, reply, xml, { etagPrefix: "rss", cacheControl: RSS_CACHE_CONTROL, contentType: "application/rss+xml; charset=utf-8" });
}

function feedError(req: FastifyRequest, reply: FastifyReply, error: unknown) {
  if (error instanceof QueryError) return sendProblem(req, reply, { status: 400, code: "invalid_query", detail: error.message });
  req.log.error({ err: error }, "feed error");
  return reply.code(503).header("Retry-After", "60").header("Cache-Control", "no-store").type("text/plain; charset=utf-8").send("Feed temporarily unavailable");
}

export function registerFeeds(app: FastifyInstance) {
  // A preflight gets 204 and the allowed methods; feeds send no CORS headers.
  for (const url of ["/feed.xml", "/feed/full.xml", "/feed/all.xml", "/feed/daily.xml", "/feed/category/:file", "/feed/full/category/:file"]) {
    app.options(url, async (_req, reply) => reply.code(204).header("Allow", "GET, HEAD, OPTIONS").send());
  }
  const item = (kind: ItemFeedKind) => async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      return await sendFeed(req, reply, await itemFeed(kind, null, domainParam(looseQuery(req).domain)));
    } catch (error) {
      return feedError(req, reply, error);
    }
  };
  app.get("/feed.xml", item("selected"));
  app.get("/feed/full.xml", item("selected-full"));
  app.get("/feed/all.xml", item("all"));
  app.get("/feed/daily.xml", async (req, reply) => {
    try {
      return await sendFeed(req, reply, await dailyFeed(domainParam(looseQuery(req).domain) ?? "all"));
    } catch (error) {
      return feedError(req, reply, error);
    }
  });
  for (const full of [false, true]) {
    app.get(full ? "/feed/full/category/:file" : "/feed/category/:file", async (req, reply) => {
      const file = (req.params as { file: string }).file;
      const slug = file.replace(/\.xml$/, "");
      if (!file.endsWith(".xml") || !isFeedCategory(slug)) return reply.code(404).type("text/plain; charset=utf-8").send("Not found");
      try {
        return await sendFeed(req, reply, await itemFeed(full ? "selected-full" : "selected", slug, domainParam(looseQuery(req).domain)));
      } catch (error) {
        return feedError(req, reply, error);
      }
    });
  }
}
