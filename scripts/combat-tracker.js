const MODULE_ID = 'pf2e-combat-chronicle';

export class CombatTracker {
  #encounter = null;
  #combatId = null;

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

    this.#ensureRound(combat);
    this.#ensureTurn(combat);
  }

  onRoundChange(combat, updateData, updateOptions) {
    if (!this.#encounter || combat.id !== this.#combatId) return;
    this.#ensureRound(combat);
  }

  endCombat(combat, options, userId) {
    if (!this.#encounter || combat.id !== this.#combatId) return;

    this.#encounter.ended_at = new Date().toISOString();

    const totalRounds = this.#encounter.rounds.length;
    const totalTurns = this.#encounter.rounds.reduce((sum, r) => sum + r.turns.length, 0);
    console.log(`${MODULE_ID} | Combat ended: ${this.#encounter.encounter_id} (${totalRounds} rounds, ${totalTurns} turns)`);

    game.combatChronicle.lastEncounter = structuredClone(this.#encounter);

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

    const turn = {
      combatant_name: combatant.name,
      actor_id: combatant.actor?.id ?? null,
      turn_number: round.turns.length + 1,
      actions: [],
      chat_messages: [],
    };
    round.turns.push(turn);
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
