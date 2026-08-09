export {
  SnapshotError,
  type PathRejection,
  type SnapshotErrorCode,
} from "./errors.js";
export {
  checkWorkspacePath,
  compareWorkspacePaths,
  isWithin,
  isWorkspacePath,
  workspacePath,
  workspacePathFromSegments,
  type PathLimits,
  type WorkspacePath,
} from "./paths.js";
export {
  DEFAULT_IGNORE_PATTERNS,
  DEFAULT_PATH_POLICY,
  DEFAULT_SECRET_PATTERNS,
  classifyPath,
  pathPolicy,
  type EntryKind,
  type ExclusionReason,
  type PathDecision,
  type PathPolicy,
} from "./policy.js";
export {
  SNAPSHOT_HASH_ALGORITHM,
  SNAPSHOT_MANIFEST_VERSION,
  blobRef,
  buildManifest,
  contentRefEquals,
  diffManifests,
  isContentRef,
  manifestBlobRefs,
  parseManifest,
  serializeManifest,
  verifyManifest,
  type FileMode,
  type ManifestChange,
  type ManifestDiff,
  type ManifestFile,
  type ManifestFileInput,
  type ManifestInput,
  type ManifestLimits,
  type SnapshotManifest,
} from "./manifest.js";
export { ContentStore, type ContentStoreOptions } from "./store.js";
export {
  captureWorkspace,
  type CaptureOptions,
  type CaptureResult,
  type ExcludedEntry,
} from "./capture.js";
export {
  restoreSnapshot,
  type RestoreOptions,
  type RestoreResult,
} from "./restore.js";
