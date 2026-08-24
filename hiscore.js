/*! HISCORE-VIDEO kit: optional companion package to the HISCORE protocol.
    Spec of this package:  https://gamesareeatingtheworld.com/hiscore-video.txt
    The protocol itself:   https://gamesareeatingtheworld.com/hiscore.txt (plain HTTP, needs no script)
    This kit = protocol client + tape + share card:
      <script src="https://gamesareeatingtheworld.com/hiscore.js" data-key="YOUR_ID"></script>
      HISCORE.start() when a run begins, GS.submit(score) when it ends.
    Versions move in lockstep with the protocol (HISCORE-VIDEO/1.4 pairs with HISCORE/1.4).
    No arcade account. Identity is GS.connect(). A score without a clip is valid. */
(function () {
  'use strict';
  if (window.__HISCORE_KIT) return;
  /* The arcade has its own hiscore.js (login, ghost audio). Two cards on
     play.mcgrinsey.com would be the Hypeout mistake all over again. */
  if (location.hostname === 'play.mcgrinsey.com') return;
  window.__HISCORE_KIT = true;

  var me = document.currentScript;
  var KEY = (me && me.dataset && me.dataset.key) || '';
  var BASE = (function () {
    try { return new URL(me.src).origin; } catch (e) { return 'https://gamesareeatingtheworld.com'; }
  })();
  var VER = (me && me.dataset && me.dataset.version) || '';
  var DE = (function () {
    try { if (window.Arcade && Arcade.language) return Arcade.language() === 'de'; } catch (e) {}
    return (navigator.language || '').toLowerCase().indexOf('de') === 0;
  })();

  function bootGs(next) {
    if (window.GS) { next(); return; }
    var s = document.createElement('script');
    s.src = BASE + '/gs.js';
    if (KEY) s.setAttribute('data-key', KEY);
    if (VER) s.setAttribute('data-version', VER);
    if (me && me.dataset && me.dataset.store) s.setAttribute('data-store', me.dataset.store);
    s.onload = next;
    (me && me.parentNode ? me.parentNode : document.head).appendChild(s);
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  /* ---- Recorder: canvas, optional camera, never auto-mic/cam -------------- */
  var rec = null, chunks = [], stream = null, lastBlob = null, lastUrl = null;
  var comp = null, ctx = null, raf = 0, camStream = null, camVideo = null;
  var wantCam = false, recOn = false, usedComp = false, orb = null, menu = null, hostCard = null;
  var wrapped = false, webaudioTaps = [], mixCtx = null, mixKeep = [], ticker = null;

  function canvas() {
    return document.getElementById('view')
      || document.getElementById('game')
      || document.querySelector('canvas');
  }

  function tapWebAudio() {
    try {
      var P = window.AudioNode && window.AudioNode.prototype;
      if (!P || P.__hsTap) return;
      var orig = P.connect;
      if (typeof orig !== 'function') return;
      P.connect = function (dest) {
        var ret = orig.apply(this, arguments);
        try {
          var ac = this.context;
          if (ac && dest === ac.destination) {
            if (!ac.__hsDest) {
              ac.__hsDest = ac.createMediaStreamDestination();
              webaudioTaps.push(ac.__hsDest);
            }
            orig.call(this, ac.__hsDest);
          }
        } catch (e) {}
        return ret;
      };
      P.__hsTap = true;
    } catch (e2) {}
  }
  tapWebAudio();

  function collectAudio() {
    var out = [], seen = {};
    function add(s) {
      if (!s) return;
      try {
        s.getAudioTracks().forEach(function (t) {
          if (!t || !t.enabled || t.readyState === 'ended' || seen[t.id]) return;
          seen[t.id] = true;
          out.push(t);
        });
      } catch (e) {}
    }
    for (var i = 0; i < webaudioTaps.length; i++) add(webaudioTaps[i].stream);
    try {
      var nodes = document.querySelectorAll('audio, video');
      for (var j = 0; j < nodes.length; j++) {
        var el = nodes[j];
        if (el === camVideo || el.paused || el.muted) continue;
        if (typeof el.captureStream === 'function') {
          try { add(el.captureStream()); } catch (e3) {}
        }
      }
    } catch (e4) {}
    return out;
  }

  function mixTracks(tracks) {
    mixKeep = [];
    if (!tracks.length) return [];
    if (tracks.length === 1) return tracks.slice();
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return tracks.slice(0, 1);
    try {
      if (!mixCtx) mixCtx = new AC();
      if (mixCtx.state === 'suspended') mixCtx.resume();
      var dest = mixCtx.createMediaStreamDestination();
      mixKeep.push(dest);
      for (var i = 0; i < tracks.length; i++) {
        var src = mixCtx.createMediaStreamSource(new MediaStream([tracks[i]]));
        src.connect(dest);
        mixKeep.push(src);
      }
      return dest.stream.getAudioTracks();
    } catch (e) { return tracks.slice(0, 1); }
  }

  function boxTag(u, i) {
    return String.fromCharCode(u[i + 4], u[i + 5], u[i + 6], u[i + 7]);
  }
  function mp4InitFirst(u8) {
    var boxes = [], pos = 0;
    while (pos + 8 <= u8.length) {
      var sz = (u8[pos] << 24) | (u8[pos + 1] << 16) | (u8[pos + 2] << 8) | u8[pos + 3];
      if (sz < 8 || pos + sz > u8.length) return u8;
      boxes.push(u8.subarray(pos, pos + sz));
      pos += sz;
    }
    if (pos !== u8.length) return u8;
    var head = [], rest = [], i;
    for (i = 0; i < boxes.length; i++) {
      var tag = boxTag(boxes[i], 0);
      if (tag === 'ftyp' || tag === 'moov') head.push(boxes[i]);
      else rest.push(boxes[i]);
    }
    if (!head.length || boxTag(boxes[0], 0) === 'ftyp') return u8;
    var out = new Uint8Array(u8.length), o = 0;
    for (i = 0; i < head.length; i++) { out.set(head[i], o); o += head[i].length; }
    for (i = 0; i < rest.length; i++) { out.set(rest[i], o); o += rest[i].length; }
    return out;
  }

  function packBlob(cb) {
    if (!chunks.length) { cb(null); return; }
    var type = (chunks[0] && chunks[0].type) || 'video/webm';
    var blob;
    try { blob = new Blob(chunks, { type: type }); } catch (e) { cb(null); return; }
    if (!/mp4/i.test(type) || !blob.arrayBuffer) { cb(blob); return; }
    blob.arrayBuffer().then(function (ab) {
      cb(new Blob([mp4InitFirst(new Uint8Array(ab))], { type: blob.type || 'video/mp4' }));
    }).catch(function () { cb(blob); });
  }

  function mime(withAudio) {
    var opts = withAudio
      ? ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp8,opus', 'video/webm']
      : ['video/mp4;codecs=avc1.42E01E', 'video/mp4', 'video/webm;codecs=vp8', 'video/webm'];
    if (!window.MediaRecorder) return '';
    for (var i = 0; i < opts.length; i++) {
      try { if (MediaRecorder.isTypeSupported(opts[i])) return opts[i]; } catch (e) {}
    }
    return '';
  }

  function buildComp(src) {
    if (!comp) { comp = document.createElement('canvas'); ctx = comp.getContext('2d'); }
    var w = src.width || src.clientWidth || 640;
    var h = src.height || src.clientHeight || 360;
    var max = 960;
    if (Math.max(w, h) > max) {
      var s = max / Math.max(w, h);
      w = Math.round(w * s); h = Math.round(h * s);
    }
    if (comp.width !== w || comp.height !== h) { comp.width = w; comp.height = h; }
    return comp;
  }

  function draw() {
    if (!ctx || !comp) return;
    var src = canvas();
    var w = comp.width, h = comp.height;
    ctx.fillStyle = '#0a0806';
    ctx.fillRect(0, 0, w, h);
    if (src) { try { ctx.drawImage(src, 0, 0, w, h); } catch (e) {} }
    if (wantCam && camVideo && (camVideo.readyState >= 2 || camVideo.videoWidth)) {
      var pw = Math.min(w, h) * 0.18, ph = pw * 16 / 9;
      var px = w * 0.03, py = h - ph - h * 0.04;
      ctx.save();
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(px, py, pw, ph, 8); else ctx.rect(px, py, pw, ph);
      ctx.clip();
      try { ctx.drawImage(camVideo, px, py, pw, ph); } catch (e2) {}
      ctx.restore();
      ctx.strokeStyle = 'rgba(255,210,60,0.9)';
      ctx.lineWidth = 2;
      ctx.strokeRect(px, py, pw, ph);
    }
    ctx.font = '600 14px Poppins,"IBM Plex Sans",sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'bottom';
    ctx.fillStyle = 'rgba(255,210,60,0.92)';
    ctx.fillText('gamesareeatingtheworld.com', w - 10, h - 8);
  }

  function loop() {
    draw();
    if (rec && rec.state === 'recording') raf = requestAnimationFrame(loop);
  }

  function camOn(next) {
    if (camStream) { if (next) next(true); return; }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { if (next) next(false); return; }
    navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 320 } }, audio: false })
      .then(function (s) {
        camStream = s;
        if (!camVideo) {
          camVideo = document.createElement('video');
          camVideo.muted = true;
          camVideo.playsInline = true;
          camVideo.setAttribute('playsinline', '');
          camVideo.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0;pointer-events:none';
          document.body.appendChild(camVideo);
        }
        camVideo.srcObject = s;
        camVideo.play().catch(function () {});
        if (next) next(true);
      })
      .catch(function () { if (next) next(false); });
  }

  function recStart() {
    recStop(true);
    lastBlob = null;
    if (lastUrl) { try { URL.revokeObjectURL(lastUrl); } catch (e) {} lastUrl = null; }
    var c = canvas();
    if (!c || !window.MediaRecorder) { recOn = false; orbState(); return false; }
    var audio = mixTracks(collectAudio());
    var withAudio = audio.length > 0;
    var type = mime(withAudio);
    usedComp = !!(wantCam || !c.captureStream);
    try {
      var vis;
      if (usedComp) {
        buildComp(c);
        draw();
        vis = comp.captureStream(30);
      } else {
        vis = c.captureStream(30);
      }
      var tracks = vis.getVideoTracks().slice();
      if (withAudio) tracks = tracks.concat(audio);
      stream = new MediaStream(tracks);
      rec = type ? new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: 1400000 })
                 : new MediaRecorder(stream);
    } catch (e) { rec = null; return false; }
    chunks = [];
    rec.ondataavailable = function (ev) { if (ev.data && ev.data.size) chunks.push(ev.data); };
    try { rec.start(1000); } catch (e2) { rec = null; return false; }
    recOn = true;
    if (usedComp) raf = requestAnimationFrame(loop);
    if (ticker) clearInterval(ticker);
    ticker = setInterval(function () {
      try { if (rec && rec.state === 'recording' && rec.requestData) rec.requestData(); } catch (e3) {}
    }, 1000);
    orbState();
    return true;
  }

  function recStop(quiet, next) {
    if (ticker) { clearInterval(ticker); ticker = null; }
    var finish = function () {
      if (raf) { cancelAnimationFrame(raf); raf = 0; }
      /* ⚠️ captureStream on the game canvas: do not stop those tracks,
         or the game picture freezes in some browsers. */
      if (stream && usedComp) {
        try { stream.getVideoTracks().forEach(function (t) { t.stop(); }); } catch (e) {}
      }
      stream = null;
      var done = function () {
        chunks = [];
        rec = null;
        recOn = false;
        orbState();
        if (next) { var f = next; next = null; f(); }
      };
      if (!quiet) {
        packBlob(function (blob) {
          lastBlob = blob && blob.size > 800 ? blob : null;
          if (lastUrl) { try { URL.revokeObjectURL(lastUrl); } catch (e2) {} lastUrl = null; }
          if (lastBlob) {
            try { lastUrl = URL.createObjectURL(lastBlob); } catch (e3) { lastUrl = null; }
          }
          done();
        });
      } else done();
    };
    if (!rec || !rec.state || rec.state === 'inactive') { finish(); return; }
    var r = rec;
    var to = setTimeout(finish, 900);
    r.onstop = function () { clearTimeout(to); finish(); };
    try { if (r.requestData) r.requestData(); r.stop(); } catch (e) { clearTimeout(to); finish(); }
  }

  /* ---- REC orb ------------------------------------------------------------- */
  function orbState() {
    if (!orb) return;
    orb.setAttribute('data-on', recOn ? '1' : '0');
    orb.style.background = recOn ? '#5a1010' : '#10141d';
    orb.style.borderColor = recOn ? '#ff5f5f' : '#ffd23c';
    orb.style.color = recOn ? '#ffb0b0' : '#ffd23c';
    orb.title = recOn ? (DE ? 'Aufnahme läuft' : 'Recording') : (DE ? 'HISCORE aufnehmen' : 'Record HISCORE');
  }

  function orbBuild() {
    if (orb) return;
    var arcade = !!document.getElementById('arcade-orb-btn');
    var wrap = document.createElement('div');
    wrap.style.cssText = 'position:fixed;left:' + (arcade ? '128px' : '12px') +
      ';top:12px;z-index:2147483645;font-family:Poppins,"IBM Plex Sans",sans-serif';
    orb = document.createElement('button');
    orb.type = 'button';
    orb.textContent = 'REC';
    orb.style.cssText = 'width:46px;height:46px;border-radius:50%;border:2px solid #ffd23c;background:#10141d;color:#ffd23c;font:700 11px Poppins,sans-serif;letter-spacing:.08em;cursor:pointer';
    orb.onclick = function () {
      if (recOn) recStop(false);
      else recStart();
    };
    menu = document.createElement('div');
    menu.hidden = true;
    menu.style.cssText = 'margin-top:8px;background:rgba(18,21,28,.97);border:1px solid #ffd23c55;border-radius:12px;padding:8px 10px;min-width:160px;color:#f4f1e6;font-size:13px';
    menu.innerHTML = '<label style="display:flex;gap:8px;align-items:center;cursor:pointer">' +
      '<input type="checkbox" class="hs-cam"> ' + (DE ? 'Kamera ins Bild' : 'Camera in the clip') + '</label>' +
      '<p style="margin:8px 0 0;font-size:11px;color:#8a7a58">' +
      (DE ? 'Canvas immer. Kamera nur nach diesem Haken.' : 'Canvas always. Camera only after this check.') + '</p>';
    var camBox = menu.querySelector('.hs-cam');
    camBox.onchange = function () {
      wantCam = !!camBox.checked;
      if (wantCam) camOn(function (ok) { if (!ok) { camBox.checked = false; wantCam = false; } });
      else if (camStream) {
        try { camStream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {}
        camStream = null;
      }
    };
    wrap.appendChild(orb);
    wrap.appendChild(menu);
    wrap.onmouseenter = function () { menu.hidden = false; };
    wrap.onmouseleave = function () { menu.hidden = true; };
    document.body.appendChild(wrap);
    orbState();
  }

  /* ---- Share card ---------------------------------------------------------- */
  function xhrForm(url, fd, onProgress, next) {
    var x = new XMLHttpRequest();
    x.open('POST', url);
    x.upload.onprogress = function (ev) {
      if (!onProgress) return;
      if (ev.lengthComputable && ev.total > 0) {
        onProgress(Math.max(1, Math.min(99, Math.round(100 * ev.loaded / ev.total))));
      } else onProgress(null);
    };
    x.onload = function () {
      var j = null;
      try { j = JSON.parse(x.responseText || '{}'); } catch (e) {}
      var ok = x.status >= 200 && x.status < 300 && !!(j && j.ok);
      if (ok && onProgress) onProgress(100);
      if (next) next(ok, j);
    };
    x.onerror = function () { if (next) next(false); };
    x.send(fd);
  }

  function barShow(root, pct, text) {
    var box = root.querySelector('.bar');
    if (!box) return;
    box.classList.add('on');
    box.classList.toggle('wait', pct == null);
    var fill = box.querySelector('.fill');
    var lab = box.querySelector('.pct');
    if (fill && pct != null) fill.style.width = pct + '%';
    if (lab) lab.textContent = text || (pct != null ? pct + '%' : '');
  }

  function barText(pct, done, failed) {
    if (failed) return DE ? 'Senden fehlgeschlagen' : 'Send failed';
    if (done || pct === 100) return DE ? 'Oben. 100%' : 'Up. 100%';
    if (pct == null) return DE ? 'Lädt hoch…' : 'Uploading…';
    if (pct >= 99) return DE ? 'Speichere…' : 'Saving…';
    return (DE ? 'Lädt hoch… ' : 'Uploading… ') + pct + '%';
  }

  function card(d, score, name) {
    try { if (hostCard && hostCard.isConnected) hostCard.remove(); } catch (e) {}
    var host = document.createElement('div');
    host.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483646;';
    hostCard = host;
    var r = host.attachShadow({ mode: 'open' });
    var board = (d && d.share) || (BASE + '/board/' + encodeURIComponent((window.GS && GS.key) || KEY));
    var rank = d && d.rank;
    var total = d && d.total;
    var placeText;
    if (typeof rank === 'number' && rank > 0) {
      var ofTotal = (typeof total === 'number' && total > 0)
        ? (DE ? ' von ' + total : ' of ' + total) : '';
      placeText = (DE ? 'Platz <b>' + rank + '</b>' : 'Rank <b>' + rank + '</b>') + ofTotal;
    } else {
      placeText = DE ? 'Dein Lauf ist drin' : 'Your run is in';
    }
    var t1 = (typeof rank === 'number' && rank > 0 && rank <= 3)
      ? (DE ? 'Dein Highscore steht in der Weltrangliste.' : 'Your highscore is on the world ranking.')
      : (DE ? 'Dein Lauf steht in der Weltrangliste.' : 'Your run is on the world ranking.');
    var has = !!(lastBlob && lastUrl);
    r.innerHTML =
      '<style>' +
      ':host{all:initial}' +
      '.k{font-family:Poppins,"IBM Plex Sans",sans-serif;background:linear-gradient(180deg,#16100a,#0c0a08);' +
      'color:#f4f1e6;border:2px solid #ffd23c;padding:16px;max-width:320px;border-radius:16px;position:relative}' +
      '.t{font-size:10px;letter-spacing:.16em;text-transform:uppercase;color:#ffd23c;margin-bottom:8px}' +
      '.lead{font-size:13px;line-height:1.35;margin:0 0 10px;color:#c9b48a}' +
      '.rank{font-size:16px;margin:0 0 4px;color:#ffe566;font-weight:600}' +
      '.rank b{font-size:28px;font-weight:800}' +
      '.gold{font-weight:800;font-style:italic;font-size:26px;margin:2px 0 0;color:#ffd23c}' +
      '.sc{font-family:"IBM Plex Mono",ui-monospace,monospace;font-style:normal;font-size:22px;margin:6px 0 10px}' +
      'video{width:100%;border-radius:10px;margin:8px 0;background:#000;max-height:140px}' +
      '.s,.post,a.see{display:block;width:100%;margin:0 0 8px;text-align:center;box-sizing:border-box;' +
      'border-radius:999px;font:inherit;font-weight:700;font-size:12px;padding:9px 12px;text-decoration:none;cursor:pointer}' +
      '.s{border:0;background:#ffd23c;color:#1a1408}' +
      '.post{border:1px solid #ffd23c;background:transparent;color:#ffd23c}' +
      'a.see{border:0;background:#ffd23c;color:#1a1408}' +
      '.x{position:absolute;top:8px;right:10px;background:none;border:0;color:#8a7a58;font-size:18px;cursor:pointer}' +
      '.hint{font-size:11px;color:#8a7a58;margin:0 0 8px}' +
      '.v{display:block;margin-top:10px;padding-top:8px;border-top:1px solid #3a3020;font-size:11px;color:#8a7a58}' +
      '.v button{background:none;border:0;padding:0;color:#ffd23c;font:inherit;text-decoration:underline;cursor:pointer}' +
      '.bar{display:none;margin:4px 0 10px}' +
      '.bar.on{display:block}' +
      '.bar .track{height:8px;background:#2a1e08;border:1px solid #7a5a12;border-radius:999px;overflow:hidden}' +
      '.bar .fill{display:block;height:100%;width:0;background:linear-gradient(90deg,#ffd23c,#fff3c4);' +
      'border-radius:999px;transition:width .12s linear}' +
      '.bar.wait .fill{width:32%;animation:sweep 1s ease-in-out infinite alternate}' +
      '@keyframes sweep{from{transform:translateX(-40%)}to{transform:translateX(220%)}}' +
      '@media (prefers-reduced-motion:reduce){.bar .fill{transition:none}.bar.wait .fill{animation:none;width:50%}}' +
      '.bar .pct{font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#ffd23c;margin-top:5px}' +
      '</style>' +
      '<div class="k"><button class="x" type="button">&times;</button>' +
      '<div class="t">Games Are Eating The World</div>' +
      '<p class="lead">' + t1 + '</p>' +
      '<div class="rank">' + placeText + '</div>' +
      '<div class="gold">' + esc(name || 'player') + '</div>' +
      (score != null ? '<div class="gold sc">' + esc(score) + '</div>' : '') +
      (has ? '<video muted playsinline controls src="' + lastUrl + '"></video>' +
        '<p class="hint">' + (DE ? 'Der Score ist auf der Liste. Das Video geht nur, wenn du sendest.' : 'The score is on the list. The video goes only if you send it.') + '</p>' +
        '<div class="bar"><div class="track"><i class="fill"></i></div><div class="pct"></div></div>' : '') +
      '<button class="s" type="button">' + (has ? (DE ? 'Video mit Freunden teilen' : 'Share video with friends') : (DE ? 'Mit Freunden teilen' : 'Share with friends')) + '</button>' +
      (has ? '<button class="post" type="button">' + (DE ? 'Video an die Weltrangliste senden' : 'Send video to the world ranking') + '</button>' : '') +
      '<a class="see" href="' + esc(board) + '" target="_blank" rel="noopener">' + (DE ? 'Weltrangliste öffnen' : 'Open the ranking') + '</a>' +
      ((window.GS && GS.connected && !GS.connected())
        ? '<span class="v">' + (DE ? 'Das zählt als Gast. ' : 'This counts as a guest run. ') +
          '<button class="vb" type="button">' + (DE ? 'Mit HISCORE-Konto verbinden' : 'Attach to your HISCORE account') + '</button></span>'
        : '') +
      '</div>';
    r.querySelector('.x').onclick = function () { host.remove(); };
    var vb = r.querySelector('.vb');
    if (vb) vb.onclick = function () { try { GS.connect(); } catch (e2) {} };
    var txt = (name || 'player') + (score != null ? ' · ' + score : '') +
      (rank ? (DE ? ' · Platz ' : ' · Rank ') + rank +
        ((typeof total === 'number' && total > 0) ? (DE ? ' von ' : ' of ') + total : '') : '') +
      ' · Games Are Eating The World';
    r.querySelector('.s').onclick = function () {
      var payload = { title: 'HISCORE', text: txt, url: board };
      if (has && lastBlob && navigator.share) {
        var file;
        try { file = new File([lastBlob], 'hiscore.mp4', { type: lastBlob.type || 'video/mp4' }); } catch (e3) {}
        var withFile = file ? { title: payload.title, text: payload.text, url: payload.url, files: [file] } : payload;
        var can = true;
        try { if (file && navigator.canShare) can = navigator.canShare(withFile); } catch (e4) { can = false; }
        navigator.share(can && file ? withFile : payload).then(function () {}, function () {
          window.open(board, '_blank');
        });
        return;
      }
      if (navigator.share) { navigator.share(payload).then(function () {}, function () { window.open(board, '_blank'); }); return; }
      window.open(board, '_blank');
    };
    var post = r.querySelector('.post');
    if (post) post.onclick = function () {
      if (!d || !d.id || !lastBlob) return;
      post.disabled = true;
      post.textContent = DE ? 'Sende…' : 'Sending…';
      barShow(r, 1, barText(1));
      var fd = new FormData();
      fd.append('video', lastBlob, /mp4/i.test(lastBlob.type || '') ? 'run.mp4' : 'run.webm');
      fd.append('kind', 'clip');
      xhrForm(BASE + '/api/scores/' + d.id + '/proof', fd, function (pct) {
        barShow(r, pct, barText(pct));
      }, function (ok) {
        post.textContent = ok
          ? (DE ? 'Video ist auf der Liste' : 'Video is on the ranking')
          : (DE ? 'Senden fehlgeschlagen' : 'Send failed');
        barShow(r, ok ? 100 : 0, barText(ok ? 100 : 0, ok, !ok));
        if (!ok) post.disabled = false;
      });
    };
    document.body.appendChild(host);
  }

  function wrapSubmit() {
    if (wrapped || !window.GS || !GS.submit) return;
    wrapped = true;
    var orig = GS.submit;
    GS.submit = function (score, opts) {
      opts = opts || {};
      var show = opts.show !== false;
      return new Promise(function (resolve, reject) {
        recStop(false, function () {
          orig.call(GS, score, Object.assign({}, opts, { show: false })).then(function (d) {
            var name = (opts && opts.player) || (window.GS && GS.player ? GS.player(false) : 'player');
            if (d && d.ok && !d.flagged && show) card(d, score, name);
            resolve(d);
          }).catch(reject);
        });
      });
    };
  }

  function firstGesture() {
    recStart();
    document.removeEventListener('pointerdown', firstGesture, true);
    document.removeEventListener('keydown', firstGesture, true);
  }

  function kit() {
    wrapSubmit();
    orbBuild();
    window.HISCORE = window.HISCORE || {};
    window.HISCORE.start = function () {
      try { if (window.GS && GS.reset) GS.reset(); } catch (e) {}
      recStart();
    };
    window.HISCORE.report = function (score, meta) {
      if (!window.GS) return;
      GS.submit(score, meta || {});
    };
    document.addEventListener('pointerdown', firstGesture, true);
    document.addEventListener('keydown', firstGesture, true);
  }

  function go() {
    if (document.body) kit();
    else document.addEventListener('DOMContentLoaded', kit);
  }

  bootGs(go);
})();
