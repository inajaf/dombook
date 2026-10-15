/**
 * The page's movement, and nothing else.
 *
 * Two rules hold here, and both exist because of failures this project has already had:
 *
 * 1. **The content does not depend on this file.** The reveal animation starts from `opacity: 0`
 *    in CSS, so if the script fails to load — a CSP problem, a typo, a file that did not ship —
 *    a page that hides its own sections is worse than a page with no animation. The stylesheet
 *    therefore only *prepares* the movement, and this file is what makes the content visible.
 *    The `.no-js` class is added by the script itself, so a reader without it sees everything.
 * 2. **Nothing moves for someone who asked it not to.** `prefers-reduced-motion` is honoured in
 *    CSS for the transitions and checked here for the parallax, which CSS cannot turn off on its
 *    own because it is driven by scroll position.
 */

(function () {
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  // The second net. The observer below reveals what scrolls into view; this reveals EVERYTHING if
  // that has not happened shortly after load, which is the case in a headless browser, in a page
  // loaded from a cache without layout, and in anything else that renders without scrolling. The
  // cost of the net is that a slow connection sees the page appear at once rather than in sequence,
  // which is a far better failure than a page that stays blank.
  const failsafe = setTimeout(() => {
    document.querySelectorAll(".reveal:not(.is-in)").forEach((element) => element.classList.add("is-in"));
  }, 1400);

  /** Everything prepared for a reveal is revealed, whatever the observer does or does not do. */
  function showAll() {
    document.querySelectorAll(".reveal").forEach((element) => element.classList.add("is-in"));
  }

  if (reduceMotion.matches) {
    // No observer, no scroll listener: the page is simply there.
    clearTimeout(failsafe);
    showAll();
  } else {
    const observer = new IntersectionObserver((entries) => {
      clearTimeout(failsafe);
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add("is-in");
        // One way: a section that has appeared does not disappear when it scrolls away and come
        // back again, which reads as a flicker rather than as an entrance.
        observer.unobserve(entry.target);
      }
    }, { rootMargin: "0px 0px -12% 0px", threshold: 0.08 });

    document.querySelectorAll(".reveal").forEach((element, index) => {
      // A small stagger inside a group, so a row of cards arrives as a row rather than as a wall.
      element.style.transitionDelay = `${Math.min(index % 6, 5) * 55}ms`;
      observer.observe(element);
    });

    // A page loaded from the middle — a link with a fragment — can have everything above the fold
    // already past the observer's trigger. Anything already on screen is shown immediately.
    requestAnimationFrame(() => {
      for (const element of document.querySelectorAll(".reveal")) {
        if (element.getBoundingClientRect().top < window.innerHeight) element.classList.add("is-in");
      }
    });

    // The navigation bar gains a background once the page has moved, so the links stay readable over
    // whatever is behind them.
    const nav = document.getElementById("nav");
    let ticking = false;
    const onScroll = () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        nav.classList.toggle("is-stuck", window.scrollY > 24);
        ticking = false;
      });
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();

    // The hero screenshot drifts a little against the scroll. Small numbers on purpose: a parallax
    // big enough to notice is a parallax that makes the text beside it harder to read.
    const parallax = [...document.querySelectorAll("[data-parallax]")];
    if (parallax.length) {
      const apply = () => {
        for (const element of parallax) {
          const rate = Number(element.dataset.parallax) || 0;
          const offset = Math.min(window.scrollY, 900) * rate;
          element.style.transform = `translate3d(0, ${offset.toFixed(2)}px, 0)`;
        }
      };
      let queued = false;
      window.addEventListener("scroll", () => {
        if (queued) return;
        queued = true;
        requestAnimationFrame(() => { apply(); queued = false; });
      }, { passive: true });
      apply();
    }
  }

  // The version is IN THE MARKUP, not fetched: a static page that fills in its own version is a page
  // that shows a blank where a number belongs when the fetch fails. The number staying true to
  // `package.json` is a test's job (`tests/website.test.cjs`), not a browser's.
})();
