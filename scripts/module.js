import { CombatTracker } from './combat-tracker.js';

const MODULE_ID = 'pf2e-combat-chronicle';

Hooks.once('init', () => {
  console.log(`${MODULE_ID} | Initializing`);
});

Hooks.once('ready', () => {
  if (!game.user.isGM) return;
  console.log(`${MODULE_ID} | Ready (GM mode)`);

  const tracker = new CombatTracker();

  game.combatChronicle = {
    tracker,
    get currentEncounter() { return tracker.currentEncounter; },
    lastEncounter: null,
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

  Hooks.on('deleteCombat', (combat, options, userId) => {
    tracker.endCombat(combat, options, userId);
  });
});
