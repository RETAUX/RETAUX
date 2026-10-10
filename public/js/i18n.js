/**
 * RETAUX — client-side i18n
 * Loads locale JSON, replaces all [data-i18n] elements, saves lang cookie.
 */
(function () {
  const LANGS = { es: '🇪🇸', en: '🇬🇧', fr: '🇫🇷', it: '🇮🇹' };
  const LANG_NAMES = { es: 'ES', en: 'EN', fr: 'FR', it: 'IT' };

  function getCookie(name) {
    const m = document.cookie.match('(?:^|;)\\s*' + name + '=([^;]*)');
    return m ? decodeURIComponent(m[1]) : null;
  }

  function setCookie(name, value) {
    document.cookie = name + '=' + encodeURIComponent(value) + ';path=/;max-age=31536000;SameSite=Lax';
  }

  function getNestedKey(obj, key) {
    return key.split('.').reduce((o, k) => (o && o[k] !== undefined ? o[k] : null), obj);
  }

  function applyTranslations(translations) {
    document.querySelectorAll('[data-i18n]').forEach(function (el) {
      const key = el.getAttribute('data-i18n');
      const val = getNestedKey(translations, key);
      if (val !== null) el.innerHTML = val;
    });
    document.querySelectorAll('[data-i18n-placeholder]').forEach(function (el) {
      const key = el.getAttribute('data-i18n-placeholder');
      const val = getNestedKey(translations, key);
      if (val !== null) el.placeholder = val;
    });
    document.querySelectorAll('[data-i18n-value]').forEach(function (el) {
      const key = el.getAttribute('data-i18n-value');
      const val = getNestedKey(translations, key);
      if (val !== null) el.value = val;
    });
  }

  function loadLang(lang, callback) {
    if (!LANGS[lang]) lang = 'en';
    const cached = sessionStorage.getItem('i18n_' + lang);
    if (cached) {
      callback(JSON.parse(cached));
      return;
    }
    fetch('/locales/' + lang + '.json')
      .then(function (r) { return r.json(); })
      .then(function (data) {
        sessionStorage.setItem('i18n_' + lang, JSON.stringify(data));
        callback(data);
      })
      .catch(function () { console.warn('[i18n] Could not load locale:', lang); });
  }

  function switchLang(lang) {
    setCookie('lang', lang);
    window.location.reload();
  }

  function updateSelector(currentLang) {
    const btn = document.getElementById('lang-current');
    if (btn) {
      btn.innerHTML = LANGS[currentLang] + ' ' + LANG_NAMES[currentLang] + ' ▾';
    }
    document.querySelectorAll('.lang-option').forEach(function (opt) {
      opt.classList.toggle('lang-option--active', opt.dataset.lang === currentLang);
    });
  }

  function buildSelector() {
    const container = document.getElementById('lang-selector');
    if (!container) return;
    const currentLang = getCookie('lang') || 'en';

    container.innerHTML =
      '<button id="lang-current" class="lang-btn" aria-haspopup="true" aria-expanded="false">' +
      LANGS[currentLang] + ' ' + LANG_NAMES[currentLang] + ' ▾</button>' +
      '<div class="lang-dropdown" id="lang-dropdown">' +
      Object.keys(LANGS).map(function (l) {
        return '<button class="lang-option' + (l === currentLang ? ' lang-option--active' : '') +
          '" data-lang="' + l + '">' + LANGS[l] + ' ' + LANG_NAMES[l] + '</button>';
      }).join('') +
      '</div>';

    document.getElementById('lang-current').addEventListener('click', function (e) {
      e.stopPropagation();
      const dropdown = document.getElementById('lang-dropdown');
      const expanded = dropdown.classList.toggle('open');
      this.setAttribute('aria-expanded', expanded);
    });

    container.querySelectorAll('.lang-option').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        document.getElementById('lang-dropdown').classList.remove('open');
        switchLang(this.dataset.lang);
      });
    });

    document.addEventListener('click', function () {
      const dd = document.getElementById('lang-dropdown');
      if (dd) dd.classList.remove('open');
    });
  }

  document.addEventListener('DOMContentLoaded', function () {
    buildSelector();
    const lang = getCookie('lang') || 'en';
    loadLang(lang, function (translations) {
      applyTranslations(translations);
      document.documentElement.lang = lang;
    });
  });

  window.retauxI18n = { switchLang: switchLang };
})();
