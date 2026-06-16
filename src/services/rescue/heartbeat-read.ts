import { queryAllDoctorData } from 'services/buffer/doctor-queries.ts';

export interface HeartbeatTimestamps {
  captureLastCycleAt: string | null;
  drainLastCycleAt: string | null;
}

export function readHeartbeat(bufferDbPath: string): HeartbeatTimestamps {
  try {
    const data = queryAllDoctorData(bufferDbPath);
    return {
      captureLastCycleAt: data.daemonState.captureLastCycleAt,
      drainLastCycleAt: data.daemonState.drainLastCycleAt,
    };
  } catch {
    return {
      captureLastCycleAt: null,
      drainLastCycleAt: null,
    };
  }
}
