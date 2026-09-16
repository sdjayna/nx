import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { EventType } from '../../native';
import { setWorkspaceRoot } from '../../utils/workspace-root';
import {
  _forgetUnreferencedHashes,
  _outputsHashesMatch,
  _recordCounts,
  _recordOutputsHash,
  markRecordedOutputsHashesUnverified,
  outputsHashesMatchBatch,
  processFileChangesInOutputs,
  recordOutputsHashBatch,
} from './outputs-tracking';

// The tracker stats paths under the workspace root; point it at a scratch
// directory so the specs can write real files and set their mtimes.
const workspaceRoot = mkdtempSync(join(tmpdir(), 'nx-outputs-tracking-'));
beforeAll(() => setWorkspaceRoot(workspaceRoot));
afterAll(() => rmSync(workspaceRoot, { recursive: true, force: true }));

function setModified(path: string, time: number) {
  utimesSync(join(workspaceRoot, path), time / 1000, time / 1000);
}

/**
 * Record with the clock moved by `offset` ms. utimes and rm set ctime to the
 * current time and the record is dated by Date.now() in whole milliseconds,
 * so a record in the same millisecond as a setup write would read as older
 * than it; dating the record a second ahead of the setup writes (or a second
 * behind a write that must land after it) keeps the two clocks apart.
 */
function recordAt(
  offset: number,
  outputs: string[],
  hash: string,
  fileCount: number
) {
  vi.useFakeTimers({ now: Date.now() + offset });
  try {
    _recordOutputsHash(outputs, hash, fileCount);
  } finally {
    vi.useRealTimers();
  }
}

/** As recordAt, for a batch scanned from the files under the outputs. */
function recordBatchAt(
  offset: number,
  entries: { outputs: string[]; hash: string }[]
) {
  vi.useFakeTimers({ now: Date.now() + offset });
  try {
    recordOutputsHashBatch(entries);
  } finally {
    vi.useRealTimers();
  }
}

describe('outputs tracking', () => {
  const now = new Date().getTime() + 10000;

  // Events are dated by the path's mtime, so the paths these cases name exist
  // and were written after the record.
  beforeEach(() => {
    mkdirSync(join(workspaceRoot, 'dist/app/app1'), { recursive: true });
    writeFileSync(join(workspaceRoot, 'dist/app/app1/child'), 'built');
    for (const path of ['dist/app', 'dist/app/app1', 'dist/app/app1/child']) {
      setModified(path, now);
    }
  });

  afterEach(() => {
    rmSync(join(workspaceRoot, 'dist'), { recursive: true, force: true });
  });

  it('should record hashes', () => {
    _recordOutputsHash(['dist/app/app1'], '123', 1);
    expect(_outputsHashesMatch(['dist/app/app1'], '123')).toBeTruthy();
    expect(_outputsHashesMatch(['dist/app/app1'], '1234')).toBeFalsy();
    expect(
      _outputsHashesMatch(['dist/app/app1', 'dist/app/app1/different'], '1234')
    ).toBeFalsy();
  });

  it('should invalidate output when it is exact match', () => {
    _recordOutputsHash(['dist/app/app1'], '123', 1);
    processFileChangesInOutputs([
      { path: 'dist/app/app1', type: EventType.update },
    ]);
    expect(_outputsHashesMatch(['dist/app/app1'], '123')).toBe(false);
  });

  it('should invalidate output when it is a child', () => {
    _recordOutputsHash(['dist/app/app1'], '123', 1);
    processFileChangesInOutputs([
      { path: 'dist/app/app1/child', type: EventType.update },
    ]);
    expect(_outputsHashesMatch(['dist/app/app1'], '123')).toBe(false);
  });

  it('should invalidate output when it is a parent', () => {
    _recordOutputsHash(['dist/app/app1'], '123', 1);
    processFileChangesInOutputs([{ path: 'dist/app', type: EventType.update }]);
    expect(_outputsHashesMatch(['dist/app/app1'], '123')).toBe(false);
  });

  it('should not invalidate anything when no match', () => {
    _recordOutputsHash(['dist/app/app1'], '123', 1);
    processFileChangesInOutputs([
      { path: 'dist/app2', type: EventType.update },
    ]);
    expect(_outputsHashesMatch(['dist/app/app1'], '123')).toBe(true);
  });
});

describe('outputs tracking dates change events by mtime and ctime', () => {
  let tempDir: string;
  let output: string;
  let file: string;

  beforeEach(() => {
    tempDir = `run-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    output = `${tempDir}/app1`;
    file = `${output}/main.js`;
    mkdirSync(join(workspaceRoot, output), { recursive: true });
    writeFileSync(join(workspaceRoot, file), 'built');
  });

  afterEach(() => {
    rmSync(join(workspaceRoot, tempDir), { recursive: true, force: true });
  });

  it('should keep the hash when an event describes a write made before the hash was recorded', () => {
    setModified(file, Date.now() - 10000);
    recordAt(1000, [output], '123', 1);
    processFileChangesInOutputs([{ path: file, type: EventType.create }]);
    expect(_outputsHashesMatch([output], '123')).toBe(true);
  });

  it('should keep the hash when an event for a parent directory predates the record', () => {
    setModified(tempDir, Date.now() - 10000);
    recordAt(1000, [output], '123', 1);
    processFileChangesInOutputs([{ path: tempDir, type: EventType.update }]);
    expect(_outputsHashesMatch([output], '123')).toBe(true);
  });

  it('should invalidate the hash when the file was modified after the hash was recorded', () => {
    _recordOutputsHash([output], '123', 1);
    setModified(file, Date.now() + 5000);
    processFileChangesInOutputs([{ path: file, type: EventType.update }]);
    expect(_outputsHashesMatch([output], '123')).toBe(false);
  });

  it('should invalidate the hash when a parent directory was modified after the hash was recorded', () => {
    _recordOutputsHash([output], '123', 1);
    setModified(tempDir, Date.now() + 5000);
    processFileChangesInOutputs([{ path: tempDir, type: EventType.update }]);
    expect(_outputsHashesMatch([output], '123')).toBe(false);
  });

  it('should invalidate the hash when the file is replaced by a copy carrying an older mtime', () => {
    // A process not connected to the daemon restores another hash into the
    // same output: std::fs::copy keeps the source mtime on macOS and Windows,
    // so the new file looks older than the record. It is dated by its ctime,
    // which nothing in user space can carry over. The record is dated a
    // second back so the copy's real ctime lands after it.
    const source = join(workspaceRoot, tempDir, 'cached-main.js');
    writeFileSync(source, 'built for another hash');
    recordAt(-1000, [output], '123', 1);
    rmSync(join(workspaceRoot, file));
    copyFileSync(source, join(workspaceRoot, file));
    setModified(file, Date.now() - 10000);
    processFileChangesInOutputs([{ path: file, type: EventType.create }]);
    expect(_outputsHashesMatch([output], '123')).toBe(false);
  });

  it('should keep the hash when a delete describes a file removed before the hash was recorded', () => {
    // A restore replacing the outputs removes superseded files first; the
    // deleted path is dated by its parent, which was written before the record.
    rmSync(join(workspaceRoot, file));
    setModified(output, Date.now() - 10000);
    recordAt(1000, [output], '123', 1);
    processFileChangesInOutputs([{ path: file, type: EventType.delete }]);
    expect(_outputsHashesMatch([output], '123')).toBe(true);
  });

  it('should invalidate the hash when the file was deleted after the hash was recorded', () => {
    _recordOutputsHash([output], '123', 1);
    rmSync(join(workspaceRoot, file));
    setModified(output, Date.now() + 5000);
    processFileChangesInOutputs([{ path: file, type: EventType.delete }]);
    expect(_outputsHashesMatch([output], '123')).toBe(false);
  });
});

describe('outputs tracking after a watcher rescan', () => {
  let tempDir: string;
  let output: string;
  let file: string;

  beforeEach(() => {
    tempDir = `run-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    output = `${tempDir}/app1`;
    file = `${output}/lib/main.js`;
    mkdirSync(join(workspaceRoot, output, 'lib'), { recursive: true });
    writeFileSync(join(workspaceRoot, file), 'built');
    setModified(file, Date.now() - 10000);
    setModified(`${output}/lib`, Date.now() - 10000);
    setModified(output, Date.now() - 10000);
  });

  afterEach(() => {
    rmSync(join(workspaceRoot, tempDir), { recursive: true, force: true });
  });

  it('should keep a hash whose outputs were not written after the record', () => {
    recordBatchAt(1000, [{ outputs: [output], hash: '123' }]);
    markRecordedOutputsHashesUnverified();
    expect(
      outputsHashesMatchBatch([{ outputs: [output], hash: '123' }])
    ).toEqual([true]);
  });

  it('should drop a hash when a file under the outputs was written after the record', () => {
    recordOutputsHashBatch([{ outputs: [output], hash: '123' }]);
    setModified(file, Date.now() + 5000);
    markRecordedOutputsHashesUnverified();
    expect(
      outputsHashesMatchBatch([{ outputs: [output], hash: '123' }])
    ).toEqual([false]);
    expect(
      outputsHashesMatchBatch([{ outputs: [output], hash: '123' }])
    ).toEqual([false]);
  });

  it('should drop a hash when a file was written within the clock slack after the record', () => {
    // mtimes come from a coarse kernel clock that lags Date.now(), so a write
    // made just after the record can be dated just before it.
    const recordedAt = Date.now() + 1000;
    vi.useFakeTimers({ now: recordedAt });
    try {
      recordOutputsHashBatch([{ outputs: [output], hash: '123' }]);
    } finally {
      vi.useRealTimers();
    }
    setModified(file, recordedAt - 1);
    markRecordedOutputsHashesUnverified();
    expect(
      outputsHashesMatchBatch([{ outputs: [output], hash: '123' }])
    ).toEqual([false]);
  });

  it('should drop a hash when a directory under the outputs was written after the record', () => {
    // Enough files for the record to collapse to the directory, whose mtime
    // then stands for an entry added or removed under it unseen.
    for (const name of ['a.js', 'b.js', 'c.js', 'd.js']) {
      const path = `${output}/lib/${name}`;
      writeFileSync(join(workspaceRoot, path), 'built');
      setModified(path, Date.now() - 10000);
    }
    setModified(`${output}/lib`, Date.now() - 10000);
    recordBatchAt(1000, [{ outputs: [output], hash: '123' }]);
    markRecordedOutputsHashesUnverified();
    expect(
      outputsHashesMatchBatch([{ outputs: [output], hash: '123' }])
    ).toEqual([true]);
    setModified(`${output}/lib`, Date.now() + 5000);
    markRecordedOutputsHashesUnverified();
    expect(
      outputsHashesMatchBatch([{ outputs: [output], hash: '123' }])
    ).toEqual([false]);
  });

  it('should trust a hash recorded after the rescan', () => {
    markRecordedOutputsHashesUnverified();
    recordOutputsHashBatch([{ outputs: [output], hash: '123' }]);
    setModified(file, Date.now() + 5000);
    expect(
      outputsHashesMatchBatch([{ outputs: [output], hash: '123' }])
    ).toEqual([true]);
  });

  it('should drop a hash when the last file in a subdirectory was removed unseen', () => {
    // Enough files for the record to collapse to a directory, and one file
    // alone in a subdirectory. Removing it leaves no file to lead the walk to
    // the subdirectory and no other directory's mtime changes, so only the
    // file count can tell.
    for (const name of ['a.js', 'b.js', 'c.js', 'd.js']) {
      writeFileSync(join(workspaceRoot, `${output}/lib/${name}`), 'built');
      setModified(`${output}/lib/${name}`, Date.now() - 10000);
    }
    mkdirSync(join(workspaceRoot, `${output}/lib/sub`));
    writeFileSync(join(workspaceRoot, `${output}/lib/sub/only.js`), 'built');
    for (const path of [
      `${output}/lib/sub/only.js`,
      `${output}/lib/sub`,
      `${output}/lib`,
    ]) {
      setModified(path, Date.now() - 10000);
    }
    recordBatchAt(1000, [{ outputs: [output], hash: '123' }]);
    rmSync(join(workspaceRoot, `${output}/lib/sub/only.js`));
    setModified(`${output}/lib/sub`, Date.now() - 10000);
    markRecordedOutputsHashesUnverified();
    expect(
      outputsHashesMatchBatch([{ outputs: [output], hash: '123' }])
    ).toEqual([false]);
  });

  it('should keep the record of a hash whose outputs expand to no files', () => {
    const missing = [`${tempDir}/lib1/dist`, `dist/${tempDir}/lib1`];
    recordOutputsHashBatch([{ outputs: missing, hash: '789' }]);
    recordOutputsHashBatch([{ outputs: [output], hash: '123' }]);
    expect(
      outputsHashesMatchBatch([{ outputs: missing, hash: '789' }])
    ).toEqual([true]);
    markRecordedOutputsHashesUnverified();
    expect(
      outputsHashesMatchBatch([{ outputs: missing, hash: '789' }])
    ).toEqual([true]);
    mkdirSync(join(workspaceRoot, missing[0]), { recursive: true });
    writeFileSync(join(workspaceRoot, missing[0], 'main.js'), 'built');
    expect(
      outputsHashesMatchBatch([{ outputs: missing, hash: '789' }])
    ).toEqual([false]);
  });

  it('should verify a hash once', () => {
    recordBatchAt(1000, [{ outputs: [output], hash: '123' }]);
    markRecordedOutputsHashesUnverified();
    expect(
      outputsHashesMatchBatch([{ outputs: [output], hash: '123' }])
    ).toEqual([true]);
    setModified(file, Date.now() + 5000);
    expect(
      outputsHashesMatchBatch([{ outputs: [output], hash: '123' }])
    ).toEqual([true]);
  });
});

describe('outputs tracking forgets records nothing can match', () => {
  let tempDir: string;
  let output: string;
  let file: string;
  let oldHash: string;
  let newHash: string;

  beforeEach(() => {
    tempDir = `run-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    output = `${tempDir}/app1`;
    file = `${output}/lib/main.js`;
    oldHash = `${tempDir}-old`;
    newHash = `${tempDir}-new`;
    mkdirSync(join(workspaceRoot, output, 'lib'), { recursive: true });
    writeFileSync(join(workspaceRoot, file), 'built');
  });

  afterEach(() => {
    rmSync(join(workspaceRoot, tempDir), { recursive: true, force: true });
  });

  it('should forget the records of a hash once its outputs are recorded under another', () => {
    recordOutputsHashBatch([{ outputs: [output], hash: oldHash }]);
    markRecordedOutputsHashesUnverified();
    const recorded = _recordCounts();
    recordOutputsHashBatch([{ outputs: [output], hash: newHash }]);
    expect(_recordCounts()).toEqual(recorded);
    expect(
      outputsHashesMatchBatch([{ outputs: [output], hash: oldHash }])
    ).toEqual([false]);
    expect(
      outputsHashesMatchBatch([{ outputs: [output], hash: newHash }])
    ).toEqual([true]);
  });

  it('should forget an output the declared outputs no longer expand to', () => {
    // Three files or fewer are recorded by path, so a bundle named by its
    // content leaves its old name behind on every build.
    recordOutputsHashBatch([{ outputs: [output], hash: oldHash }]);
    const recorded = _recordCounts();
    rmSync(join(workspaceRoot, file));
    writeFileSync(join(workspaceRoot, `${output}/lib/main.abc123.js`), 'built');
    recordOutputsHashBatch([{ outputs: [output], hash: newHash }]);
    expect(_recordCounts()).toEqual(recorded);
    expect(_outputsHashesMatch([file], oldHash)).toBe(false);
  });

  it('should keep the outputs of other declared outputs', () => {
    recordOutputsHashBatch([{ outputs: [output], hash: oldHash }]);
    const recorded = _recordCounts();
    const other = `${tempDir}/app2/main.js`;
    mkdirSync(join(workspaceRoot, tempDir, 'app2'));
    writeFileSync(join(workspaceRoot, other), 'built');
    recordOutputsHashBatch([{ outputs: [`${tempDir}/app2`], hash: newHash }]);
    expect(_recordCounts()).toEqual({
      hashes: recorded.hashes + 1,
      outputs: recorded.outputs + 1,
      dirs: recorded.dirs + 2,
    });
    expect(
      outputsHashesMatchBatch([{ outputs: [output], hash: oldHash }])
    ).toEqual([true]);
  });

  it('should forget an output once a change event invalidated it', () => {
    recordOutputsHashBatch([{ outputs: [output], hash: oldHash }]);
    const recorded = _recordCounts();
    const other = `${tempDir}/app2/main.js`;
    mkdirSync(join(workspaceRoot, tempDir, 'app2'));
    writeFileSync(join(workspaceRoot, other), 'built');
    recordOutputsHashBatch([{ outputs: [`${tempDir}/app2`], hash: newHash }]);
    expect(_recordCounts()).not.toEqual(recorded);
    setModified(other, Date.now() + 5000);
    processFileChangesInOutputs([{ path: other, type: EventType.update }]);
    _forgetUnreferencedHashes();
    expect(_recordCounts()).toEqual(recorded);
  });
});
