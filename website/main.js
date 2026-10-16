/**
 * The page's movement, and nothing else.
 *
 * Three rules hold here, and each exists because of a failure this project already had.
 *
 * 1. **The content does not depend on this file.** The reveal animation starts hidden, but only
 *    under `@media (scripting: enabled)`, and a timer shows everything 1.4 seconds after load
 *    whatever the observer does. The first version hid `.reveal` unconditionally and the page
 *    rendered blank.
 * 2. **Nothing moves for someone who asked it not to.** `prefers-reduced-motion` is honoured in
 *    the stylesheet for transitions and here for the effects driven by scroll and pointer, which
 *    CSS cannot switch off on its own.
 * 3. **Every listener is passive and rAF-throttled.** A scroll handler that reads layout on every
 *    event is how a decorative animation turns into a janky page.
 */
(function () {
  "use strict";

  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  /** Frame-throttle: at most one call per animation frame, whatever the event rate. */
  function onFrame(handler) {
    var queued = false;
    return function () {
      if (queued) return;
      queued = true;
      requestAnimationFrame(function () { handler(); queued = false; });
    };
  }

  /** Everything prepared for a reveal is revealed, whatever the observer does or does not do. */
  function showAll() {
    document.querySelectorAll(".reveal:not(.is-in)").forEach(function (element) {
      element.classList.add("is-in");
    });
  }

  // The second net. It fires if the observer has not revealed the page shortly after load, which
  // is what happens in a headless browser and in anything else that renders without scrolling.
  var failsafe = setTimeout(showAll, 1400);

  function startReveal() {
    var observer = new IntersectionObserver(function (entries) {
      clearTimeout(failsafe);
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        entry.target.classList.add("is-in");
        // One way: a section that has appeared does not disappear and come back, which reads as a
        // flicker rather than as an entrance. The failsafe already cleared, so calling it here is
        // only about a page that scrolls faster than the timer.
        observer.unobserve(entry.target);
      });
    }, { rootMargin: "0px 0px -12% 0px", threshold: 0.08 });

    document.querySelectorAll(".reveal").forEach(function (element, index) {
      // A small stagger inside a group, so a row of cards arrives as a row rather than as a wall.
      element.style.transitionDelay = Math.min(index % 6, 5) * 55 + "ms";
      observer.observe(element);
    });

    // A page opened from the middle, by a link with a fragment, can have everything above the fold
    // already past the observer's trigger.
    requestAnimationFrame(function () {
      document.querySelectorAll(".reveal").forEach(function (element) {
        if (element.getBoundingClientRect().top < window.innerHeight) element.classList.add("is-in");
      });
    });
  }

  /** The navigation bar gains a background once the page has moved, so the links stay readable. */
  function startNav() {
    var nav = document.getElementById("nav");
    if (!nav) return;
    var apply = function () { nav.classList.toggle("is-stuck", window.scrollY > 24); };
    window.addEventListener("scroll", onFrame(apply), { passive: true });
    apply();
  }

  /** How far down the page the reader is, as a hairline across the top. */
  function startProgress() {
    var bar = document.getElementById("progressBar");
    if (!bar) return;
    var apply = function () {
      var scrollable = document.documentElement.scrollHeight - window.innerHeight;
      var ratio = scrollable > 0 ? Math.min(window.scrollY / scrollable, 1) : 0;
      bar.style.width = (ratio * 100).toFixed(2) + "%";
    };
    window.addEventListener("scroll", onFrame(apply), { passive: true });
    window.addEventListener("resize", onFrame(apply), { passive: true });
    apply();
  }

  /** The hero screenshot drifts a little against the scroll. Small numbers on purpose: a parallax
   *  big enough to notice is a parallax that makes the text beside it harder to read. */
  function startParallax() {
    var elements = [].slice.call(document.querySelectorAll("[data-parallax]"));
    if (!elements.length) return;
    var apply = function () {
      var offset = Math.min(window.scrollY, 900);
      elements.forEach(function (element) {
        var rate = Number(element.dataset.parallax) || 0;
        element.style.transform = "translate3d(0, " + (offset * rate).toFixed(2) + "px, 0)";
      });
    };
    window.addEventListener("scroll", onFrame(apply), { passive: true });
    apply();
  }

  /** Screenshots tilt towards the pointer, a couple of degrees at most. */
  function startTilt() {
    if (window.matchMedia("(hover: none)").matches) return;
    document.querySelectorAll("[data-tilt]").forEach(function (wrapper) {
      var target = wrapper.querySelector(".window") || wrapper;
      var reset = function () { target.style.transform = ""; };
      wrapper.addEventListener("pointermove", function (event) {
        var box = wrapper.getBoundingClientRect();
        var x = (event.clientX - box.left) / box.width - 0.5;
        var y = (event.clientY - box.top) / box.height - 0.5;
        target.style.transition = "transform .2s var(--ease)";
        target.style.transform = "perspective(1200px) rotateY(" + (x * 3).toFixed(2) + "deg) rotateX(" + (-y * 2.4).toFixed(2) + "deg)";
      });
      wrapper.addEventListener("pointerleave", reset);
      wrapper.addEventListener("blur", reset);
    });
  }

  /** The light that follows the pointer across a card, using the two custom properties the
   *  stylesheet reads. Nothing is repainted except the gradient's position. */
  function startSpotlight() {
    if (window.matchMedia("(hover: none)").matches) return;
    document.querySelectorAll("[data-spotlight]").forEach(function (card) {
      card.addEventListener("pointermove", function (event) {
        var box = card.getBoundingClientRect();
        card.style.setProperty("--mx", (event.clientX - box.left).toFixed(1) + "px");
        card.style.setProperty("--my", (event.clientY - box.top).toFixed(1) + "px");
      });
    });
  }

  /** The numbers in the strip count up when they arrive, once. A number that animates every time
   *  it scrolls past is a number nobody trusts. */
  function startCounters() {
    var nodes = [].slice.call(document.querySelectorAll("[data-count]"));
    if (!nodes.length) return;
    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        var node = entry.target;
        observer.unobserve(node);
        var end = Number(node.dataset.count) || 0;
        var started = performance.now();
        var step = function (now) {
          var progress = Math.min((now - started) / 750, 1);
          // Ease out, so the number settles rather than stopping dead.
          var eased = 1 - Math.pow(1 - progress, 3);
          node.textContent = String(Math.round(end * eased));
          if (progress < 1) requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      });
    }, { threshold: 0.4 });
    nodes.forEach(function (node) { observer.observe(node); });
  }

  function start() {
    if (reduceMotion.matches) {
      // No observers, no scroll listeners: the page is simply there.
      clearTimeout(failsafe);
      showAll();
      return;
    }
    startReveal();
    startNav();
    startProgress();
    startParallax();
    startTilt();
    startSpotlight();
    startCounters();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
