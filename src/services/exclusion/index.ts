// src/services/exclusion/index.ts
export { isProjectExcluded, normalizeFolderPath } from 'services/exclusion/match.ts';
export { loadExcludedProjects, EXCLUDED_PROJECTS_FILE_NAME } from 'services/exclusion/load.ts';
export { resolveCwdFromHead, HEAD_SCAN_BYTES } from 'services/exclusion/head-cwd.ts';
