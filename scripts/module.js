import { CombatTracker } from './combat-tracker.js';
import { JournalWriter } from './journal-writer.js';

const MODULE_ID = 'pf2e-combat-chronicle';

Hooks.once('init', () => {
  console.log(`${MODULE_ID} | Initializing`);

  game.settings.register(MODULE_ID, 'autoSave', {
    name: `${MODULE_ID}.settings.autoSave.name`,
    hint: `${MODULE_ID}.settings.autoSave.hint`,
    scope: 'world',
    config: true,
    type: Boolean,
    default: true,
  });

  game.settings.register(MODULE_ID, 'generateReadableJournal', {
    name: `${MODULE_ID}.settings.generateReadableJournal.name`,
    hint: `${MODULE_ID}.settings.generateReadableJournal.hint`,
    scope: 'world',
    config: true,
    type: Boolean,
    default: true,
  });

  game.settings.register(MODULE_ID, 'journalFolderName', {
    name: `${MODULE_ID}.settings.journalFolderName.name`,
    hint: `${MODULE_ID}.settings.journalFolderName.hint`,
    scope: 'world',
    config: true,
    type: String,
    default: 'Combat Chronicle',
  });
});

Hooks.once('ready', () => {
  if (!game.user.isGM) return;
  console.log(`${MODULE_ID} | Ready (GM mode)`);

  const tracker = new CombatTracker();
  const journalWriter = new JournalWriter();

  // Restore in-progress combat state if page was reloaded mid-combat
  if (game.combat) {
    try {
      tracker.restoreState(game.combat);
    } catch (err) {
      console.error(`${MODULE_ID} | Failed to restore combat state`, err);
    }
  }

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
    if (game.settings.get(MODULE_ID, 'autoSave')) {
      await journalWriter.saveEncounter(game.combatChronicle.lastEncounter);
    }
  });

  Hooks.on('updateActor', (actor, changes, options, userId) => {
    if (foundry.utils.hasProperty(changes, 'system.attributes.hp')) {
      tracker.onActorHPUpdate(actor, changes);
    }
  });

  Hooks.on('updateToken', (token, changes, options, userId) => {
    if (('x' in changes) || ('y' in changes)) {
      tracker.onTokenMove(token, changes);
    }
  });

  Hooks.on('createItem', (item, options, userId) => {
    tracker.onItemCreated(item, options, userId);
  });

  Hooks.on('deleteItem', (item, options, userId) => {
    tracker.onItemDeleted(item, options, userId);
  });

  Hooks.on('preUpdateItem', (item, changes, options, userId) => {
    tracker.onItemPreUpdate(item, changes);
  });

  Hooks.on('updateItem', (item, changes, options, userId) => {
    tracker.onItemUpdated(item, changes, options, userId);
  });

  Hooks.on('createChatMessage', (message, options, userId) => {
    tracker.onChatMessage(message);
  });
});
