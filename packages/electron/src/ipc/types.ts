/**
 * Shared types for IPC handler modules.
 */
import type { AppState } from '../app-state.js';

/** Dependencies passed to each IPC handler registration function */
export type IpcDeps = AppState;
