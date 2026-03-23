const MODULE_ID = 'pf2e-combat-chronicle';

Hooks.once('init', () => {
  console.log(`${MODULE_ID} | Initializing`);
});

Hooks.once('ready', () => {
  if (!game.user.isGM) return;
  console.log(`${MODULE_ID} | Ready (GM mode)`);
});
