(() => {
  const locales = window.DomBookLocales || {};
  const textSources = new WeakMap();
  const attributeSources = new WeakMap();
  let currentLanguage = "ru";
  let observerScheduled = false;

  function languagePack(code = currentLanguage) {
    return locales[code] || locales.ru;
  }

  function translate(source) {
    return languagePack().messages[source] || source;
  }

  function translateTextNode(node) {
    if (!textSources.has(node)) textSources.set(node, node.nodeValue);
    const source = textSources.get(node);
    const trimmed = source.trim();
    if (!trimmed) return;
    const translated = translate(trimmed);
    const leading = source.match(/^\s*/)?.[0] || "";
    const trailing = source.match(/\s*$/)?.[0] || "";
    const nextValue = `${leading}${translated}${trailing}`;
    if (node.nodeValue !== nextValue) node.nodeValue = nextValue;
  }

  function translateAttributes(element) {
    const attributes = ["placeholder", "aria-label", "title"];
    let sources = attributeSources.get(element);
    if (!sources) {
      sources = {};
      attributeSources.set(element, sources);
    }
    attributes.forEach((name) => {
      if (!element.hasAttribute(name)) return;
      if (!(name in sources)) sources[name] = element.getAttribute(name);
      const nextValue = translate(sources[name]);
      if (element.getAttribute(name) !== nextValue) element.setAttribute(name, nextValue);
    });
  }

  function translateDom(root = document.body) {
    if (!root) return;
    if (root.nodeType === Node.ELEMENT_NODE) translateAttributes(root);
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    let node = walker.currentNode;
    while (node) {
      if (node.nodeType === Node.TEXT_NODE && !node.parentElement?.closest("[data-i18n-ignore]")) {
        translateTextNode(node);
      } else if (node.nodeType === Node.ELEMENT_NODE && !node.closest("[data-i18n-ignore]")) {
        translateAttributes(node);
      }
      node = walker.nextNode();
    }
    document.documentElement.lang = languagePack().htmlLang;
  }

  function setLanguage(code) {
    currentLanguage = locales[code] ? code : "ru";
    translateDom();
    window.dispatchEvent(new CustomEvent("dombook:language-changed", {
      detail: { language: currentLanguage },
    }));
    return currentLanguage;
  }

  const observer = new MutationObserver(() => {
    if (observerScheduled) return;
    observerScheduled = true;
    queueMicrotask(() => {
      observerScheduled = false;
      translateDom();
    });
  });

  window.i18n = {
    get language() { return currentLanguage; },
    get locale() { return languagePack().locale; },
    setLanguage,
    t: translate,
    translateDom,
  };

  document.addEventListener("DOMContentLoaded", () => {
    translateDom();
    observer.observe(document.body, { childList: true, subtree: true });
  });
})();
