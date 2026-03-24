const MODULE_ID = 'pf2e-combat-chronicle';

export class HealthTracker {
  /** @type {Map<string, {hp: number, temp_hp: number}>} */
  #previousHP = new Map();

  /** @type {Array} */
  #pendingChanges = [];

  /**
   * Take a snapshot of an actor's current HP.
   * @param {Actor} actor
   * @returns {{hp: number, hp_max: number, temp_hp: number}}
   */
  snapshotHP(actor) {
    const hpData = actor?.system?.attributes?.hp;
    if (!hpData) return { hp: 0, hp_max: 0, temp_hp: 0 };
    return {
      hp: hpData.value ?? 0,
      hp_max: hpData.max ?? 0,
      temp_hp: hpData.temp ?? 0,
    };
  }

  /**
   * Store the actor's current HP as the baseline for delta tracking.
   * Called at turn start so subsequent updateActor events can compute deltas.
   * @param {Actor} actor
   */
  initBaseline(actor) {
    if (!actor) return;
    const snap = this.snapshotHP(actor);
    this.#previousHP.set(actor.id, { hp: snap.hp, temp_hp: snap.temp_hp });
  }

  /**
   * Handle an HP change from the updateActor hook.
   * Computes delta and stores the change event.
   * @param {Actor} actor — actor after update (already has new HP values)
   * @param {object} changes — the diff object from Foundry
   */
  onHPChange(actor, changes) {
    const actorId = actor.id;
    const prev = this.#previousHP.get(actorId);
    if (!prev) {
      // No baseline — actor wasn't in combat when turn started; set baseline now
      const snap = this.snapshotHP(actor);
      this.#previousHP.set(actorId, { hp: snap.hp, temp_hp: snap.temp_hp });
      return;
    }

    const current = this.snapshotHP(actor);
    const hpBefore = prev.hp;
    const hpAfter = current.hp;
    const tempBefore = prev.temp_hp;
    const tempAfter = current.temp_hp;

    // Only record if something actually changed
    if (hpBefore === hpAfter && tempBefore === tempAfter) return;

    const delta = hpAfter - hpBefore;

    const change = {
      actor_name: actor.name,
      actor_id: actorId,
      timestamp: new Date().toISOString(),
      hp_before: hpBefore,
      hp_after: hpAfter,
      hp_max: current.hp_max,
      temp_hp_before: tempBefore,
      temp_hp_after: tempAfter,
      delta,
      source: null,
      damage_type: null,
    };

    this.#pendingChanges.push(change);

    // Update baseline to current values for next delta
    this.#previousHP.set(actorId, { hp: hpAfter, temp_hp: tempAfter });

    console.log(`${MODULE_ID} | HP change: ${actor.name} ${hpBefore}→${hpAfter} (${delta >= 0 ? '+' : ''}${delta})`);
  }

  /**
   * Drain and return all accumulated HP change events since last call.
   * @returns {Array}
   */
  drainChanges() {
    const changes = this.#pendingChanges;
    this.#pendingChanges = [];
    return changes;
  }

  /**
   * Clear all tracked state (call when combat ends).
   */
  reset() {
    this.#previousHP.clear();
    this.#pendingChanges = [];
  }
}
