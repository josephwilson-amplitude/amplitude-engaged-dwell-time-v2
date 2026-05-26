/**
 * Amplitude Browser SDK — Engaged Dwell Time Plugin (v2)
 *
 * Tracks only the time a user was actively engaged on a page,
 * filtering out idle periods (e.g. leaving for coffee with the tab open).
 *
 * ── Architecture ──────────────────────────────────────────────────────────────
 *
 * Uses [Amplitude] Page Counter to determine behaviour per page in the session.
 *
 * Page counter = 1 (first and only page — single-page session):
 *   Fires [Engaged Dwell] Page Exit on browser close / tab hide.
 *
 * Page counter ≥ 2 (SPA navigation detected):
 *   execute() intercepts each [Amplitude] Page Viewed event and attaches the
 *   *previous* page's dwell data as et_* properties. No extra events created.
 *   Last-page dwell time is intentionally not captured (cost/completeness tradeoff).
 *
 * ── Unified et_* property schema ──────────────────────────────────────────────
 *
 * Identical property names on both event types so they can be analysed as one
 * in Amplitude (single metric, group by et_page_title, drop in both events):
 *
 *   et_engaged_time_ms        – ms the user was actively engaged
 *   et_total_time_ms          – raw dwell time on that page
 *   et_page_url               – URL of the page being measured
 *   et_page_title             – title of the page being measured
 *   et_inactivity_threshold_ms – threshold used (for context / filtering)
 *
 * ── SPA integration ───────────────────────────────────────────────────────────
 *
 * No router hook required. The plugin detects navigation automatically via the
 * [Amplitude] Page Counter on each [Amplitude] Page Viewed event passing through
 * execute(). Ensure Amplitude's page view tracking fires on each route change
 * (defaultTracking.pageViews or manual amplitude.track('[Amplitude] Page Viewed')).
 *
 * ── Usage ─────────────────────────────────────────────────────────────────────
 *
 *   const plugin = createEngagedDwellTimePlugin({ inactivityThreshold: 30_000 });
 *   amplitude.add(plugin);
 *
 * ── Live reads (debugging / UI overlays) ──────────────────────────────────────
 *
 *   plugin.getEngagedTimeMs()
 *   plugin.getTotalTimeMs()
 *   plugin.isEngaged()
 *   plugin.getCurrentPage()   → { url, title, counter }
 */
const createEngagedDwellTimePlugin = (options = {}) => {
  const {
    inactivityThreshold = 30_000,
    tickInterval        = 1_000,
    throttleMs          = 500,
    activityEvents      = ['mousemove', 'scroll', 'keydown', 'click', 'touchstart', 'wheel'],
  } = options;

  let amplitudeInstance = null;

  // ── Per-page tracking state ─────────────────────────────────────────────────
  let pageEntryTime    = Date.now();
  let lastActivityTime = Date.now();
  let lastThrottleTime = 0;
  let lastTickTime     = Date.now();
  let engagedTimeMs    = 0;
  let tickTimer        = null;
  let hasFired         = false;

  // ── Page counter & identity ─────────────────────────────────────────────────
  let pageCounter     = 0;   // current position in the session
  let selfCounter     = 0;   // fallback if [Amplitude] Page Counter not yet set
  let currentPageUrl  = '';
  let currentPageTitle = '';

  // ─── Activity detection ─────────────────────────────────────────────────────

  const onActivity = () => {
    const now = Date.now();
    if (now - lastThrottleTime < throttleMs) return;
    lastThrottleTime = now;
    lastActivityTime = now;
  };

  // ─── Tick accumulator ───────────────────────────────────────────────────────
  // Adds elapsed time to engagedTimeMs only when the user has been active
  // within the last inactivityThreshold ms.

  const tick = () => {
    const now               = Date.now();
    const delta             = now - lastTickTime;
    lastTickTime            = now;
    const timeSinceActivity = now - lastActivityTime;
    if (timeSinceActivity < inactivityThreshold) {
      engagedTimeMs += delta;
    }
  };

  // ─── Reset tracking for a new page ─────────────────────────────────────────

  const resetTracking = () => {
    engagedTimeMs    = 0;
    pageEntryTime    = Date.now();
    lastActivityTime = Date.now();
    lastTickTime     = Date.now();
    hasFired         = false;
  };

  // ─── Page exit event (single-page sessions only) ────────────────────────────
  // Fires when exit signals arrive and the user never navigated to a second page.

  const fireSummaryEvent = () => {
    if (hasFired || !amplitudeInstance) return;
    if (pageCounter > 1) return; // navigated — last-page gap accepted, no event

    hasFired = true;
    clearInterval(tickTimer);
    tick(); // capture any remaining partial-second engagement

    amplitudeInstance.track('[Engaged Dwell] Page Exit', {
      et_engaged_time_ms:         Math.round(engagedTimeMs),
      et_total_time_ms:           Math.round(Date.now() - pageEntryTime),
      et_page_url:                currentPageUrl,
      et_page_title:              currentPageTitle,
      et_inactivity_threshold_ms: inactivityThreshold,
    });

    amplitudeInstance.flush();
  };

  // ─── Plugin interface ────────────────────────────────────────────────────────

  return {
    name: 'engaged-dwell-time',
    type: 'enrichment',

    setup: async (_config, instance) => {
      amplitudeInstance = instance;
      pageCounter       = 0;
      selfCounter       = 0;
      currentPageUrl    = location.href;
      currentPageTitle  = document.title;

      resetTracking();

      activityEvents.forEach(name => {
        window.addEventListener(name, onActivity, { passive: true });
      });

      // visibilitychange — primary signal on mobile (tab backgrounded)
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') fireSummaryEvent();
      });

      // pagehide — more reliable than beforeunload for back/forward cache
      window.addEventListener('pagehide', fireSummaryEvent);

      // beforeunload — catches desktop close/refresh missed by pagehide
      window.addEventListener('beforeunload', fireSummaryEvent);

      tickTimer = setInterval(tick, tickInterval);
    },

    // ── Core logic ──────────────────────────────────────────────────────────────
    // Intercepts [Amplitude] Page Viewed events to:
    //   • Read [Amplitude] Page Counter to know where we are in the session
    //   • Attach the previous page's dwell data as et_* properties (counter ≥ 2)
    //   • Reset tracking counters for the new page

    execute: async (event) => {
      if (event.event_type !== '[Amplitude] Page Viewed') return event;

      // Resolve page counter.
      // Prefer Amplitude's own counter; fall back to self-tracked counter if the
      // page tracking plugin runs later in the enrichment pipeline.
      const ampCounter = event.event_properties?.['[Amplitude] Page Counter'];
      const counter    = ampCounter != null ? ampCounter : ++selfCounter;
      if (ampCounter != null) selfCounter = ampCounter; // keep in sync

      if (counter >= 2) {
        // Capture any partial-second engagement before snapshotting
        tick();

        // Attach previous page's dwell data to this Page Viewed event
        event.event_properties = {
          ...event.event_properties,
          et_engaged_time_ms:         Math.round(engagedTimeMs),
          et_total_time_ms:           Math.round(Date.now() - pageEntryTime),
          et_page_url:                currentPageUrl,
          et_page_title:              currentPageTitle,
          et_inactivity_threshold_ms: inactivityThreshold,
        };

        // Reset tracking for the new page
        resetTracking();
      }

      // Update page identity from the incoming event
      pageCounter      = counter;
      currentPageUrl   = event.event_properties?.['[Amplitude] Page URL']   ?? location.href;
      currentPageTitle = event.event_properties?.['[Amplitude] Page Title'] ?? document.title;

      // On the very first page view, ensure tracking starts cleanly from this moment
      if (counter === 1) resetTracking();

      return event;
    },

    teardown: async () => {
      clearInterval(tickTimer);
      activityEvents.forEach(name => {
        window.removeEventListener(name, onActivity);
      });
    },

    // ── Public API ───────────────────────────────────────────────────────────────

    getEngagedTimeMs:  () => Math.round(engagedTimeMs),
    getTotalTimeMs:    () => Math.round(Date.now() - pageEntryTime),
    isEngaged:         () => (Date.now() - lastActivityTime) < inactivityThreshold
                             && document.visibilityState === 'visible',
    getCurrentPage:    () => ({ url: currentPageUrl, title: currentPageTitle, counter: pageCounter }),

    // Expose fireSummaryEvent for demo simulate button (single-page session path)
    simulateExit: () => { hasFired = false; fireSummaryEvent(); },
  };
};
