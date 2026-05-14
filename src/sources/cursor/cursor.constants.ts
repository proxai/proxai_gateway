import type { BodyCompression, BodyFormat, SourceApp, SourceKind } from 'services/contract';

export const CURSOR_SOURCE_APP: SourceApp = 'cursor';
export const CURSOR_SOURCE_KIND: SourceKind = 'sqlite_kv_snapshot';
export const CURSOR_BODY_FORMAT: BodyFormat = 'kv_pairs_json';
export const CURSOR_BODY_COMPRESSION: BodyCompression = 'zstd';

export const CURSOR_USER_SUBPATH = 'Library/Application Support/Cursor/User';
export const CURSOR_LINUX_USER_SUBPATH = '.config/Cursor/User';
export const CURSOR_WINDOWS_USER_SUBPATH = 'Cursor/User';
export const CURSOR_GLOBAL_DB_RELATIVE = 'globalStorage/state.vscdb';
export const CURSOR_WORKSPACE_GLOB = 'workspaceStorage/*/state.vscdb';

export const CURSOR_DISK_KV_TABLE = 'cursorDiskKV';

export const CURSOR_KEY_PREFIX_COMPOSER = 'composerData:';
export const CURSOR_KEY_PREFIX_BUBBLE = 'bubbleId:';
export const CURSOR_KEY_PREFIX_AGENT_KV_BLOB = 'agentKv:blob:';
export const CURSOR_KEY_PREFIX_COMPOSER_CONTENT = 'composer.content.';

export const CURSOR_DEFAULT_AGENT_SCHEMA_VERSION = 'unknown';
