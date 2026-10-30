/**
 * SchedulerEngine: Local persistent timer and routine evaluation engine.
 * Periodically checks for due timers and routines, executes them safely without concurrency overlap,
 * records routine run logs, and cleans up orphaned runs on restart.
 */
class SchedulerEngine {
  /**
   * @param {Object} options
   * @param {import('./storage').Storage} options.storage
   * @param {Object} options.agentRunner
   * @param {Object} [options.broadcaster]
   * @param {number} [options.pollIntervalMs]
   */
  constructor({ storage, agentRunner, broadcaster = null, pollIntervalMs = 1000 }) {
    this.storage = storage;
    this.agentRunner = agentRunner;
    this.broadcaster = broadcaster;
    this.pollIntervalMs = pollIntervalMs;
    this.timer = null;
    this.running = false;
    this.activeRoutines = new Set();
    if (this.storage?.routines) {
      this.storage.routines.onRunCompleted = (routineId) => {
        this.activeRoutines.delete(routineId);
      };
    }
  }

  /**
   * Start the scheduler evaluation loop.
   */
  start() {
    if (this.running) return;
    this.running = true;

    // Crash recovery for orphaned runs on startup
    if (this.storage?.routines?.recoverOrphanedRuns) {
      try {
        const recoveredCount = this.storage.routines.recoverOrphanedRuns();
        if (recoveredCount > 0) {
          console.log(`[SchedulerEngine] Recovered ${recoveredCount} orphaned routine run(s).`);
        }
      } catch (err) {
        console.error('[SchedulerEngine] Error recovering orphaned runs:', err);
      }
    }

    this.timer = setInterval(() => {
      this.tick().catch((err) => {
        console.error('[SchedulerEngine Tick Error]', err);
      });
    }, this.pollIntervalMs);
    this.timer.unref?.();
  }

  /**
   * Stop the scheduler evaluation loop.
   */
  stop() {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Evaluate timers and scheduled routines.
   * @param {Date} [now]
   */
  async tick(now = new Date()) {
    if (!this.running || this.storage?.manager?.isClosed) return;
    await this.processTimers(now);
    await this.processRoutines(now);
  }

  /**
   * Check and fire due timers.
   * @param {Date} now
   */
  async processTimers(now = new Date()) {
    if (!this.running || !this.storage?.timers || this.storage?.manager?.isClosed) return;
    try {
      const dueTimers = this.storage.timers.getDueTimers(now);
      for (const timer of dueTimers) {
        this.storage.timers.markFired(timer.id);

        const event = {
          type: 'workspace.message.posted',
          source: 'scheduler:timer',
          target: `channel/${timer.channel_name}`,
          payload: {
            content: timer.message,
            sender_name: 'Timer',
            sender_type: 'scheduler',
          },
          metadata: {
            timer_id: timer.id,
            delay_seconds: timer.delay_seconds,
          },
        };

        const store = this.agentRunner?.store;
        if (store) {
          const saved = store.addEvent(event);
          if (this.broadcaster) {
            this.broadcaster.broadcast(saved);
          }
          if (this.agentRunner?.handleUserMessage) {
            this.agentRunner.handleUserMessage(saved).catch((err) => {
              console.error(`[SchedulerEngine] Error processing timer message ${timer.id}:`, err);
            });
          }
        }
      }
    } catch (err) {
      if (!this.running || this.storage?.manager?.isClosed) return;
      console.error('[SchedulerEngine] Error in processTimers:', err);
    }
  }

  /**
   * Check and fire due scheduled routines.
   * @param {Date} now
   */
  async processRoutines(now = new Date()) {
    if (!this.running || !this.storage?.routines || this.storage?.manager?.isClosed) return;
    try {
      const dueRoutines = this.storage.routines.getDueRoutines(now);
      for (const routine of dueRoutines) {
        if (this.activeRoutines.has(routine.id)) {
          // Prevent overlapping executions for the same routine
          continue;
        }
        await this.executeRoutine(routine);
      }
    } catch (err) {
      if (!this.running || this.storage?.manager?.isClosed) return;
      console.error('[SchedulerEngine] Error in processRoutines:', err);
    }
  }

  /**
   * Execute a routine.
   * @param {Object} routine
   */
  async executeRoutine(routine) {
    this.activeRoutines.add(routine.id);
    let runRecord = null;

    try {
      runRecord = this.storage.routines.recordRun(routine.id, {
        channel_name: routine.channel_name,
        trigger_message: routine.message,
      });

      const event = {
        type: 'workspace.message.posted',
        source: 'scheduler:routine',
        target: `channel/${routine.channel_name}`,
        payload: {
          content: routine.message,
          sender_name: routine.name || 'Routine',
          sender_type: 'scheduler',
        },
        metadata: {
          routine_id: routine.id,
          routine_run_id: runRecord.id,
          context: routine.context || null,
        },
      };

      const store = this.agentRunner?.store;
      if (store) {
        const saved = store.addEvent(event);
        if (this.broadcaster) {
          this.broadcaster.broadcast(saved);
        }

        if (this.agentRunner?.handleUserMessage) {
          const promise = this.agentRunner.handleUserMessage(saved);
          if (promise && typeof promise.then === 'function') {
            promise.catch((err) => {
              try {
                this.storage.routines.completeRun(runRecord.id, { status: 'failed', error: err.message });
              } catch (_) {}
            });
            return;
          }
        }
      }

      this.storage.routines.completeRun(runRecord.id, { status: 'completed' });
      this.activeRoutines.delete(routine.id);
    } catch (err) {
      if (runRecord) {
        try {
          this.storage.routines.completeRun(runRecord.id, { status: 'failed', error: err.message });
        } catch (_) {}
      }
      this.activeRoutines.delete(routine.id);
      console.error(`[SchedulerEngine] Error executing routine ${routine.id}:`, err);
    }
  }

  /**
   * Manually trigger a routine to run immediately.
   * @param {string} routineId
   */
  async triggerRoutineNow(routineId) {
    const routine = this.storage?.routines?.get(routineId);
    if (!routine) {
      const err = new Error(`Routine not found: ${routineId}`);
      err.status = 404;
      throw err;
    }
    return this.executeRoutine(routine);
  }
}

module.exports = { SchedulerEngine };
