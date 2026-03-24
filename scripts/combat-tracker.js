import { HealthTracker } from './health-tracker.js';
import { EffectTracker } from './effect-tracker.js';
import { MovementTracker } from './movement-tracker.js';

const MODULE_ID = 'pf2e-combat-chronicle';

export class CombatTracker {
  #encounter = null;
  #combatId = null;
  #healthTracker = new HealthTracker();
  #effectTracker = new EffectTracker();
  #movementTracker = new MovementTracker();

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

    // Initialize HP, effect, and movement baselines for all combatants
    for (const c of combat.turns) {
      if (c.actor) this.#healthTracker.initBaseline(c.actor);
      if (c.actor) this.#effectTracker.initBaseline(c.actor);
      if (c.token) this.#movementTracker.initBaseline(c.token);
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

    // Finalize HP, effects, and movement for the previous turn
    this.#finalizeCurrentTurnHP(combat, prior.round);
    this.#finalizeCurrentTurnEffects(combat, prior.round);
    this.#finalizeCurrentTurnMovement(combat, prior.round);

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

  /**
   * Called from the updateToken hook when a token's position changes during combat.
   * @param {TokenDocument} token
   * @param {object} changes
   */
  onTokenMove(token, changes) {
    if (!this.#encounter) return;
    this.#movementTracker.onTokenMove(token, changes);
  }

  endCombat(combat, options, userId) {
    if (!this.#encounter || combat.id !== this.#combatId) return;

    // Finalize HP, effects, and movement for the last active turn
    this.#finalizeCurrentTurnHP(combat, combat.round);
    this.#finalizeCurrentTurnEffects(combat, combat.round);
    this.#finalizeCurrentTurnMovement(combat, combat.round);

    this.#encounter.ended_at = new Date().toISOString();

    const totalRounds = this.#encounter.rounds.length;
    const totalTurns = this.#encounter.rounds.reduce((sum, r) => sum + r.turns.length, 0);
    console.log(`${MODULE_ID} | Combat ended: ${this.#encounter.encounter_id} (${totalRounds} rounds, ${totalTurns} turns)`);

    game.combatChronicle.lastEncounter = structuredClone(this.#encounter);

    this.#healthTracker.reset();
    this.#effectTracker.reset();
    this.#movementTracker.reset();
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
    const effectsSnap = actor ? this.#effectTracker.snapshotEffects(actor) : [];

    // Initialize HP, effects, and movement baselines for this actor's turn
    if (actor) this.#healthTracker.initBaseline(actor);
    if (actor) this.#effectTracker.initBaseline(actor);
    if (combatant.token) this.#movementTracker.initBaseline(combatant.token);

    const tokenPos = combatant.token ? { x: combatant.token.x, y: combatant.token.y } : null;

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
      effects_start: effectsSnap,
      effects_end: [],
      effects_gained: [],
      effects_lost: [],
      effects_changed: [],
      position_start: tokenPos,
      position_end: null,
      movements: [],
      total_distance_ft: 0,
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

  /**
   * Finalize effects end snapshot and compute diff for the current turn.
   * @param {Combat} combat
   * @param {number} roundNum — the round of the turn being finalized
   */
  #finalizeCurrentTurnEffects(combat, roundNum) {
    const round = this.#encounter.rounds.find(r => r.round_number === roundNum);
    if (!round || round.turns.length === 0) return;

    const turn = round.turns[round.turns.length - 1];
    if (turn.effects_end.length > 0) return; // already finalized

    const actor = game.actors?.get(turn.actor_id);
    if (actor) {
      turn.effects_end = this.#effectTracker.snapshotEffects(actor);
      const diff = this.#effectTracker.computeDiff(turn.actor_id, turn.effects_end);
      turn.effects_gained = diff.effects_gained;
      turn.effects_lost = diff.effects_lost;
      turn.effects_changed = diff.effects_changed;
    }
  }

  /**
   * Finalize movement data for the current turn.
   * @param {Combat} combat
   * @param {number} roundNum — the round of the turn being finalized
   */
  #finalizeCurrentTurnMovement(combat, roundNum) {
    const round = this.#encounter.rounds.find(r => r.round_number === roundNum);
    if (!round || round.turns.length === 0) return;

    const turn = round.turns[round.turns.length - 1];
    if (turn.position_end !== null) return; // already finalized

    // Find the combatant's token to get final position
    const combatant = combat.turns?.find(c => c.actor?.id === turn.actor_id);
    const token = combatant?.token;
    if (token) {
      turn.position_end = { x: token.x, y: token.y };
    }

    // Attach accumulated movement events
    turn.movements = this.#movementTracker.drainMovements();
    turn.total_distance_ft = turn.movements.reduce((sum, m) => sum + m.distance_ft, 0);
    // Round total to 1 decimal
    turn.total_distance_ft = Math.round(turn.total_distance_ft * 10) / 10;
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
