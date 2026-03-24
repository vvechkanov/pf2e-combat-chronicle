import { CombatTracker } from './combat-tracker.js';
import { JournalWriter } from './journal-writer.js';

const MODULE_ID = 'pf2e-combat-chronicle';

Hooks.once('init', () => {
  console.log(`${MODULE_ID} | Initializing`);
});

Hooks.once('ready', () => {
  if (!game.user.isGM) return;
  console.log(`${MODULE_ID} | Ready (GM mode)`);

  const tracker = new CombatTracker();
  const journalWriter = new JournalWriter();

  game.combatChronicle = {
    tracker,
    journalWriter,
    get currentEncounter() { return tracker.currentEncounter; },
    lastEncounter: null,
    async saveLastEncounter() {
      if (!this.lastEncounter) {
        console.warn(`${MODULE_ID} | No last encounter to save`);
        return null;
      }
      return journalWriter.saveEncounter(this.lastEncounter);
    },
  };

  Hooks.on('combatStart', (combat, updateData) => {
    tracker.startCombat(combat, updateData);
  });

  Hooks.on('combatTurnChange', (combat, prior, current) => {
    tracker.onTurnChange(combat, prior, current);
  });

  Hooks.on('combatRound', (combat, updateData, updateOptions) => {
    tracker.onRoundChange(combat, updateData, updateOptions);
  });

  Hooks.on('deleteCombat', async (combat, options, userId) => {
    tracker.endCombat(combat, options, userId);
    await journalWriter.saveEncounter(game.combatChronicle.lastEncounter);
  });

  Hooks.on('updateActor', (actor, changes, options, userId) => {
    if (foundry.utils.hasProperty(changes, 'system.attributes.hp')) {
      tracker.onActorHPUpdate(actor, changes);
    }
  });

  Hooks.on('createChatMessage', (message, options, userId) => {
    tracker.onChatMessage(message);
  });
});
