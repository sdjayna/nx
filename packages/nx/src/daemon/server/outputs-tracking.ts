import { lstatSync } from 'fs';
import { dirname, join } from 'path';
import { WatchEvent, getFilesForOutputsBatch } from '../../native';
import { collapseExpandedOutputs } from '../../utils/collapse-expanded-outputs';
import { isGlobPattern } from '../../utils/globs';
import { workspaceRoot } from '../../utils/workspace-root';

let disabled = false;

const dirsContainingOutputs = {} as { [dir: string]: Set<string> };
const recordedHashes = {} as { [output: string]: string };
const timestamps = {} as { [output: string]: number };
const numberOfExpandedOutputs = {} as { [hash: string]: number };
/** Files found under the outputs when the hash was recorded, per hash. */
const numberOfFiles = {} as { [hash: string]: number };
/** Hashes recorded before a watcher rescan; verified on their next check. */
const unverifiedHashes = new Set<string>();
/**
 * How far before the record a write may be dated and still count as made
 * after it. The kernel stamps mtimes from a coarse clock that lags Date.now()
 * by up to a scheduler tick, so a write made just after the record can carry
 * an mtime at or before it. Kept small because restored files are written
 * milliseconds before their record.
 */
const RECORD_CLOCK_SLACK_MS = 5;

export function _recordOutputsHash(
  outputs: string[],
  hash: string,
  fileCount: number
) {
  numberOfExpandedOutputs[hash] = outputs.length;
  numberOfFiles[hash] = fileCount;
  unverifiedHashes.delete(hash);
  for (const output of outputs) {
    recordedHashes[output] = hash;
    timestamps[output] = new Date().getTime();

    let current = output;
    while (current != dirname(current)) {
      if (!dirsContainingOutputs[current]) {
        dirsContainingOutputs[current] = new Set<string>();
      }
      dirsContainingOutputs[current].add(output);
      current = dirname(current);
    }
  }
}

export function _outputsHashesMatch(outputs: string[], hash: string) {
  if (outputs.length !== numberOfExpandedOutputs[hash]) {
    return false;
  } else {
    for (const output of outputs) {
      if (recordedHashes[output] !== hash) {
        return false;
      }
    }
  }
  return true;
}

/**
 * When the path was last written or put in place: the larger of its mtime and
 * its ctime. A copy can carry its source's mtime (std::fs::copy does on macOS
 * and Windows, so a cache restore does), but nothing in user space sets ctime,
 * so a file replaced after the record is dated after it even when its content
 * was written long before. A path that no longer exists is dated by its
 * nearest existing ancestor, whose times moved when the entry was removed.
 * Infinity if nothing up to the workspace root can be read.
 */
function lastModified(path: string): number {
  let current = path;
  while (true) {
    try {
      const stat = lstatSync(join(workspaceRoot, current));
      return Math.max(stat.mtimeMs, stat.ctimeMs);
    } catch (e) {
      if (e?.code !== 'ENOENT' || current === dirname(current)) {
        return Infinity;
      }
      current = dirname(current);
    }
  }
}

export function processFileChangesInOutputs(changeEvents: WatchEvent[]) {
  for (let e of changeEvents) {
    let current = e.path;

    // the path is either an output itself or a parent
    if (dirsContainingOutputs[current]) {
      let modified: number;
      dirsContainingOutputs[current].forEach((output) => {
        if (recordedHashes[output]) {
          modified ??= lastModified(current);
          if (modified > timestamps[output]) {
            recordedHashes[output] = undefined;
          }
        }
      });
      continue;
    }

    // the path is a child of some output or unrelated
    while (current != dirname(current)) {
      if (recordedHashes[current]) {
        if (lastModified(e.path) > timestamps[current]) {
          recordedHashes[current] = undefined;
        }
        break;
      }
      current = dirname(current);
    }
  }
}

/**
 * Check whether the on-disk outputs of each entry still match the hash
 * the daemon recorded for them. Uses Rayon-parallel filesystem scanning
 * for uncached entries.
 */
export function outputsHashesMatchBatch(
  entries: { outputs: string[]; hash: string }[]
): boolean[] {
  if (disabled) return entries.map(() => false);

  // Fast path: skip filesystem scan for entries with no recorded hash.
  // _outputsHashesMatch will return false immediately if the hash isn't
  // in numberOfExpandedOutputs, so scanning the filesystem is wasted work.
  const needsScan: number[] = [];
  const results: boolean[] = new Array(entries.length);
  for (let i = 0; i < entries.length; i++) {
    if (numberOfExpandedOutputs[entries[i].hash] === undefined) {
      results[i] = false;
    } else {
      needsScan.push(i);
    }
  }

  if (needsScan.length > 0) {
    // Only scan outputs for entries that have recorded hashes
    const outputsBatch = needsScan.map((i) => entries[i].outputs);
    const expandedBatch = getFilesForOutputsBatch(workspaceRoot, outputsBatch);

    for (let j = 0; j < needsScan.length; j++) {
      const { hash } = entries[needsScan[j]];
      const expanded = collapseExpandedOutputs(expandedBatch[j]);
      let matches = _outputsHashesMatch(expanded, hash);
      if (matches && unverifiedHashes.has(hash)) {
        matches = _verifyRecordedOutputs(expandedBatch[j], expanded, hash);
        if (!matches) {
          for (const output of expanded) {
            recordedHashes[output] = undefined;
          }
        }
        unverifiedHashes.delete(hash);
      }
      results[needsScan[j]] = matches;
    }
  }

  return results;
}

/**
 * Record the hash of each entry's on-disk outputs so future
 * outputsHashesMatchBatch calls can skip redundant cache copies.
 * Uses Rayon-parallel filesystem scanning.
 */
export function recordOutputsHashBatch(
  entries: { outputs: string[]; hash: string }[]
) {
  if (disabled) return;

  const outputsBatch = entries.map((e) => e.outputs);
  const expandedBatch = getFilesForOutputsBatch(workspaceRoot, outputsBatch);

  for (let i = 0; i < entries.length; i++) {
    const expanded = collapseExpandedOutputs(expandedBatch[i]);
    forgetOutputsNotFound(entries[i].outputs, expandedBatch[i]);
    _recordOutputsHash(expanded, entries[i].hash, expandedBatch[i].length);
  }
  _forgetUnreferencedHashes();
}

/**
 * Drop the recorded outputs under the declared outputs that the scan found no
 * file at or under. A build that names its files differently each time, as
 * content-hashed bundles do, leaves the old names recorded and its old hash
 * pinned by them. The scan of a plain path is exhaustive, so a recorded output
 * it found nothing under is gone; globs are skipped, as their scan is
 * filtered.
 */
function forgetOutputsNotFound(declared: string[], files: string[]) {
  const stale = new Set<string>();
  for (const root of declared) {
    if (root.startsWith('!') || isGlobPattern(root)) {
      continue;
    }
    const recorded = dirsContainingOutputs[root.replace(/\/+$/, '')];
    if (recorded) {
      for (const output of recorded) {
        stale.add(output);
      }
    }
  }
  if (stale.size === 0) {
    return;
  }
  for (const file of files) {
    let current = file;
    while (stale.size > 0 && current !== dirname(current)) {
      stale.delete(current);
      current = dirname(current);
    }
  }
  for (const output of stale) {
    forgetOutput(output);
  }
}

function forgetOutput(output: string) {
  delete recordedHashes[output];
  delete timestamps[output];
  let current = output;
  while (current !== dirname(current)) {
    const outputs = dirsContainingOutputs[current];
    if (outputs) {
      outputs.delete(output);
      if (outputs.size === 0) {
        delete dirsContainingOutputs[current];
      }
    }
    current = dirname(current);
  }
}

/**
 * Drop the records nothing can match any more: outputs whose hash a change
 * event or a failed verification removed, and the per-hash records of hashes
 * no output refers to. A record for an output replaces the previous hash of
 * that output, so a changed input leaves behind a hash nothing can match;
 * clearing on rescan used to be the only thing that ever removed any of these.
 * A hash recorded for outputs that expanded to no files has no output to refer
 * to it and is kept: it matches while the outputs still expand to nothing, and
 * a file appearing under them changes the count and fails the match.
 */
export function _forgetUnreferencedHashes() {
  for (const output of Object.keys(recordedHashes)) {
    if (recordedHashes[output] === undefined) {
      forgetOutput(output);
    }
  }
  const live = new Set(Object.values(recordedHashes));
  for (const hash of Object.keys(numberOfExpandedOutputs)) {
    if (numberOfExpandedOutputs[hash] === 0) {
      live.add(hash);
    }
  }
  for (const store of [numberOfExpandedOutputs, numberOfFiles]) {
    for (const hash of Object.keys(store)) {
      if (!live.has(hash)) {
        delete store[hash];
      }
    }
  }
  for (const hash of unverifiedHashes) {
    if (!live.has(hash)) {
      unverifiedHashes.delete(hash);
    }
  }
}

/**
 * True if the files under the recorded outputs still look unchanged since the
 * record: the same number of files, and no file or directory up to the
 * recorded output dated later than the record, less a small slack for the
 * coarse clock mtimes come from. A write dated earlier than that is not
 * detected.
 */
export function _verifyRecordedOutputs(
  files: string[],
  outputs: string[],
  hash: string
) {
  if (files.length !== numberOfFiles[hash]) {
    return false;
  }
  const roots = new Set(outputs);
  const recordedAt = Math.min(...outputs.map((output) => timestamps[output]));
  if (Number.isNaN(recordedAt)) {
    return false;
  }
  const trustedUntil = recordedAt - RECORD_CLOCK_SLACK_MS;
  const dirs = new Set<string>();
  for (const file of files) {
    if (lastModified(file) > trustedUntil) {
      return false;
    }
    let dir = file;
    while (!roots.has(dir) && dir !== dirname(dir)) {
      dir = dirname(dir);
      if (dirs.has(dir)) {
        break;
      }
      dirs.add(dir);
    }
  }
  for (const dir of dirs) {
    if (lastModified(dir) > trustedUntil) {
      return false;
    }
  }
  return true;
}

/** Sizes of the record stores, for the specs. */
export function _recordCounts() {
  return {
    hashes: Object.keys(numberOfExpandedOutputs).length,
    outputs: Object.keys(recordedHashes).length,
    dirs: Object.keys(dirsContainingOutputs).length,
  };
}

/**
 * Events were dropped, so every recorded hash is verified against the files
 * on its next check instead of being cleared. Hashes recorded afterwards are
 * trusted as usual, and the tracker keeps running.
 */
export function markRecordedOutputsHashesUnverified() {
  for (const hash of Object.keys(numberOfExpandedOutputs)) {
    unverifiedHashes.add(hash);
  }
}

export function disableOutputsTracking() {
  disabled = true;
}
