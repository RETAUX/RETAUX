(function () {
  var HINT_CLASS = 'decimal-hint';

  function getHint(input) {
    return input.parentNode.querySelector('.' + HINT_CLASS);
  }

  function showHint(input) {
    if (getHint(input)) return;
    var hint = document.createElement('p');
    hint.className = HINT_CLASS;
    hint.textContent = 'Use a dot for decimals — e.g. 1234.50';
    hint.style.cssText = 'margin:4px 0 0;font-size:0.78rem;color:#e67e22;font-weight:600;';
    input.parentNode.appendChild(hint);
  }

  function hideHint(input) {
    var hint = getHint(input);
    if (hint) hint.remove();
  }

  function handleInput(e) {
    var input = e.target;
    if (input.value.indexOf(',') !== -1) {
      input.value = input.value.replace(/,/g, '.');
      showHint(input);
    } else {
      hideHint(input);
    }
  }

  function handleBlur(e) {
    hideHint(e.target);
  }

  function bind(input) {
    input.addEventListener('input', handleInput);
    input.addEventListener('blur', handleBlur);
  }

  function init() {
    document.querySelectorAll('input[type="number"]').forEach(bind);
    // Para inputs que se agregan dinámicamente (employer rows, etc.)
    var observer = new MutationObserver(function (mutations) {
      mutations.forEach(function (m) {
        m.addedNodes.forEach(function (node) {
          if (node.nodeType !== 1) return;
          if (node.matches && node.matches('input[type="number"]')) bind(node);
          node.querySelectorAll && node.querySelectorAll('input[type="number"]').forEach(bind);
        });
      });
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
