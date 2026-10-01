import { config } from "../config.ts";
import type { ReportScope } from "@aihot/contracts/site";
import { reportPath } from "@aihot/contracts/http-policy";

// Absolute links always use the configured address (SITE_URL), never the request Host: a CDN or proxy
// may send a different Host to the origin.
export const siteUrl = (path: string): string => `${config.siteUrl}${path}`;
export const itemUrl = (id: string): string => siteUrl(`/items/${id}`);
export const storyUrl = (publicId: string): string => siteUrl(`/story/${publicId}`);
export const dailyUrl = (scope: ReportScope, date: string): string => siteUrl(reportPath("daily", scope, date));
export const storyApiUrl = (publicId: string): string => siteUrl(`/api/v1/stories/${publicId}`);
