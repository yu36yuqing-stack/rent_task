(() => {
  const games = [
    { key: '全部', label: '全部' },
    { key: 'WZRY', label: '王者荣耀', icon: '/assets/game_icons/wzry.webp' },
    { key: 'GTA6', label: 'GTA6', icon: '/assets/game_icons/gta6.svg' },
    { key: '和平精英', label: '和平精英', icon: '/assets/game_icons/hpjy.png' },
    { key: 'CSGO', label: 'CS2', icon: '/assets/game_icons/csgo.png?v=20260425-soldier' },
    { key: 'CFM', label: 'CFM', icon: '/assets/game_icons/cfm.png' }
  ];

  function render(scope, selected, { includeAll = true, includeConsole = true } = {}) {
    return games.filter(game => (includeAll || game.key !== '全部') && (includeConsole || game.key !== 'GTA6'))
      .map(({ key, label, icon }) => `
        <button type="button" class="stats-game-tab ${selected === key ? 'active' : ''}" data-${scope}-game="${key}">
          ${icon ? `<span class="game-avatar"><img src="${icon}" alt="" loading="lazy" decoding="async"></span>` : ''}
          <span class="stats-game-tab-text">${label}</span>
        </button>`).join('');
  }

  window.GameTabs = { render };
})();
