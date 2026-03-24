import { HealthTracker } from './health-tracker.js';
import { EffectTracker } from './effect-tracker.js';
import { MovementTracker } from './movement-tracker.js';
import { MessageParser } from './message-parser.js';
import { generateSummary } from './summary-generator.js';

const MODULE_ID = 'pf2e-combat-chronicle';
const SAVE_DEBOUNCE_MS = 1000;

export class CombatTracker {
  #encounter = null;
  #combatId = null;
  #healthTracker = new HealthTracker();
  #effectTracker = new EffectTracker();
  #movementTracker = new MovementTracker();
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
      base_actor_id: c.actorId ?? c.actor?.id ?? null,
      actor_level: c.actor?.system?.details?.level?.value ?? null,
      actor_type: c.actor?.hasPlayerOwner ? 'pc' : 'npc',
      initiative_total: c.initiative,
      token_img: c.token?.texture?.src ?? c.actor?.prototypeToken?.texture?.src ?? null,
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

    // Set ended_at timestamp on the previous turn
    this.#setTurnEndedAt(prior.round);

    // Finalize HP, effects, and movement for the previous turn
    this.#finalizeCurrentTurnHP(combat, prior.round);
    this.#finalizeCurrentTurnEffects(combat, prior.round);
    this.#finalizeCurrentTurnMovement(combat, prior.round);

    // Update initiative_order if a new combatant has joined mid-combat
    this.#syncInitiativeOrder(combat);

    // Use current.round from hook params (combat.round may not be updated yet)
    this.#ensureRound(combat, current.round);
    this.#ensureTurn(combat, current.round);
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

    // Resolve target actor_ids to names
    this.#resolveTargetNames(result, combat);

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
      result.actor_id = speakerActorId;
      currentTurn.actions.push(result);
    }
  }

  /**
   * Called from the createItem hook when an item is added to an actor.
   * @param {Item} item
   * @param {object} options
   * @param {string} userId
   */
  onItemCreated(item, options, userId) {
    if (!this.#encounter) return;
    this.#effectTracker.onEffectCreated(item, options, userId);
  }

  /**
   * Called from the deleteItem hook when an item is removed from an actor.
   * @param {Item} item
   * @param {object} options
   * @param {string} userId
   */
  onItemDeleted(item, options, userId) {
    if (!this.#encounter) return;
    this.#effectTracker.onEffectDeleted(item, options, userId);
  }

  /**
   * Called from the preUpdateItem hook to capture old values before update.
   * @param {Item} item
   * @param {object} changes
   */
  onItemPreUpdate(item, changes) {
    if (!this.#encounter) return;
    this.#effectTracker.capturePreUpdateValue(item, changes);
  }

  /**
   * Called from the updateItem hook when an item on an actor is updated.
   * @param {Item} item
   * @param {object} changes
   * @param {object} options
   * @param {string} userId
   */
  onItemUpdated(item, changes, options, userId) {
    if (!this.#encounter) return;
    this.#effectTracker.onEffectUpdated(item, changes, options, userId);
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

    // Cancel any pending debounced save — combat is being deleted
    if (this.#saveTimeout) {
      clearTimeout(this.#saveTimeout);
      this.#saveTimeout = null;
    }

    // Set ended_at timestamp on the last active turn
    this.#setTurnEndedAt(combat.round);

    // Finalize HP, effects, and movement for the last active turn
    this.#finalizeCurrentTurnHP(combat, combat.round);
    this.#finalizeCurrentTurnEffects(combat, combat.round);
    this.#finalizeCurrentTurnMovement(combat, combat.round);

    this.#encounter.ended_at = new Date().toISOString();

    // Generate summary statistics
    this.#encounter.summary = generateSummary(this.#encounter);

    const totalRounds = this.#encounter.rounds.length;
    const totalTurns = this.#encounter.rounds.reduce((sum, r) => sum + r.turns.length, 0);
    console.log(`${MODULE_ID} | Combat ended: ${this.#encounter.encounter_id} (${totalRounds} rounds, ${totalTurns} turns)`);

    game.combatChronicle.lastEncounter = structuredClone(this.#encounter);

    this.#healthTracker.reset();
    this.#effectTracker.reset();
    this.#movementTracker.reset();
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

  #ensureRound(combat, explicitRound) {
    const roundNum = explicitRound ?? combat.round;
    const existing = this.#encounter.rounds.find(r => r.round_number === roundNum);
    if (existing) return existing;

    const round = {
      round_number: roundNum,
      started_at: new Date().toISOString(),
      turns: [],
    };
    this.#encounter.rounds.push(round);
    return round;
  }

  #ensureTurn(combat, explicitRound) {
    const combatant = combat.combatant;
    if (!combatant) return;

    const roundNum = explicitRound ?? combat.round;
    const round = this.#encounter.rounds.find(r => r.round_number === roundNum);
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
      base_actor_id: combatant.actorId ?? actor?.id ?? null,
      turn_number: round.turns.length + 1,
      started_at: new Date().toISOString(),
      ended_at: null,
      hp_start: hpSnap?.hp ?? null,
      hp_max: hpSnap?.hp_max ?? null,
      temp_hp_start: hpSnap?.temp_hp ?? null,
      hp_end: null,
      temp_hp_end: null,
      hp_changes: [],
      effects_start: effectsSnap,
      effects_end: [],
      effect_events: [],
      effects_gained: [],
      effects_lost: [],
      effects_changed: [],
      position_start: tokenPos,
      position_end: null,
      movements: [],
      speed: actor?.system?.attributes?.speed?.total ?? null,
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

    // Attach accumulated effect events to this turn
    turn.effect_events = this.#effectTracker.drainEvents();

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

  #setTurnEndedAt(roundNum) {
    const round = this.#encounter.rounds.find(r => r.round_number === roundNum);
    if (!round || round.turns.length === 0) return;
    const turn = round.turns[round.turns.length - 1];
    if (turn.ended_at === null) {
      turn.ended_at = new Date().toISOString();
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

  #resolveTargetNames(result, combat) {
    const targets = result.targets;
    if (!targets) return;
    for (const target of targets) {
      if (target.actor_id) {
        const combatant = combat.combatants?.find(c => c.actor?.id === target.actor_id);
        if (!target.name) {
          target.name = game.actors?.get(target.actor_id)?.name
            ?? combatant?.name
            ?? null;
        }
        if (!target.token_img) {
          target.token_img = combatant?.token?.texture?.src
            ?? game.actors?.get(target.actor_id)?.prototypeToken?.texture?.src
            ?? null;
        }
      }
    }
  }

  /**
   * Sync initiative_order with the current combat.turns, adding any new combatants.
   */
  #syncInitiativeOrder(combat) {
    const knownIds = new Set(this.#encounter.initiative_order.map(e => e.actor_id));
    for (const c of combat.turns) {
      const actorId = c.actor?.id ?? null;
      if (!actorId || knownIds.has(actorId)) continue;

      this.#encounter.initiative_order.push({
        name: c.name,
        actor_id: actorId,
        base_actor_id: c.actorId ?? actorId,
        actor_level: c.actor?.system?.details?.level?.value ?? null,
        actor_type: c.actor?.hasPlayerOwner ? 'pc' : 'npc',
        initiative_total: c.initiative,
        token_img: c.token?.texture?.src ?? c.actor?.prototypeToken?.texture?.src ?? null,
      });
      knownIds.add(actorId);

      // Initialize baselines for new combatant
      if (c.actor) this.#healthTracker.initBaseline(c.actor);
      if (c.actor) this.#effectTracker.initBaseline(c.actor);
      if (c.token) this.#movementTracker.initBaseline(c.token);

      console.log(`${MODULE_ID} | Added late combatant to initiative: ${c.name}`);
    }

    // Re-sort by initiative_total descending
    this.#encounter.initiative_order.sort((a, b) => (b.initiative_total ?? 0) - (a.initiative_total ?? 0));
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
