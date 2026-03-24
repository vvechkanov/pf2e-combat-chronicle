import { HealthTracker } from './health-tracker.js';
import { EffectTracker } from './effect-tracker.js';
import { MessageParser } from './message-parser.js';

const MODULE_ID = 'pf2e-combat-chronicle';
const SAVE_DEBOUNCE_MS = 1000;

export class CombatTracker {
  #encounter = null;
  #combatId = null;
  #healthTracker = new HealthTracker();
  #effectTracker = new EffectTracker();
  #saveTimeout = null;
  #messageParser = new MessageParser();

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
      if (c.actor) this.#effectTracker.initBaseline(c.actor);
    }

    this.#ensureRound(combat);
    this.#ensureTurn(combat);

    console.log(`${MODULE_ID} | Combat started: ${this.#encounter.encounter_id}`);
    this.#scheduleSave();
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

    // Finalize HP and effects for the previous turn
    this.#finalizeCurrentTurnHP(combat, prior.round);
    this.#finalizeCurrentTurnEffects(combat, prior.round);

    this.#ensureRound(combat);
    this.#ensureTurn(combat);
    this.#scheduleSave();
  }

  onRoundChange(combat, updateData, updateOptions) {
    if (!this.#encounter || combat.id !== this.#combatId) return;
    this.#ensureRound(combat);
    this.#scheduleSave();
  }

  /**
   * Called from the updateActor hook when HP changes during combat.
   * @param {Actor} actor
   * @param {object} changes
   */
  onActorHPUpdate(actor, changes) {
    if (!this.#encounter) return;
    this.#healthTracker.onHPChange(actor, changes);
    this.#scheduleSave();
  }

  /**
   * Called from the createChatMessage hook to classify and record actions.
   * @param {ChatMessage} message
   */
  onChatMessage(message) {
    if (!this.#encounter) return;

    const combat = game.combat;
    if (!combat || combat.id !== this.#combatId) return;

    const speakerActorId = message.speaker?.actor;
    if (!speakerActorId) return;

    const isCombatant = combat.turns.some(c => c.actor?.id === speakerActorId);
    if (!isCombatant) return;

    const result = this.#messageParser.parse(message);
    if (!result) return;

    const currentTurn = this.#getCurrentTurn();
    if (!currentTurn) return;

    // Record raw message summary
    currentTurn.chat_messages.push({
      speaker_actor_id: speakerActorId,
      type: message.flags?.pf2e?.context?.type ?? null,
      timestamp: new Date().toISOString(),
    });

    if (result._type === 'damage-enrichment') {
      this.#enrichLastAction(currentTurn, result);
    } else {
      // Tag reactions (speaker is not the active combatant)
      const activeCombatantActorId = combat.combatant?.actor?.id ?? null;
      if (activeCombatantActorId && speakerActorId !== activeCombatantActorId) {
        result.notes = 'reaction';
      }
      currentTurn.actions.push(result);
    }
  }

  endCombat(combat, options, userId) {
    if (!this.#encounter || combat.id !== this.#combatId) return;

    // Cancel any pending debounced save — combat is being deleted
    if (this.#saveTimeout) {
      clearTimeout(this.#saveTimeout);
      this.#saveTimeout = null;
    }

    // Finalize HP and effects for the last active turn
    this.#finalizeCurrentTurnHP(combat, combat.round);
    this.#finalizeCurrentTurnEffects(combat, combat.round);

    this.#encounter.ended_at = new Date().toISOString();

    const totalRounds = this.#encounter.rounds.length;
    const totalTurns = this.#encounter.rounds.reduce((sum, r) => sum + r.turns.length, 0);
    console.log(`${MODULE_ID} | Combat ended: ${this.#encounter.encounter_id} (${totalRounds} rounds, ${totalTurns} turns)`);

    game.combatChronicle.lastEncounter = structuredClone(this.#encounter);

    this.#healthTracker.reset();
    this.#effectTracker.reset();
    this.#messageParser.reset();
    this.#encounter = null;
    this.#combatId = null;
  }

  /**
   * Restore tracker state from Combat document flags after a page reload.
   * @param {Combat} combat — the active combat with persisted flags
   */
  restoreState(combat) {
    const encounterState = combat.getFlag(MODULE_ID, 'encounterState');
    if (!encounterState) return;

    this.#combatId = combat.id;
    this.#encounter = encounterState;

    const healthState = combat.getFlag(MODULE_ID, 'healthState');
    this.#healthTracker.restoreState(healthState);

    const effectState = combat.getFlag(MODULE_ID, 'effectState');
    this.#effectTracker.restoreState(effectState);

    console.log(`${MODULE_ID} | Restored combat state: ${this.#encounter.encounter_id}`);
  }

  // ── Persistence ──────────────────────────────────────────────

  /**
   * Schedule a debounced save of the current state to Combat flags.
   */
  #scheduleSave() {
    if (!this.#encounter || !this.#combatId) return;
    if (this.#saveTimeout) clearTimeout(this.#saveTimeout);
    this.#saveTimeout = setTimeout(() => this.#persistState(), SAVE_DEBOUNCE_MS);
  }

  /**
   * Persist current encounter, health, and effect state to the Combat document.
   * Uses a single update call to minimize DB writes.
   */
  async #persistState() {
    this.#saveTimeout = null;
    if (!this.#encounter || !this.#combatId) return;

    const combat = game.combats?.get(this.#combatId);
    if (!combat) return;

    try {
      await combat.update({
        [`flags.${MODULE_ID}`]: {
          encounterState: this.#encounter,
          healthState: this.#healthTracker.serialize(),
          effectState: this.#effectTracker.serialize(),
        },
      });
    } catch (err) {
      console.error(`${MODULE_ID} | Failed to persist combat state`, err);
    }
  }

  // ── Round / Turn helpers ─────────────────────────────────────

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

    // Initialize HP and effects baselines for this actor's turn
    if (actor) this.#healthTracker.initBaseline(actor);
    if (actor) this.#effectTracker.initBaseline(actor);

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

  #getCurrentTurn() {
    if (!this.#encounter || this.#encounter.rounds.length === 0) return null;
    const round = this.#encounter.rounds[this.#encounter.rounds.length - 1];
    if (round.turns.length === 0) return null;
    return round.turns[round.turns.length - 1];
  }

  #enrichLastAction(turn, enrichment) {
    // Walk backward to find the most recent action without damage data
    for (let i = turn.actions.length - 1; i >= 0; i--) {
      const action = turn.actions[i];
      if (action.damage_dealt === null && action.healing_done === null) {
        action.damage_dealt = enrichment.damage_dealt;
        action.damage_type = enrichment.damage_type;
        action.healing_done = enrichment.healing_done;
        return;
      }
    }
    // No matching action — create standalone damage entry
    turn.actions.push({
      action_name: enrichment.healing_done ? 'Healing' : 'Damage',
      action_cost: 0,
      action_type: 'other',
      item_name: null,
      item_type: null,
      targets: enrichment.targets,
      roll_result: enrichment.roll_result,
      roll_formula: null,
      degree_of_success: null,
      damage_dealt: enrichment.damage_dealt,
      damage_type: enrichment.damage_type,
      healing_done: enrichment.healing_done,
      map_penalty: null,
      notes: 'standalone damage roll',
    });
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
