import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_ARTIFACT_PATH = 'artifacts/sonar/phase15-legacy-debt-review.json';
const DEFAULT_STATE_PATH = 'artifacts/sonar/phase16-progress.json';
const DEFAULT_OUTPUT_PATH = 'artifacts/sonar/phase16-next-batch.json';
const DEFAULT_BATCH_SIZE = 10;
const ALLOWED_LANES = new Set(['A', 'B', 'C']);

function parseArgs(argv) {
  const args = {
    lane: 'A',
    size: DEFAULT_BATCH_SIZE,
    artifact: DEFAULT_ARTIFACT_PATH,
    state: DEFAULT_STATE_PATH,
    out: DEFAULT_OUTPUT_PATH,
    peek: false,
    reset: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') {
      continue;
    } else if (arg === '--lane') {
      args.lane = String(argv[++i] ?? '').toUpperCase();
    } else if (arg === '--size') {
      args.size = Number(argv[++i]);
    } else if (arg === '--artifact') {
      args.artifact = String(argv[++i] ?? DEFAULT_ARTIFACT_PATH);
    } else if (arg === '--state') {
      args.state = String(argv[++i] ?? DEFAULT_STATE_PATH);
    } else if (arg === '--out') {
      args.out = String(argv[++i] ?? DEFAULT_OUTPUT_PATH);
    } else if (arg === '--peek') {
      args.peek = true;
    } else if (arg === '--reset') {
      args.reset = true;
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!ALLOWED_LANES.has(args.lane)) {
    throw new Error(`Invalid --lane value "${args.lane}". Expected one of: A, B, C.`);
  }
  if (!Number.isFinite(args.size) || args.size <= 0) {
    throw new Error(`Invalid --size value "${args.size}". Expected a positive number.`);
  }

  return args;
}

function printHelp() {
  console.log(`Usage:
  node scripts/sonar/phase16-next-batch.mjs [options]

Options:
  --lane <A|B|C>     Lane to process (default: A)
  --size <number>    Number of files in batch (default: 10)
  --artifact <path>  Legacy debt artifact path (default: ${DEFAULT_ARTIFACT_PATH})
  --state <path>     Progress state path (default: ${DEFAULT_STATE_PATH})
  --out <path>       Output batch path (default: ${DEFAULT_OUTPUT_PATH})
  --peek             Preview next batch without advancing cursor
  --reset            Reset cursor for selected lane to 0 before selecting
  --help             Show this message
`);
}

function readJson(filePath, fallbackValue) {
  if (!fs.existsSync(filePath)) return fallbackValue;
  const raw = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
  return JSON.parse(raw);
}

function ensureDirForFile(filePath) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
}

function writeJson(filePath, value) {
  ensureDirForFile(filePath);
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function normalizeEntry(entry, lane) {
  if (lane === 'C') {
    return {
      path: entry.path,
      score: Number(entry.duplicated_lines_density ?? 0),
      metric: 'duplicated_lines_density',
    };
  }

  return {
    path: entry.path,
    score: Number(entry.count ?? 0),
    metric: 'count',
  };
}

function getLaneEntries(artifact, lane) {
  if (lane === 'A') {
    return (artifact?.laneA?.topFiles ?? []).map((entry) => normalizeEntry(entry, lane));
  }
  if (lane === 'B') {
    return (artifact?.laneB?.topFiles ?? []).map((entry) => normalizeEntry(entry, lane));
  }
  return (artifact?.laneC?.topLegacyDuplicationFiles ?? []).map((entry) => normalizeEntry(entry, lane));
}

function createInitialState() {
  return {
    version: 1,
    updatedAt: null,
    cursors: {
      A: 0,
      B: 0,
      C: 0,
    },
    history: [],
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const artifact = readJson(args.artifact, null);
  if (!artifact) {
    throw new Error(`Legacy debt artifact not found: ${args.artifact}`);
  }

  const entries = getLaneEntries(artifact, args.lane);
  if (!entries.length) {
    throw new Error(`No entries found for lane ${args.lane} in artifact ${args.artifact}`);
  }

  const state = readJson(args.state, createInitialState());
  if (!state.cursors) {
    state.cursors = { A: 0, B: 0, C: 0 };
  }
  if (!Array.isArray(state.history)) {
    state.history = [];
  }

  if (args.reset) {
    state.cursors[args.lane] = 0;
  }

  const startIndex = Number(state.cursors[args.lane] ?? 0);
  const batch = entries.slice(startIndex, startIndex + args.size);
  const endIndex = startIndex + batch.length;
  const remaining = Math.max(entries.length - endIndex, 0);
  const now = new Date().toISOString();

  const output = {
    generatedAt: now,
    lane: args.lane,
    sourceArtifact: args.artifact,
    stateFile: args.state,
    cursorStart: startIndex,
    cursorEndExclusive: endIndex,
    totalCandidates: entries.length,
    batchSizeRequested: args.size,
    batchSizeActual: batch.length,
    remainingAfterBatch: remaining,
    files: batch,
  };

  writeJson(args.out, output);

  if (!args.peek) {
    state.cursors[args.lane] = endIndex;
    state.updatedAt = now;
    state.history.push({
      generatedAt: now,
      lane: args.lane,
      cursorStart: startIndex,
      cursorEndExclusive: endIndex,
      batchSize: batch.length,
      outputFile: args.out,
      files: batch.map((item) => item.path),
    });
    writeJson(args.state, state);
  }

  console.log(`Lane ${args.lane} batch generated (${batch.length}/${args.size})`);
  console.log(`Cursor: ${startIndex} -> ${endIndex} of ${entries.length}${args.peek ? ' (peek mode, not advanced)' : ''}`);
  console.log(`Remaining after batch: ${remaining}`);
  console.log(`Output: ${args.out}`);
  console.log('');
  if (batch.length === 0) {
    console.log('No files left in this lane.');
  } else {
    console.log('Files:');
    for (const item of batch) {
      console.log(`- ${item.path} (${item.metric}: ${item.score})`);
    }
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
