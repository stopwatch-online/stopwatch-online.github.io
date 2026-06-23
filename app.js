/* ============================================================================
 * Online Stopwatch — multi-event client-side stopwatch
 * ----------------------------------------------------------------------------
 * 100% in-browser. No network calls, no tracking. State persists to
 * localStorage and keeps counting across refreshes. Never throws uncaught.
 * ========================================================================== */
(function () {
  "use strict";

  var mount = document.getElementById("tool");
  if (!mount) return;

  var STORAGE_KEY = "stopwatch-online.events.v1";

  /* --- timing helpers ----------------------------------------------------- */

  // Monotonic clock for live timing; falls back to Date.now if unavailable.
  function nowMono() {
    try {
      if (window.performance && typeof performance.now === "function") {
        return performance.now();
      }
    } catch (e) {}
    return Date.now();
  }

  // Elapsed milliseconds for an event, including the active run if running.
  function elapsedOf(ev) {
    var ms = ev.accumulatedMs;
    if (ev.running) ms += nowMono() - ev.startedAt;
    return ms < 0 ? 0 : ms;
  }

  // Format ms as [HH:]MM:SS.cc — hours omitted under one hour, always centis.
  function formatMs(ms) {
    if (!isFinite(ms) || ms < 0) ms = 0;
    var totalCs = Math.floor(ms / 10); // centiseconds
    var cs = totalCs % 100;
    var totalSec = Math.floor(totalCs / 100);
    var s = totalSec % 60;
    var totalMin = Math.floor(totalSec / 60);
    var m = totalMin % 60;
    var h = Math.floor(totalMin / 60);
    function pad2(n) { return n < 10 ? "0" + n : "" + n; }
    var out = pad2(m) + ":" + pad2(s) + "." + pad2(cs);
    if (h > 0) out = pad2(h) + ":" + out;
    return out;
  }

  /* --- state -------------------------------------------------------------- */

  var events = [];        // array of {id, name, running, startedAt, accumulatedMs, laps:[ms,...]}
  var nodes = {};         // id -> {timeEl, startBtn, lapBtn, removeBtn, lapList, nameInput, lane}
  var idSeq = 1;

  function nextId() { return "ev" + (idSeq++); }

  function defaultName() { return "Event " + events.length; }

  function makeEvent(name) {
    return {
      id: nextId(),
      name: name,
      running: false,
      startedAt: 0,
      accumulatedMs: 0,
      laps: []
    };
  }

  /* --- persistence -------------------------------------------------------- */

  function save() {
    try {
      var wall = Date.now();
      var data = {
        seq: idSeq,
        events: events.map(function (ev) {
          // Anchor running events to wall-clock so a refresh keeps counting.
          var startEpoch = ev.running ? wall - (nowMono() - ev.startedAt) : 0;
          return {
            name: ev.name,
            running: ev.running,
            accumulatedMs: ev.accumulatedMs,
            startEpoch: startEpoch,
            laps: ev.laps.slice()
          };
        })
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch (e) { /* storage may be unavailable/full — ignore */ }
  }

  function load() {
    var raw;
    try { raw = localStorage.getItem(STORAGE_KEY); } catch (e) { raw = null; }
    if (!raw) return false;
    var data;
    try { data = JSON.parse(raw); } catch (e) { return false; }
    if (!data || !Array.isArray(data.events) || data.events.length === 0) return false;

    var wall = Date.now();
    events = data.events.map(function (s) {
      var ev = makeEvent(typeof s.name === "string" ? s.name : "Event");
      ev.accumulatedMs = (typeof s.accumulatedMs === "number" && isFinite(s.accumulatedMs)) ? s.accumulatedMs : 0;
      ev.laps = Array.isArray(s.laps) ? s.laps.filter(function (n) { return typeof n === "number" && isFinite(n); }) : [];
      if (s.running) {
        // Continue counting: fold elapsed-since-saved into accumulated.
        var sinceSaved = (typeof s.startEpoch === "number") ? (wall - s.startEpoch) : 0;
        if (!isFinite(sinceSaved) || sinceSaved < 0) sinceSaved = 0;
        ev.accumulatedMs += sinceSaved;
        ev.startedAt = nowMono();
        ev.running = true;
      }
      return ev;
    });
    if (typeof data.seq === "number" && data.seq > idSeq) idSeq = data.seq;
    return true;
  }

  /* --- DOM build ---------------------------------------------------------- */

  function el(tag, opts) {
    var node = document.createElement(tag);
    if (opts) {
      if (opts.className) node.className = opts.className;
      if (opts.text != null) node.textContent = opts.text;
      if (opts.html != null) node.innerHTML = opts.html;
      if (opts.attrs) for (var k in opts.attrs) node.setAttribute(k, opts.attrs[k]);
    }
    return node;
  }

  var lanesWrap, globalBar;

  function buildShell() {
    mount.innerHTML = "";

    globalBar = el("div", { className: "controls", attrs: { role: "group", "aria-label": "Global stopwatch controls" } });
    var addBtn = el("button", { text: "Add event" });
    var startAll = el("button", { className: "secondary", text: "Start all" });
    var stopAll = el("button", { className: "secondary", text: "Stop all" });
    var resetAll = el("button", { className: "secondary", text: "Reset all" });

    addBtn.addEventListener("click", function () { addEvent(); });
    startAll.addEventListener("click", function () {
      events.forEach(function (ev) { startEvent(ev); });
      save();
    });
    stopAll.addEventListener("click", function () {
      events.forEach(function (ev) { pauseEvent(ev); });
      save();
    });
    resetAll.addEventListener("click", function () {
      events.forEach(function (ev) { resetEvent(ev); });
      save();
    });

    globalBar.appendChild(addBtn);
    globalBar.appendChild(startAll);
    globalBar.appendChild(stopAll);
    globalBar.appendChild(resetAll);

    lanesWrap = el("div", { className: "sw-lanes" });

    mount.appendChild(globalBar);
    mount.appendChild(lanesWrap);
  }

  function buildLane(ev) {
    var lane = el("div", { className: "sw-lane" });

    // Header row: name + time
    var head = el("div", { className: "sw-lane-head" });

    var nameId = "name-" + ev.id;
    var nameLabel = el("label", { className: "sw-name-label", text: "Event name", attrs: { "for": nameId } });
    var nameInput = el("input", { attrs: { type: "text", id: nameId, value: "", "aria-label": "Event name" } });
    nameInput.value = ev.name;
    nameInput.addEventListener("input", function () {
      ev.name = nameInput.value;
      save();
    });

    var timeEl = el("div", {
      className: "sw-time",
      attrs: { "aria-live": "off", role: "timer", "aria-label": "Elapsed time" }
    });

    head.appendChild(nameLabel);
    head.appendChild(nameInput);
    head.appendChild(timeEl);

    // Controls
    var ctrls = el("div", { className: "controls sw-lane-controls" });
    var startBtn = el("button", { text: "Start" });
    var lapBtn = el("button", { className: "secondary", text: "Lap" });
    var resetBtn = el("button", { className: "secondary", text: "Reset" });
    var removeBtn = el("button", { className: "secondary", text: "Remove" });

    startBtn.addEventListener("click", function () { toggleEvent(ev); save(); });
    lapBtn.addEventListener("click", function () { lapEvent(ev); save(); });
    resetBtn.addEventListener("click", function () { resetEvent(ev); save(); });
    removeBtn.addEventListener("click", function () { removeEvent(ev); });

    ctrls.appendChild(startBtn);
    ctrls.appendChild(lapBtn);
    ctrls.appendChild(resetBtn);
    ctrls.appendChild(removeBtn);

    // Lap list
    var lapList = el("ol", { className: "sw-laps", attrs: { "aria-label": "Lap times" } });

    lane.appendChild(head);
    lane.appendChild(ctrls);
    lane.appendChild(lapList);

    nodes[ev.id] = {
      lane: lane,
      nameInput: nameInput,
      timeEl: timeEl,
      startBtn: startBtn,
      lapBtn: lapBtn,
      resetBtn: resetBtn,
      removeBtn: removeBtn,
      lapList: lapList
    };

    return lane;
  }

  function renderLanes() {
    lanesWrap.innerHTML = "";
    nodes = {};
    events.forEach(function (ev) {
      lanesWrap.appendChild(buildLane(ev));
      renderLaps(ev);
      syncLaneControls(ev);
      updateLaneTime(ev);
    });
  }

  function renderLaps(ev) {
    var n = nodes[ev.id];
    if (!n) return;
    var list = n.lapList;
    list.innerHTML = "";
    // Most recent on top.
    for (var i = ev.laps.length - 1; i >= 0; i--) {
      var cumulative = ev.laps[i];
      var prev = i > 0 ? ev.laps[i - 1] : 0;
      var delta = cumulative - prev;
      var li = el("li", { className: "sw-lap" });
      var num = el("span", { className: "sw-lap-num", text: "Lap " + (i + 1) });
      var cum = el("span", { className: "sw-lap-cum", text: formatMs(cumulative) });
      var del = el("span", { className: "sw-lap-delta", text: "+" + formatMs(delta) });
      li.appendChild(num);
      li.appendChild(cum);
      li.appendChild(del);
      list.appendChild(li);
    }
  }

  // Enable/disable + label buttons for an event's current state.
  function syncLaneControls(ev) {
    var n = nodes[ev.id];
    if (!n) return;
    n.startBtn.textContent = ev.running ? "Pause" : "Start";
    n.lapBtn.disabled = !ev.running;
    var onlyOne = events.length <= 1;
    n.removeBtn.disabled = onlyOne;
    n.removeBtn.style.display = onlyOne ? "none" : "";
  }

  function updateLaneTime(ev) {
    var n = nodes[ev.id];
    if (!n) return;
    n.timeEl.textContent = formatMs(elapsedOf(ev));
  }

  /* --- actions ------------------------------------------------------------ */

  function startEvent(ev) {
    if (ev.running) return;
    ev.startedAt = nowMono();
    ev.running = true;
    syncLaneControls(ev);
  }

  function pauseEvent(ev) {
    if (!ev.running) return;
    ev.accumulatedMs += nowMono() - ev.startedAt;
    ev.running = false;
    syncLaneControls(ev);
    updateLaneTime(ev);
  }

  function toggleEvent(ev) {
    if (ev.running) pauseEvent(ev);
    else startEvent(ev);
  }

  function resetEvent(ev) {
    ev.running = false;
    ev.startedAt = 0;
    ev.accumulatedMs = 0;
    ev.laps = [];
    syncLaneControls(ev);
    renderLaps(ev);
    updateLaneTime(ev);
  }

  function lapEvent(ev) {
    if (!ev.running) return;
    ev.laps.push(elapsedOf(ev));
    renderLaps(ev);
  }

  function addEvent() {
    var ev = makeEvent("Event " + (events.length + 1));
    events.push(ev);
    lanesWrap.appendChild(buildLane(ev));
    renderLaps(ev);
    updateLaneTime(ev);
    // Removing-button visibility depends on count → refresh all lanes.
    events.forEach(syncLaneControls);
    save();
  }

  function removeEvent(ev) {
    if (events.length <= 1) return;
    var idx = events.indexOf(ev);
    if (idx === -1) return;
    events.splice(idx, 1);
    var n = nodes[ev.id];
    if (n && n.lane.parentNode) n.lane.parentNode.removeChild(n.lane);
    delete nodes[ev.id];
    events.forEach(syncLaneControls);
    save();
  }

  /* --- shared animation loop --------------------------------------------- */

  function tick() {
    for (var i = 0; i < events.length; i++) {
      if (events[i].running) updateLaneTime(events[i]);
    }
    requestFrame(tick);
  }

  function requestFrame(fn) {
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(fn);
    else setTimeout(fn, 1000 / 30);
  }

  /* --- keyboard ----------------------------------------------------------- */

  function isTyping(target) {
    if (!target) return false;
    var tag = target.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable;
  }

  function onKeyDown(e) {
    if (e.code !== "Space" && e.key !== " " && e.key !== "Spacebar") return;
    if (isTyping(e.target)) return;
    if (events.length === 0) return;
    e.preventDefault();
    toggleEvent(events[0]);
    save();
  }

  /* --- styles (small, scoped) -------------------------------------------- */

  function injectStyles() {
    if (document.getElementById("sw-styles")) return;
    var css =
      ".sw-lanes{display:flex;flex-direction:column;gap:16px;margin-top:8px;}" +
      ".sw-lane{border:1px solid var(--border);border-radius:var(--radius);background:var(--bg);padding:14px;}" +
      ".sw-lane-head{display:flex;align-items:center;gap:12px;flex-wrap:wrap;}" +
      ".sw-name-label{position:absolute;left:-9999px;}" +
      ".sw-lane-head input{flex:1 1 160px;min-width:120px;max-width:280px;font-weight:600;}" +
      ".sw-time{flex:1 1 auto;text-align:right;font-family:ui-monospace,'Cascadia Code',Consolas,monospace;" +
      "font-size:2.1rem;font-variant-numeric:tabular-nums;letter-spacing:.02em;min-width:9ch;}" +
      ".sw-lane-controls{margin:12px 0 0;}" +
      ".sw-laps{list-style:none;margin:10px 0 0;padding:0;}" +
      ".sw-laps:empty{display:none;}" +
      ".sw-lap{display:flex;justify-content:space-between;gap:10px;padding:5px 2px;" +
      "border-top:1px solid var(--border);font-family:ui-monospace,Consolas,monospace;font-size:.9rem;}" +
      ".sw-lap-num{color:var(--muted);}" +
      ".sw-lap-delta{color:var(--accent);}" +
      "@media(max-width:480px){.sw-time{font-size:1.7rem;text-align:left;width:100%;}}";
    var style = el("style", { attrs: { id: "sw-styles" } });
    style.textContent = css;
    document.head.appendChild(style);
  }

  /* --- init --------------------------------------------------------------- */

  function init() {
    try {
      injectStyles();
      if (!load()) {
        events = [makeEvent("Event 1")];
      }
      buildShell();
      renderLanes();
      document.addEventListener("keydown", onKeyDown);
      window.addEventListener("beforeunload", save);
      // Persist running clocks periodically so a crash/close keeps recent time.
      setInterval(function () {
        for (var i = 0; i < events.length; i++) { if (events[i].running) { save(); break; } }
      }, 5000);
      requestFrame(tick);
    } catch (err) {
      try {
        mount.innerHTML = "";
        var div = el("div", { className: "error", text: "Sorry — the stopwatch failed to start in this browser." });
        mount.appendChild(div);
      } catch (e2) {}
    }
  }

  init();
})();
