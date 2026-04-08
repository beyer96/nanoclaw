#!/usr/bin/env node
/**
 * Claude Task Runner
 *
 * Watches tasks/pending/ for JSON task files written by Andy.
 * Runs the local claude CLI (Pro subscription) in the target project,
 * handles rate-limit waits, and writes results back for Andy to pick up.
 */

import fs from 'fs';
import path from 'path';
import { execSync, spawn } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NANOCLAW_DIR = path.resolve(__dirname, '..');
const TASKS_DIR = path.join(NANOCLAW_DIR, 'store', 'tasks');
const PENDING_DIR = path.join(TASKS_DIR, 'pending');
const ACTIVE_DIR = path.join(TASKS_DIR, 'active');
const DONE_DIR = path.join(TASKS_DIR, 'done');
const STATUS_DIR = path.join(TASKS_DIR, 'status');
const LOG_DIR = path.join(NANOCLAW_DIR, 'logs');
const CLAUDE_BIN = '/home/lukas/.local/bin/claude';
const POLL_INTERVAL_MS = 15_000; // 15 seconds
const RATE_LIMIT_DEFAULT_WAIT_MS = 5 * 60 * 60 * 1000; // 5 hours
const RATE_LIMIT_BUFFER_MS = 2 * 60 * 1000; // 2 min buffer after reset
const DEADLINE_HOUR = 6; // 6 AM — write status update if still running

for (const dir of [PENDING_DIR, ACTIVE_DIR, DONE_DIR, STATUS_DIR, LOG_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

let currentTask = null;

function log(msg, extra) {
  const line = `[${new Date().toISOString()}] ${msg}${extra ? ' ' + JSON.stringify(extra) : ''}`;
  console.log(line);
}

function expandHome(p) {
  return p.startsWith('~') ? path.join(process.env.HOME, p.slice(1)) : p;
}

function isAfterDeadline() {
  return new Date().getHours() >= DEADLINE_HOUR;
}

function isRateLimitOutput(output) {
  return /usage limit|rate limit|limit reached|too many requests|claude ai usage|hit your limit|you've hit/i.test(output);
}

/**
 * Parse the reset wait time from Claude's rate-limit message.
 * Handles formats like "resets 1am", "resets at 1:30 AM", "resets 1:00am".
 * Falls back to RATE_LIMIT_DEFAULT_WAIT_MS if not parseable.
 */
function parseWaitMs(output) {
  // Match "resets 1am", "resets at 1:30 AM", "resets 1:00am", etc.
  const match = output.match(/resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*([AP]M|am|pm)/i);
  if (match) {
    let h = parseInt(match[1], 10);
    const m = match[2] ? parseInt(match[2], 10) : 0;
    const isPm = /pm/i.test(match[3]);
    if (isPm && h !== 12) h += 12;
    if (!isPm && h === 12) h = 0;
    const now = new Date();
    const reset = new Date(now);
    reset.setHours(h, m, 0, 0);
    if (reset <= now) reset.setDate(reset.getDate() + 1);
    return reset.getTime() - now.getTime();
  }
  return RATE_LIMIT_DEFAULT_WAIT_MS;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run the claude CLI non-interactively in projectDir.
 * Returns { code, output }.
 */
function runClaude(projectDir, prompt, isResume) {
  return new Promise((resolve) => {
    const args = ['--dangerously-skip-permissions'];
    if (isResume) args.push('--continue');
    args.push('-p', prompt);

    log(`Spawning claude (${isResume ? 'resume' : 'fresh'}) in ${projectDir}`);

    const proc = spawn(CLAUDE_BIN, args, {
      cwd: projectDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, HOME: process.env.HOME },
    });

    let output = '';
    const handler = (data) => {
      const chunk = data.toString();
      output += chunk;
      process.stdout.write(chunk);
    };
    proc.stdout.on('data', handler);
    proc.stderr.on('data', handler);

    proc.on('close', (code) => resolve({ code: code ?? 1, output }));
  });
}

function writeResult(task, success, summary) {
  const result = {
    taskId: task.id,
    success,
    branch: task.branch,
    project: task.project,
    summary,
    completedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(DONE_DIR, `${task.id}.json`), JSON.stringify(result, null, 2));
  const activePath = path.join(ACTIVE_DIR, `${task.id}.json`);
  if (fs.existsSync(activePath)) fs.unlinkSync(activePath);
  log(`Task ${task.id} result written (success=${success})`);
}

function writeStatusUpdate(task, message) {
  const status = {
    taskId: task.id,
    branch: task.branch,
    project: task.project,
    message,
    type: 'deadline_check',
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(STATUS_DIR, `${task.id}.json`), JSON.stringify(status, null, 2));
  log(`Status update written for task ${task.id}`);
}

async function runTask(task) {
  const { id, project, branch, goals } = task;
  const projectDir = expandHome(project);

  if (!fs.existsSync(projectDir)) {
    writeResult(task, false, `Project directory not found: ${projectDir}`);
    return;
  }

  // Create or checkout git branch
  try {
    execSync(`git checkout -b "${branch}"`, { cwd: projectDir, stdio: 'pipe' });
    log(`Created branch ${branch}`);
  } catch {
    try {
      execSync(`git checkout "${branch}"`, { cwd: projectDir, stdio: 'pipe' });
      log(`Checked out existing branch ${branch}`);
    } catch (err) {
      writeResult(task, false, `Failed to create/checkout branch "${branch}": ${err.message}`);
      return;
    }
  }

  // Ensure PROGRESS.md is gitignored
  const gitignorePath = path.join(projectDir, '.gitignore');
  try {
    const existing = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, 'utf-8') : '';
    if (!existing.includes('PROGRESS.md')) {
      fs.appendFileSync(gitignorePath, '\nPROGRESS.md\n');
    }
  } catch { /* non-fatal */ }

  const initialPrompt =
`You are implementing features in a software project. Work autonomously and thoroughly.

PROJECT DIRECTORY: ${projectDir}
BRANCH: ${branch}
GOALS:
${goals}

INSTRUCTIONS:
1. You are already on branch "${branch}"
2. Implement all goals thoroughly; commit progress frequently with clear commit messages
3. Maintain a PROGRESS.md file in the project root tracking: what is done, what is remaining
   (PROGRESS.md is gitignored — it is for your own tracking only)
4. When fully complete, create SUMMARY.md with:
   - What was implemented
   - Files added or changed
   - What the user should test and review
5. Commit SUMMARY.md as the final commit on the branch
6. Work autonomously — make reasonable decisions without asking for confirmation

Begin implementation now.`;

  const resumePrompt =
`You were rate-limited and are now resuming work. Continue from where you left off.
Check git log and PROGRESS.md for current status, then complete all remaining goals.
When fully done, create SUMMARY.md and commit it as the final commit.`;

  let attempt = 0;

  while (true) {
    const { code, output } = await runClaude(projectDir, attempt === 0 ? initialPrompt : resumePrompt, attempt > 0);

    if (isRateLimitOutput(output)) {
      const waitMs = parseWaitMs(output);
      const waitMin = Math.round(waitMs / 60_000);
      log(`Rate limited on attempt ${attempt + 1}. Waiting ${waitMin}m.`);
      writeStatusUpdate(task, `Rate limited after attempt ${attempt + 1}. Resuming in ~${waitMin} minutes. Branch: ${branch}`);
      await sleep(waitMs + RATE_LIMIT_BUFFER_MS);
      attempt++;

      // 6AM deadline check before resuming
      if (isAfterDeadline()) {
        log('Past 6AM after rate-limit wait, stopping for deadline.');
        writeStatusUpdate(task, `Work paused at 6AM deadline after rate limit. Branch: ${branch}. Check git log for progress.`);
        return;
      }
      continue;
    }

    if (code === 0) {
      let summary = `Work complete on branch \`${branch}\`.`;
      try {
        summary = fs.readFileSync(path.join(projectDir, 'SUMMARY.md'), 'utf-8');
      } catch {
        // Fall back to last portion of output
        summary += '\n\n' + output.slice(-2000);
      }
      writeResult(task, true, summary);
      return;
    }

    // Non-zero, non-rate-limit exit
    log(`Claude exited with code ${code} on attempt ${attempt + 1}`);
    writeResult(task, false, `Claude exited with code ${code}.\n\nLast output:\n${output.slice(-2000)}`);
    return;
  }
}

async function poll() {
  if (currentTask) {
    setTimeout(poll, POLL_INTERVAL_MS);
    return;
  }

  let files;
  try {
    files = fs.readdirSync(PENDING_DIR).filter((f) => f.endsWith('.json')).sort();
  } catch (err) {
    log('Error reading pending dir', err.message);
    setTimeout(poll, POLL_INTERVAL_MS);
    return;
  }

  if (files.length === 0) {
    setTimeout(poll, POLL_INTERVAL_MS);
    return;
  }

  const file = files[0];
  const pendingPath = path.join(PENDING_DIR, file);
  const activePath = path.join(ACTIVE_DIR, file);

  let task;
  try {
    task = JSON.parse(fs.readFileSync(pendingPath, 'utf-8'));
  } catch (err) {
    log(`Skipping unreadable task file ${file}`, err.message);
    fs.unlinkSync(pendingPath);
    setTimeout(poll, POLL_INTERVAL_MS);
    return;
  }

  fs.renameSync(pendingPath, activePath);
  currentTask = task;

  try {
    await runTask(task);
  } catch (err) {
    log(`Unexpected error in task ${task.id}`, err.message);
    writeResult(task, false, `Unexpected runner error: ${err.message}`);
  } finally {
    currentTask = null;
  }

  setTimeout(poll, POLL_INTERVAL_MS);
}

process.on('SIGTERM', () => {
  log('SIGTERM received — shutting down');
  if (currentTask) {
    writeStatusUpdate(currentTask, `Runner stopped (SIGTERM). Work may be incomplete. Branch: ${currentTask.branch}`);
  }
  process.exit(0);
});

log('Claude task runner started');
log(`Watching: ${PENDING_DIR}`);
poll();
