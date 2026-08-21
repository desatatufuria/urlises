export const ROOT_FOLDER_TITLE = "URLises";
export const LOCAL_ONLY_FOLDER_TITLE = "Personal (not synced)";
export const DEFAULT_BACKEND_URL = "http://localhost:8081";
// Fallback only. The real value is fetched from the backend's public
// GET /config/public (see shared/api.ts's getPublicConfig and
// backend/internal/config/config.go's AppConfig.PublicBaseURL) and cached in
// settings.publicBaseUrl once per session start/login (see
// background/projection.ts's refreshPublicConfig). This constant is used
// only when that fetch hasn't happened yet or the configured backend
// doesn't support the endpoint (e.g. an older deployment) — it mirrors this
// repo's docker-compose.yml dev default (admin-web on :5173) so a
// locally-created share link still resolves out of the box in that case.
export const DEFAULT_PUBLIC_BASE_URL = "http://localhost:5173";
export const STORAGE_KEY = "sharedBookmarkSyncState";
export const ACCESS_TOKEN_STORAGE_KEY = "sharedBookmarkSyncAccessToken";
export const DIAGNOSTIC_LIMIT = 50;
export const CLIENT_ID_HEADER = "X-Client-Id";
export const SESSION_CAPABILITY_HEADER = "X-Session-Capability";
export const RENEWABLE_SESSION_CAPABILITY = "renewable-v1";
export const SYNC_EVENT_ID_HEADER = "X-Sync-Event-Id";
export const SYNC_BASE_CURSOR_HEADER = "X-Sync-Base-Cursor";
export const SYNC_CURSOR_HEADER = "X-Sync-Cursor";
export const SYNC_DUPLICATE_HEADER = "X-Sync-Duplicate";
export const UI_TIME_ZONE = "Europe/Madrid";
export const UI_TIME_LOCALE = "en-GB";
