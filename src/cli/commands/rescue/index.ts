import { join } from 'node:path';
import { decideRescue, RESUME_GAP_THRESHOLD_MS } from 'services/rescue/rescue-decision.ts';
import { readHeartbeat } from 'services/rescue/heartbeat-read.ts';
import {
  readRescueLedger,
  writeRescueLedger,
  recordRescueAttempt,
  markRescueFailed,
  markDaemonHealthy,
} from 'services/rescue/rescue-ledger.ts';
import { isCurrentSessionStopped } from 'services/polling/session-stopped-sentinel.ts';
import { readBootId } from 'core/system/boot-id.ts';
import { buildProfileContext, profileRootDir } from 'core/io/fs/profile.ts';
import { getServiceManager } from 'cli/service-manager/index.ts';
import { createLogger } from 'core/log/logger.ts';
import { runCommand, defaultSpawn } from 'cli/service-manager/run-command.ts';
import { profileLaunchdLabel, profileSystemdUnitName } from 'cli/service-unit/dev-labels.ts';
import { defaultLaunchdPlistPath } from 'cli/service-unit/launchd-plist.ts';
import { defaultSystemdUnitPath } from 'cli/service-unit/systemd-unit.ts';
import { defaultScheduledTaskXmlPath } from 'cli/service-unit/scheduled-task-xml.ts';
import type { ProfileName } from 'core/io/fs/profile.types.ts';
import type { CommandResult } from 'cli/cli.types.ts';
import type { SpawnFn } from 'cli/service-manager/types.ts';
import { EXIT_CODE } from 'cli/cli.constants.ts';

export interface RescueCommandInput {
  profileName: ProfileName;
  programPath: string;
  platform?: NodeJS.Platform;
  spawn?: SpawnFn;
  skipExit?: boolean;
}

export async function runRescue(input: RescueCommandInput): Promise<CommandResult> {
  const platform = input.platform ?? process.platform;
  const spawn = input.spawn ?? defaultSpawn();
  const profileName = input.profileName;
  const profileCtx = buildProfileContext(profileName);

  try {
    const configExists = await Bun.file(profileCtx.configFilePath).exists();
    const serviceManager = getServiceManager({
      platform,
      unitPath:
        platform === 'darwin'
          ? defaultLaunchdPlistPath(profileLaunchdLabel(profileName))
          : platform === 'linux'
            ? defaultSystemdUnitPath(profileSystemdUnitName(profileName))
            : defaultScheduledTaskXmlPath(profileCtx.configDir),
      spawn,
      profile: profileName,
    });

    const isRegistered = await serviceManager.isRegistered();
    const isRunning = await serviceManager.isRunning();

    const hb = readHeartbeat(profileCtx.bufferDbPath);

    const authFailedPresent = await Bun.file(profileCtx.sentinels.authFailed).exists();
    const bufferFullPresent = await Bun.file(profileCtx.sentinels.bufferFull).exists();

    const bootId = await readBootId();
    const sessionStoppedThisBoot = await isCurrentSessionStopped(
      profileCtx.sentinels.sessionStopped,
      bootId,
    );

    const lockExists = await Bun.file(join(profileRootDir(), '.upgrade.lock')).exists();
    const restoreStateExists = await Bun.file(
      join(profileRootDir(), '.upgrade-restore-state'),
    ).exists();
    const upgradeInProgress = lockExists || restoreStateExists;

    const ledger = await readRescueLedger(profileCtx.sentinels.rescueLedger, bootId);

    const now = new Date();
    let likelyResumed = false;
    if (ledger !== null && ledger.lastWatchdogRunAt !== null) {
      const lastRunMs = Date.parse(ledger.lastWatchdogRunAt);
      if (Number.isFinite(lastRunMs)) {
        const gapMs = now.getTime() - lastRunMs;
        if (gapMs > RESUME_GAP_THRESHOLD_MS) {
          likelyResumed = true;
        }
      }
    }

    const decision = decideRescue({
      configExists,
      serviceUnitRegistered: isRegistered,
      isRunning,
      captureLastCycleAt: hb.captureLastCycleAt,
      drainLastCycleAt: hb.drainLastCycleAt,
      authFailedPresent,
      bufferFullPresent,
      sessionStoppedThisBoot,
      upgradeInProgress,
      ledger,
      now,
      likelyResumed,
    });

    let activeLedger = ledger;
    if (activeLedger === null) {
      activeLedger = {
        bootId,
        lastRescueAt: null,
        consecutiveFailures: 0,
        attempts: [],
        lastObservedCaptureAt: null,
        lastObservedDrainAt: null,
        lastWatchdogRunAt: null,
      };
    }

    if (decision.kind === 'start') {
      if (platform === 'linux') {
        const unitName = profileSystemdUnitName(profileName);
        await runCommand(spawn, ['systemctl', '--user', 'reset-failed', unitName]);
      }
      if (activeLedger.lastRescueAt !== null) {
        markRescueFailed(activeLedger);
      }
      recordRescueAttempt(activeLedger, new Date().toISOString(), 'start');
      await serviceManager.start();
    } else if (decision.kind === 'restart') {
      if (platform === 'linux') {
        const unitName = profileSystemdUnitName(profileName);
        await runCommand(spawn, ['systemctl', '--user', 'reset-failed', unitName]);
      }
      if (activeLedger.lastRescueAt !== null) {
        markRescueFailed(activeLedger);
      }
      recordRescueAttempt(activeLedger, new Date().toISOString(), 'restart');
      await serviceManager.restart();
    } else if (decision.kind === 'none' && decision.reason === 'healthy') {
      markDaemonHealthy(activeLedger);
    }

    activeLedger.lastWatchdogRunAt = now.toISOString();
    activeLedger.lastObservedCaptureAt = hb.captureLastCycleAt;
    activeLedger.lastObservedDrainAt = hb.drainLastCycleAt;
    await writeRescueLedger(profileCtx.sentinels.rescueLedger, activeLedger);
  } catch (err: unknown) {
    try {
      const logger = await createLogger({ logDir: profileCtx.logDir });
      logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        'rescue command execution failed',
      );
    } catch {}
  }

  if (input.skipExit !== true) {
    process.exit(0);
  }
  return { exitCode: EXIT_CODE.ok };
}
