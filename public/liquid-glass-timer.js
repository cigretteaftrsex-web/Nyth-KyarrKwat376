/**
 * liquid-glass-timer.js  v3.0
 * ══════════════════════════════════════════════════════════════════════
 *  Myanmar ကျားကွက် — Premium Liquid Glass 30-Second Turn Timer
 * ──────────────────────────────────────────────────────────────────────
 *  index.html ထဲ </body> မတိုင်မီ ဒီ line ထည့်ပါ —
 *    <script src="liquid-glass-timer.js" defer></script>
 *  liquid-glass-2.css ကို <head> ထဲ ထည့်ပြီးသား ဖြစ်ရမည်။
 * ══════════════════════════════════════════════════════════════════════
 */

(function () {
  'use strict';

  /* CONFIG */
  var TIMER_SECONDS  = 30;
  var WARN_AT        = 10;
  var DANGER_AT      = 5;
  var AUTO_RESIGN    = true;
  var BEEP_ON_WARN   = true;
  var BEEP_ON_DANGER = true;

  /* SVG geometry: r=19, circ=2*pi*19=119.38 */
  var RADIUS = 19;
  var CIRC   = 2 * Math.PI * RADIUS;

  /* STATE */
  var _remaining   = TIMER_SECONDS;
  var _interval    = null;
  var _isMyTurn    = false;
  var _warned      = false;
  var _dangered    = false;
  var _lastTurnVal = null;
  var _lastOver    = false;
  var _gameActive  = false;

  /* DOM refs */
  var _timerEl    = null;
  var _progressEl = null;
  var _numEl      = null;
  var _whoEl      = null;
  var _subEl      = null;

  /* ────────────────────────────────────────────────────────────────
     GAME GLOBALS ACCESSORS
     Game uses `let turn`, `let myColor`, `let over` — these are
     global `let` bindings (NOT window properties), but ARE accessible
     by name from any other script running in the same page.
  ──────────────────────────────────────────────────────────────── */
  function _getTurn()      { try { return (typeof turn          !== 'undefined') ? turn          : null;  } catch(e) { return null;  } }
  function _getMyColor()   { try { return (typeof myColor       !== 'undefined') ? myColor       : null;  } catch(e) { return null;  } }
  function _getOver()      { try { return (typeof over          !== 'undefined') ? !!over        : false; } catch(e) { return false; } }
  function _getSpectator() { try { return (typeof spectatorMode !== 'undefined') ? !!spectatorMode : false; } catch(e) { return false; } }

  /* ── AUDIO ───────────────────────────────────────────────────── */
  function _beep(freq, dur, vol) {
    try {
      var ac = window._SAC;
      if (!ac) { ac = new (window.AudioContext || window.webkitAudioContext)(); window._SAC = ac; }
      if (ac.state === 'suspended') ac.resume();
      var o = ac.createOscillator(), g = ac.createGain();
      o.connect(g); g.connect(ac.destination);
      o.type = 'sine'; o.frequency.value = freq;
      var t = ac.currentTime;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(vol || 0.18, t + 0.006);
      g.gain.exponentialRampToValueAtTime(0.0001, t + (dur || 0.10));
      o.start(t); o.stop(t + (dur || 0.12));
    } catch(e) {}
  }
  function _beepWarn()   { _beep(660,0.12,0.15); setTimeout(function(){ _beep(880,0.10,0.12); },100); }
  function _beepDanger() { _beep(440,0.14,0.22); setTimeout(function(){ _beep(330,0.12,0.18); },120); setTimeout(function(){ _beep(280,0.16,0.14); },240); }
  function _beepTick()   { _beep(1100,0.05,0.06); }

  /* ── BUILD TIMER ELEMENT ─────────────────────────────────────── */
  function _buildTimer() {
    var el = document.createElement('div');
    el.id = 'lg-timer'; el.className = 'lg-timer hidden';

    var ringWrap = document.createElement('div');
    ringWrap.className = 'lg-timer-ring';

    var NS = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(NS,'svg');
    svg.setAttribute('class','lg-timer-svg'); svg.setAttribute('viewBox','0 0 44 44');

    var track = document.createElementNS(NS,'circle');
    track.setAttribute('class','lg-timer-track');
    track.setAttribute('cx','22'); track.setAttribute('cy','22'); track.setAttribute('r',String(RADIUS));

    var progress = document.createElementNS(NS,'circle');
    progress.setAttribute('class','lg-timer-progress');
    progress.setAttribute('cx','22'); progress.setAttribute('cy','22'); progress.setAttribute('r',String(RADIUS));
    progress.style.strokeDasharray  = CIRC + 'px';
    progress.style.strokeDashoffset = '0px';

    svg.appendChild(track); svg.appendChild(progress);
    _progressEl = progress;

    var center = document.createElement('div');
    center.className = 'lg-timer-center';
    var numSpan = document.createElement('span');
    numSpan.className = 'lg-timer-num'; numSpan.textContent = String(TIMER_SECONDS);
    _numEl = numSpan;
    center.appendChild(numSpan);
    ringWrap.appendChild(svg); ringWrap.appendChild(center);

    var info = document.createElement('div');
    info.className = 'lg-timer-info';
    var who = document.createElement('span');
    who.className = 'lg-timer-who'; who.textContent = 'Turn Timer';
    _whoEl = who;
    var sub = document.createElement('span');
    sub.className = 'lg-timer-sub'; sub.textContent = '30s';
    _subEl = sub;
    info.appendChild(who); info.appendChild(sub);

    var dot = document.createElement('span');
    dot.className = 'lg-timer-dot';

    el.appendChild(dot); el.appendChild(ringWrap); el.appendChild(info);
    _timerEl = el;
    return el;
  }

  /* ── INJECT TIMER ────────────────────────────────────────────── */
  function _injectTimer() {
    if (document.getElementById('lg-timer')) return;
    var el = _buildTimer();
    var bframe = document.querySelector('.bframe');
    if (bframe && bframe.parentNode) {
      bframe.parentNode.insertBefore(el, bframe);
    } else {
      var center = document.querySelector('.center');
      if (center) center.appendChild(el);
      else document.body.appendChild(el);
    }
  }

  /* ── DISPLAY UPDATE ──────────────────────────────────────────── */
  function _updateDisplay(secs, isMyTurn, isOver) {
    if (!_timerEl) return;

    if (_progressEl) {
      _progressEl.style.strokeDashoffset = (CIRC * (1 - secs / TIMER_SECONDS)) + 'px';
    }
    if (_numEl) {
      var nv = String(secs);
      if (_numEl.textContent !== nv) {
        _numEl.classList.remove('tick');
        void _numEl.offsetWidth;
        _numEl.classList.add('tick');
        _numEl.textContent = nv;
      }
    }
    if (_subEl) _subEl.textContent = secs + 's';

    _timerEl.classList.remove('my-turn','opp-turn','warning','danger','game-over','hidden');

    if (isOver) {
      _timerEl.classList.add('game-over');
      if (_whoEl) _whoEl.textContent = 'ဂိမ်းပြီးဆုံးပြီ';
      return;
    }
    if (isMyTurn) {
      _timerEl.classList.add('my-turn');
      if      (secs <= DANGER_AT) { _timerEl.classList.add('danger');  if (_whoEl) _whoEl.textContent = '⚡ သင့်အလှည့်!'; }
      else if (secs <= WARN_AT)   { _timerEl.classList.add('warning'); if (_whoEl) _whoEl.textContent = '⚠️ မြန်မြန်ဆော့!'; }
      else                        {                                     if (_whoEl) _whoEl.textContent = '▶ သင့်အလှည့်'; }
    } else {
      _timerEl.classList.add('opp-turn');
      if (_whoEl) _whoEl.textContent = '⏳ ပြိုင်ဘက် အလှည့်';
    }
  }

  /* ── TIMER CONTROL ───────────────────────────────────────────── */
  function _stopInterval() {
    if (_interval) { clearInterval(_interval); _interval = null; }
  }

  function _startInterval() {
    _stopInterval();
    _interval = setInterval(function () {
      if (_remaining > 0) _remaining--;
      if (BEEP_ON_WARN   && _isMyTurn && _remaining === WARN_AT   && !_warned)   { _warned   = true; _beepWarn();   }
      if (BEEP_ON_DANGER && _isMyTurn && _remaining === DANGER_AT && !_dangered) { _dangered = true; _beepDanger(); }
      if (_isMyTurn && _remaining > 0 && _remaining <= DANGER_AT)               { _beepTick(); }
      _updateDisplay(_remaining, _isMyTurn, false);
      if (_remaining <= 0) { _stopInterval(); _onExpired(); }
    }, 1000);
  }

  function _resetTimer(isMyTurn) {
    _stopInterval();
    _remaining = TIMER_SECONDS; _warned = false; _dangered = false; _isMyTurn = isMyTurn;
    _updateDisplay(_remaining, isMyTurn, false);
    _startInterval();
  }

  /* ── TIMER EXPIRED ───────────────────────────────────────────── */
  function _onExpired() {
    if (!_timerEl) return;
    _timerEl.classList.add('danger');
    if (_isMyTurn && !_getSpectator() && AUTO_RESIGN) {
      setTimeout(function () {
        try {
          if (!_getOver() && typeof window.doResign === 'function') {
            var orig = window.confirm; window.confirm = function(){ return true; };
            window.doResign();
            window.confirm = orig;
          }
        } catch(e) {}
      }, 500);
    } else if (!_getSpectator()) {
      if (typeof window.toast === 'function') window.toast('⏰ ပြိုင်ဘက်တာပြည့်သွားပြီ');
    }
  }

  /* ── ON TURN CHANGE ──────────────────────────────────────────── */
  function _onTurnChange() {
    if (!_gameActive || !_timerEl) return;

    var currentTurn = _getTurn();
    var currentOver = _getOver();

    _timerEl.classList.remove('hidden');

    if (currentOver && !_lastOver) {
      _lastOver = true; _stopInterval();
      _timerEl.classList.remove('my-turn','opp-turn','warning','danger','hidden');
      _timerEl.classList.add('game-over');
      if (_whoEl) _whoEl.textContent = 'ဂိမ်းပြီးဆုံးပြီ';
      return;
    }
    if (!currentOver && _lastOver) {
      _lastOver = false; _lastTurnVal = null;
      _timerEl.classList.remove('game-over');
    }
    if (currentOver) return;

    if (currentTurn !== _lastTurnVal) {
      _lastTurnVal = currentTurn;
      var mc = _getMyColor();
      _resetTimer((mc !== null) && (currentTurn === mc));
    }
  }

  /* ── ENTER / LEAVE GAME ──────────────────────────────────────── */
  function _onEnterGame() {
    _gameActive = true; _lastTurnVal = null;
    if (_timerEl) _timerEl.classList.remove('hidden');
    _onTurnChange();
  }
  function _onLeaveGame() {
    _gameActive = false; _stopInterval(); _lastTurnVal = null; _lastOver = false;
    if (_timerEl) _timerEl.classList.add('hidden');
  }

  /* ────────────────────────────────────────────────────────────────
     HOOK GAME FUNCTIONS  ← PRIMARY mechanism
     ─────────────────────────────────────────────────────────────
     `function uiUpdate(){}` etc. are global function declarations,
     which means they ARE window.uiUpdate etc. (window IS the global
     object in a browser). Overriding window.xxx causes direct calls
     by name (uiUpdate()) to use our wrapper function.
  ──────────────────────────────────────────────────────────────── */
  function _hookGameFunctions() {
    if (typeof window.uiUpdate === 'function' && !window._lgUiHooked) {
      window._lgUiHooked = true;
      var _origUi = window.uiUpdate;
      window.uiUpdate = function () { _origUi.apply(this, arguments); _onTurnChange(); };
    }
    if (typeof window.showGame === 'function' && !window._lgShowHooked) {
      window._lgShowHooked = true;
      var _origShow = window.showGame;
      window.showGame = function () { _origShow.apply(this, arguments); _onEnterGame(); };
    }
    if (typeof window.showScr === 'function' && !window._lgScrHooked) {
      window._lgScrHooked = true;
      var _origScr = window.showScr;
      window.showScr = function (id) { _origScr.apply(this, arguments); if (id !== 'game') _onLeaveGame(); };
    }
  }

  /* ── BACKUP: MutationObservers ───────────────────────────────── */
  function _attachObservers() {
    var gameEl = document.getElementById('game');
    if (gameEl) {
      new MutationObserver(function () {
        var showing = gameEl.classList.contains('show');
        if (showing && !_gameActive)  _onEnterGame();
        else if (!showing && _gameActive) _onLeaveGame();
      }).observe(gameEl, { attributes:true, attributeFilter:['class'] });
    }
    var myBarEl = document.getElementById('my-bar');
    if (myBarEl) {
      new MutationObserver(function () {
        if (_gameActive) _onTurnChange();
      }).observe(myBarEl, { attributes:true, attributeFilter:['class'] });
    }
    var winoEl = document.getElementById('wino');
    if (winoEl) {
      new MutationObserver(function () {
        if (_gameActive) _onTurnChange();
      }).observe(winoEl, { attributes:true, attributeFilter:['class'] });
    }
  }

  /* ── INIT ────────────────────────────────────────────────────── */
  function _init() {
    _injectTimer();
    _hookGameFunctions();
    _attachObservers();

    /* Handle page refresh while already in game */
    var gameEl = document.getElementById('game');
    if (gameEl && gameEl.classList.contains('show')) _onEnterGame();

    /* Safety poll every 2s */
    setInterval(function () {
      var ge = document.getElementById('game');
      if (!ge) return;
      if (ge.classList.contains('show') && !_gameActive) {
        _onEnterGame();
      } else if (ge.classList.contains('show') && _gameActive && !_interval && !_getOver()) {
        _lastTurnVal = null;
        _onTurnChange();
      }
    }, 2000);
  }

  /* ── BOOT ────────────────────────────────────────────────────── */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _init);
  } else {
    _init();
  }

})();
