import { HealthTracker } from './health-tracker.js';

const MODULE_ID = 'pf2e-combat-chronicle';

export class CombatTracker {
  #encounter = null;
  #combatId = null;
  #healthTracker = new HealthTracker();

  get currentEncounter() {
    return this.#encounter;
  }

  startCombat(combat, updateData) {
    if (this.#encounter) {
      console.warn(`${MODULE_ID} | Combat already tracked, ignoring combatStart`);
      return;
    }

    this.#combatId = combat.id;

    const initiativeOrder = combat.turns.map(c => ({
      name: c.name,
      actor_id: c.actor?.id ?? null,
      initiative_total: c.initiative,
    }));

    this.#encounter = {
      encounter_id: foundry.utils.randomID(),
      scene_name: combat.scene?.name ?? 'Unknown Scene',
      started_at: new Date().toISOString(),
      ended_at: null,
      initiative_order: initiativeOrder,
      rounds: [],
      summary: {},
    };

    // Initialize HP baselines for all combatants
    for (const c of combat.turns) {
      if (c.actor) this.#healthTracker.initBaseline(c.actor);
    }

    this.#ensureRound(combat);
    this.#ensureTurn(combat);

    console.log(`${MODULE_ID} | Combat started: ${this.#encounter.encounter_id}`);
  }

  onTurnChange(combat, prior, current) {
    if (!this.#encounter || combat.id !== this.#combatId) return;

    const isRewind =
      current.round < prior.round ||
      (current.round === prior.round && current.turn < prior.turn);

    if (isRewind) {
      console.warn(`${MODULE_ID} | Rewind detected: R${prior.round}T${prior.turn} → R${current.round}T${current.turn}`);
      this.#trimForwardData(current.round, current.turn);
    }

    // Finalize HP for the previous turn
    this.#finalizeCurrentTurnHP(combat, prior.round);

    this.#ensureRound(combat);
    this.#ensureTurn(combat);
  }

  onRoundChange(combat, updateData, updateOptions) {
    if (!this.#encounter || combat.id !== this.#combatId) return;
    this.#ensureRound(combat);
  }

  /**
   * Called from the updateActor hook when HP changes during combat.
   * @param {Actor} actor
   * @param {object} changes
   */
  onActorHPUpdate(actor, changes) {
    if (!this.#encounter) return;
    this.#healthTracker.onHPChange(actor, changes);
  }

  endCombat(combat, options, userId) {
    if (!this.#encounter || combat.id !== this.#combatId) return;

    // Finalize HP for the last active turn
    this.#finalizeCurrentTurnHP(combat, combat.round);

    this.#encounter.ended_at = new Date().toISOString();

    const totalRounds = this.#encounter.rounds.length;
    const totalTurns = this.#encounter.rounds.reduce((sum, r) => sum + r.turns.length, 0);
    console.log(`${MODULE_ID} | Combat ended: ${this.#encounter.encounter_id} (${totalRounds} rounds, ${totalTurns} turns)`);

    game.combatChronicle.lastEncounter = structuredClone(this.#encounter);

    this.#healthTracker.reset();
    this.#encounter = null;
    this.#combatId = null;
  }

  #ensureRound(combat) {
    const roundNum = combat.round;
    const existing = this.#encounter.rounds.find(r => r.round_number === roundNum);
    if (existing) return existing;

    const round = {
      round_number: roundNum,
      turns: [],
    };
    this.#encounter.rounds.push(round);
    return round;
  }

  #ensureTurn(combat) {
    const combatant = combat.combatant;
    if (!combatant) return;

    const round = this.#encounter.rounds.find(r => r.round_number === combat.round);
    if (!round) return;

    const actor = combatant.actor;
    const hpSnap = actor ? this.#healthTracker.snapshotHP(actor) : null;

    // Initialize HP baseline for this actor's turn
    if (actor) this.#healthTracker.initBaseline(actor);

    const turn = {
      combatant_name: combatant.name,
      actor_id: actor?.id ?? null,
      turn_number: round.turns.length + 1,
      hp_start: hpSnap?.hp ?? null,
      hp_max: hpSnap?.hp_max ?? null,
      temp_hp_start: hpSnap?.temp_hp ?? null,
      hp_end: null,
      temp_hp_end: null,
      hp_changes: [],
      actions: [],
      chat_messages: [],
    };
    round.turns.push(turn);
  }

  /**
   * Finalize HP end values and attach accumulated HP changes to the current turn.
   * @param {Combat} combat
   * @param {number} roundNum — the round of the turn being finalized
   */
  #finalizeCurrentTurnHP(combat, roundNum) {
    const round = this.#encounter.rounds.find(r => r.round_number === roundNum);
    if (!round || round.turns.length === 0) return;

    const turn = round.turns[round.turns.length - 1];
    if (turn.hp_end !== null) return; // already finalized

    // Look up the actor to snapshot current HP
    const actor = game.actors?.get(turn.actor_id);
    if (actor) {
      const snap = this.#healthTracker.snapshotHP(actor);
      turn.hp_end = snap.hp;
      turn.temp_hp_end = snap.temp_hp;
    }

    // Attach accumulated HP change events to this turn
    turn.hp_changes = this.#healthTracker.drainChanges();
  }

  #trimForwardData(targetRound, targetTurnIndex) {
    // Remove rounds beyond target
    this.#encounter.rounds = this.#encounter.rounds.filter(r => r.round_number <= targetRound);

    // In the target round, trim trailing empty turns
    const round = this.#encounter.rounds.find(r => r.round_number === targetRound);
    if (!round) return;

    while (round.turns.length > 0) {
      const last = round.turns[round.turns.length - 1];
      const isEmpty = last.actions.length === 0 && last.chat_messages.length === 0;
      if (isEmpty) {
        round.turns.pop();
      } else {
        break;
      }
    }
  }
}
