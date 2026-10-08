(function (root) {
  'use strict';
  const bindings = new WeakMap();

  function bind(trigger, sheet, closeButton) {
    if (!trigger || !sheet || !closeButton) return null;
    if (bindings.has(trigger)) return bindings.get(trigger);
    let opened = false;
    const hide = () => {
      if (!opened) return;
      opened = false;
      sheet.classList.add('hidden');
      sheet.setAttribute('aria-hidden', 'true');
      trigger.setAttribute('aria-expanded', 'false');
      trigger.focus();
    };
    const show = () => {
      opened = true;
      sheet.classList.remove('hidden');
      sheet.setAttribute('aria-hidden', 'false');
      trigger.setAttribute('aria-expanded', 'true');
      closeButton.focus();
    };
    trigger.setAttribute('aria-expanded', 'false');
    trigger.addEventListener('click', show);
    closeButton.addEventListener('click', hide);
    sheet.addEventListener('click', event => {
      if (event.target === sheet) hide();
    });
    // A help sheet has a single action: keep keyboard focus on its close button.
    sheet.ownerDocument.addEventListener('keydown', event => {
      if (!opened) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        hide();
      } else if (event.key === 'Tab') {
        event.preventDefault();
        closeButton.focus();
      }
    });
    const controller = { show, hide };
    bindings.set(trigger, controller);
    return controller;
  }

  root.HelpSheet = { bind };
  if (typeof module !== 'undefined') module.exports = root.HelpSheet;
})(typeof window === 'undefined' ? globalThis : window);
