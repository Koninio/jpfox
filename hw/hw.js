/*
 * hw.js - offline Japanese handwriting recognition (kanji, hiragana, katakana)
 *
 * Port of the recognition algorithm of Kanji Canvas (moment normalisation,
 * feature extraction, coarse + fine elastic stroke matching), with the DOM /
 * canvas code removed. Works in browsers (window.HW) and Node (globalThis.HW).
 *
 * Original work:
 * Copyright (c) 2019 Dominik Klein, Kanji Canvas
 * http://github.com/asdfjkl/kanjicanvas
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation
 * files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy,
 * modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software
 * is furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.
 * The copyright notice must include a backlink (hyperlink) to http://github.com/asdfjkl/kanjicanvas
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES
 * OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE
 * LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR
 * IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 *
 * Changes from the original: no DOM; input is an array of strokes; input is
 * rescaled and resampled to uniform density before normalisation; input
 * normalisation uses the same single scale factor (alpha) for x and y that
 * was used to build the reference patterns (read_all.py); guards against
 * division by zero for dots and straight lines; set / subset filtering.
 */
(function (root) {
  'use strict';

  var HW = root.HW || {};
  root.HW = HW;

  var refs = [];          // [char, strokeCount, pattern, setCode]
  var index = {};         // char -> true
  HW.ready = false;
  HW.count = 0;

  function setOf(ch) {
    var c = ch.charCodeAt(0);
    if (c >= 0x3041 && c <= 0x309F) return 'hira';
    if (c >= 0x30A0 && c <= 0x30FF) return 'kata';
    return 'kanji';
  }

  // ---- pattern decoding --------------------------------------------------
  // Compact format (patterns.js): one line per reference, "<char><stroke>,<stroke>...".
  // A stroke = first point as 4 chars (x, y; each 2 base-64 digits, value+2048),
  // then 1 char per coordinate holding the delta to the previous point (-44..44).
  var ALPH = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_';
  var DELTA = '#$%&\'()*+-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[]^_`abcdefghijklmnopqrstuvwxyz{|}';
  var OFFSET = 2048, DOFF = 44;
  var DEC = {}, DDEC = {};
  for (var q = 0; q < ALPH.length; q++) DEC[ALPH.charAt(q)] = q;
  for (q = 0; q < DELTA.length; q++) DDEC[DELTA.charAt(q)] = q - DOFF;

  function decodeStroke(s) {
    if (s.length < 4) return [];
    var x = DEC[s.charAt(0)] * 64 + DEC[s.charAt(1)] - OFFSET;
    var y = DEC[s.charAt(2)] * 64 + DEC[s.charAt(3)] - OFFSET;
    var pts = [[x, y]];
    for (var i = 4; i + 1 < s.length; i += 2) {
      x += DDEC[s.charAt(i)];
      y += DDEC[s.charAt(i + 1)];
      pts.push([x, y]);
    }
    return pts;
  }

  // HW.load(data[, append]) - data is the compact string from patterns.js or
  // an array in the original KanjiCanvas format. Replaces loaded patterns
  // unless append is true.
  HW.load = function (data, append) {
    if (!data) return false;
    if (!append) { refs = []; index = {}; }
    var list = [];
    if (typeof data === 'string') {
      var lines = data.split('\n');
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i];
        if (!line) continue;
        var cp = line.codePointAt(0);
        var ch = String.fromCodePoint(cp);
        var body = line.slice(ch.length).split(',');
        var pat = [];
        for (var k = 0; k < body.length; k++) pat.push(decodeStroke(body[k]));
        list.push([ch, pat.length, pat]);
      }
    } else if (Array.isArray(data)) {
      list = data; // original KanjiCanvas format [[char, n, pattern], ...]
    }
    for (var j = 0; j < list.length; j++) {
      var r = list[j];
      refs.push([r[0], r[2].length, r[2], setOf(r[0])]);
      index[r[0]] = true;
    }
    HW.count = Object.keys(index).length; // distinct characters
    HW.ready = refs.length > 0;
    return HW.ready;
  };

  HW.has = function (ch) { return index[ch] === true; };
  HW.chars = function () { return Object.keys(index); };

  // ---- preprocessing (new: input comes from arbitrary canvases) -----------
  // Rescale so the larger side is 148 units (median size of the reference
  // samples, which were drawn at ~1 px point spacing), then resample every
  // stroke at 1 unit arc length. Moment normalisation weights by point count,
  // so uniform density makes the input comparable to the references.
  function preprocess(strokes) {
    var clean = [];
    var xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
    for (var i = 0; i < strokes.length; i++) {
      var s = strokes[i];
      if (!s || !s.length) continue;
      var cs = [];
      for (var j = 0; j < s.length; j++) {
        var p = s[j];
        if (!p) continue;
        var x = +p[0], y = +p[1];
        if (!isFinite(x) || !isFinite(y)) continue;
        cs.push([x, y]);
        if (x < xMin) xMin = x; if (x > xMax) xMax = x;
        if (y < yMin) yMin = y; if (y > yMax) yMax = y;
      }
      if (cs.length) clean.push(cs);
    }
    if (!clean.length) return [];
    var size = Math.max(xMax - xMin, yMax - yMin);
    var sc = size > 0 ? 148 / size : 1;
    var out = [];
    for (var a = 0; a < clean.length; a++) {
      var st = clean[a];
      var pts = [];
      for (var b = 0; b < st.length; b++) pts.push([(st[b][0] - xMin) * sc + 50, (st[b][1] - yMin) * sc + 50]);
      var res = [pts[0]];
      var carry = 0;
      for (var c = 1; c < pts.length; c++) {
        var p0 = pts[c - 1], p1 = pts[c];
        var dx = p1[0] - p0[0], dy = p1[1] - p0[1];
        var len = Math.sqrt(dx * dx + dy * dy);
        if (len === 0) continue;
        var t = 1 - carry;
        while (t <= len) {
          res.push([p0[0] + dx * t / len, p0[1] + dy * t / len]);
          t += 1;
        }
        carry = len - (t - 1);
      }
      var last = pts[pts.length - 1], rl = res[res.length - 1];
      if (rl[0] !== last[0] || rl[1] !== last[1]) res.push(last);
      if (res.length === 1) res.push([res[0][0], res[0][1]]);
      out.push(res);
    }
    return out;
  }

  // ---- moment normalisation (as used to build the reference patterns) ---
  function aran(width, height) {
    var r1 = height > width ? width / height : height / width;
    if (!isFinite(r1)) r1 = 1;
    return Math.sqrt(Math.sin((Math.PI / 2) * r1));
  }

  function momentNormalize(k) {
    var newW = 256, newH = 256;
    var xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
    var i, j, s;
    for (i = 0; i < k.length; i++) {
      s = k[i];
      for (j = 0; j < s.length; j++) {
        if (s[j][0] < xMin) xMin = s[j][0]; if (s[j][0] > xMax) xMax = s[j][0];
        if (s[j][1] < yMin) yMin = s[j][1]; if (s[j][1] > yMax) yMax = s[j][1];
      }
    }
    var oldH = Math.abs(yMax - yMin), oldW = Math.abs(xMax - xMin);
    var r2 = aran(oldW, oldH);
    var aw = newW, ah = newH;
    if (oldH > oldW) aw = r2 * newW; else ah = r2 * newH;
    var xOff = (newW - aw) / 2, yOff = (newH - ah) / 2;
    var m00 = 0, m10 = 0, m01 = 0;
    for (i = 0; i < k.length; i++) {
      s = k[i]; m00 += s.length;
      for (j = 0; j < s.length; j++) { m10 += s[j][0]; m01 += s[j][1]; }
    }
    var xc = m10 / m00, yc = m01 / m00, mu20 = 0, mu02 = 0;
    for (i = 0; i < k.length; i++) {
      s = k[i];
      for (j = 0; j < s.length; j++) {
        mu20 += (s[j][0] - xc) * (s[j][0] - xc);
        mu02 += (s[j][1] - yc) * (s[j][1] - yc);
      }
    }
    var sdx = Math.sqrt(mu20 / m00), sdy = Math.sqrt(mu02 / m00);
    // guard: a perfectly vertical line or a single dot has sdx == 0
    if (!(sdx > 1e-6)) sdx = sdy > 1e-6 ? sdy : 1;
    var alpha = aw / (4 * sdx);
    var out = [];
    for (i = 0; i < k.length; i++) {
      s = k[i];
      var ns = [];
      for (j = 0; j < s.length; j++) {
        ns.push([alpha * (s[j][0] - xc) + aw / 2 + xOff, alpha * (s[j][1] - yc) + ah / 2 + yOff]);
      }
      out.push(ns);
    }
    return out;
  }

  function euclid(a, b) {
    var dx = a[0] - b[0], dy = a[1] - b[1];
    return Math.sqrt(dx * dx + dy * dy);
  }

  function extractFeatures(kanji, interval) {
    var res = [];
    for (var i = 0; i < kanji.length; i++) {
      var s = kanji[i], e = [], dist = 0;
      for (var j = 0; j < s.length; j++) {
        if (j === 0) e.push(s[0]);
        if (j > 0) dist += euclid(s[j - 1], s[j]);
        if (dist >= interval && j > 1) { dist -= interval; e.push(s[j]); }
      }
      if (e.length === 1) e.push(s[s.length - 1]);
      else if (dist > 0.75 * interval) e.push(s[s.length - 1]);
      res.push(e);
    }
    return res;
  }

  // ---- distances and stroke maps (faithful port) --------------------------
  function endPointDistance(p1, p2) {
    var l1 = p1 ? p1.length : 0, l2 = p2 ? p2.length : 0;
    if (l1 === 0 || l2 === 0) return 0;
    var a = p1[0], b = p2[0];
    var d = Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]);
    a = p1[l1 - 1]; b = p2[l2 - 1];
    return d + Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]);
  }

  function initialDistance(p1, p2) {
    var l1 = p1.length, l2 = p2.length;
    var lmin = Math.min(l1, l2), lmax = Math.max(l1, l2), d = 0;
    for (var i = 0; i < lmin; i++) d += Math.abs(p1[i][0] - p2[i][0]) + Math.abs(p1[i][1] - p2[i][1]);
    return d * (lmax / lmin);
  }

  function larger(p1, p2) {
    var l1 = p1 ? p1.length : 0, l2 = p2 ? p2.length : 0;
    return l1 < l2 ? [p2, p1, l2, l1] : [p1, p2, l1, l2];
  }

  function wholeWholeDistance(p1, p2) {
    var a = larger(p1, p2), d = 0;
    if (!a[3]) return 0;
    var step = Math.trunc(a[2] / a[3]);
    for (var i = 0; i < a[3]; i++) {
      var x = a[0][step * i], y = a[1][i];
      d += Math.abs(x[0] - y[0]) + Math.abs(x[1] - y[1]);
    }
    return Math.trunc(d / a[3]);
  }

  function initStrokeMap(p1, p2, metric) {
    var a = larger(p1, p2), map = [], free = [], i, j;
    for (i = 0; i < a[2]; i++) { map[i] = -1; free[i] = true; }
    for (i = 0; i < a[3]; i++) {
      var minD = 10000000, minJ = -1;
      for (j = 0; j < a[2]; j++) {
        if (free[j]) {
          var d = metric(a[0][j], a[1][i]);
          if (d < minD) { minD = d; minJ = j; }
        }
      }
      if (minJ < 0) continue;
      free[minJ] = false;
      map[minJ] = i;
    }
    return map;
  }

  function getMap(p1, p2, metric) {
    var a = larger(p1, p2);
    var map = initStrokeMap(a[0], a[1], metric);
    for (var l = 0; l < 3; l++) {
      for (var i = 0; i < map.length; i++) {
        if (map[i] === -1) continue;
        var dii = metric(a[0][i], a[1][map[i]]);
        for (var j = 0; j < map.length; j++) {
          if (map[i] === -1) continue;
          var dij;
          if (map[j] !== -1) {
            var djj = metric(a[0][j], a[1][map[j]]);
            dij = metric(a[0][j], a[1][map[i]]);
            var dji = metric(a[0][i], a[1][map[j]]);
            if (dji + dij < dii + djj) {
              var t = map[j]; map[j] = map[i]; map[i] = t;
              dii = dij;
            }
          } else {
            dij = metric(a[0][j], a[1][map[i]]);
            if (dij < dii) { map[j] = map[i]; map[i] = -1; dii = dij; }
          }
        }
      }
    }
    return map;
  }

  function concatRange(arr, from, to) { // inclusive
    var r = arr[from];
    for (var t = from + 1; t <= to; t++) r = r.concat(arr[t]);
    return r;
  }

  function completeMap(p1, p2, metric, map) {
    var a = larger(p1, p2), i, j;
    if (map.indexOf(-1) < 0) return map;
    var lastUnassigned = map.length, mapLastTo = -1;
    for (i = map.length - 1; i >= 0; i--) {
      if (map[i] === -1) lastUnassigned = i; else { mapLastTo = map[i]; break; }
    }
    for (i = lastUnassigned; i < map.length; i++) map[i] = mapLastTo;
    var firstUnassigned = -1, mapFirstTo = -1;
    for (i = 0; i < map.length; i++) {
      if (map[i] === -1) firstUnassigned = i; else { mapFirstTo = map[i]; break; }
    }
    for (i = 0; i <= firstUnassigned; i++) map[i] = mapFirstTo;
    for (i = 0; i < map.length; i++) {
      if (i + 1 < map.length && map[i + 1] === -1) {
        var start = i, stop = i + 1;
        while (stop < map.length && map[stop] === -1) stop++;
        var div = start, best = 1000000;
        for (j = start; j < stop; j++) {
          var ab = concatRange(a[0], start, j);
          var bc = concatRange(a[0], j + 1, stop);
          var d = metric(ab, a[1][map[start]]) + metric(bc, a[1][map[stop]]);
          if (d < best) { div = j; best = d; }
        }
        for (j = start; j <= div; j++) map[j] = map[start];
        for (j = div + 1; j < stop; j++) map[j] = map[stop];
      }
    }
    return map;
  }

  function computeDistance(p1, p2, metric, map) {
    var a = larger(p1, p2), dist = 0, idx = 0;
    while (idx < a[2]) {
      var target = a[1][map[idx]], start = idx, stop = start + 1;
      while (stop < map.length && map[stop] === map[idx]) stop++;
      dist += metric(target, concatRange(a[0], start, stop - 1));
      idx = stop;
    }
    return dist;
  }

  function computeWholeDistanceWeighted(p1, p2, map) {
    var a = larger(p1, p2), dist = 0, idx = 0;
    while (idx < a[2]) {
      var target = a[1][map[idx]], start = idx, stop = start + 1;
      while (stop < map.length && map[stop] === map[idx]) stop++;
      var cat = concatRange(a[0], start, stop - 1);
      var d = wholeWholeDistance(target, cat);
      if (stop > start + 1) {
        var mm = target ? target.length : 0, nn = cat.length;
        if (nn < mm) { var t = nn; nn = mm; mm = t; }
        d = d * (nn / mm);
      }
      dist += d;
      idx = stop;
    }
    return dist;
  }

  function coarse(input, pool) {
    var n = input.length, out = [];
    for (var i = 0; i < pool.length; i++) {
      var r = pool[i], len = r[1];
      if (n < len + 2 && n > len - 3) {
        var map = getMap(r[2], input, endPointDistance);
        map = completeMap(r[2], input, endPointDistance, map);
        out.push([r, computeDistance(r[2], input, endPointDistance, map)]);
      }
    }
    out.sort(function (x, y) { return x[1] - y[1]; });
    return out;
  }

  function fine(input, cands) {
    var n = input.length, out = [];
    for (var i = 0; i < Math.min(cands.length, 100); i++) {
      var r = cands[i][0], len = r[1], pat = r[2];
      if (n < len + 2 && n > len - 3) {
        var map = getMap(pat, input, initialDistance);
        map = completeMap(pat, input, wholeWholeDistance, map);
        var d = computeWholeDistanceWeighted(pat, input, map);
        d = d / Math.min(n, pat.length);
        out.push([r[0], d]);
      }
    }
    out.sort(function (x, y) { return x[1] - y[1]; });
    return out;
  }

  // ---- public API ---------------------------------------------------------
  HW.recognize = function (strokes, opts) {
    try {
      opts = opts || {};
      var limit = opts.limit > 0 ? Math.min(opts.limit | 0, 100) : 10;
      if (!refs.length || !strokes || !strokes.length) return [];
      var pre = preprocess(strokes);
      if (!pre.length) return [];
      var feat = extractFeatures(momentNormalize(pre), 20);
      var set = opts.set || 'all';
      var only = null;
      if (opts.only) {
        only = {};
        var it = Array.isArray(opts.only) ? opts.only : Array.from(opts.only);
        for (var o = 0; o < it.length; o++) only[it[o]] = true;
      }
      var pool = [];
      for (var i = 0; i < refs.length; i++) {
        var r = refs[i];
        if (set !== 'all' && r[3] !== set) continue;
        if (only && !only[r[0]]) continue;
        pool.push(r);
      }
      var res = fine(feat, coarse(feat, pool));
      var out = [], seen = {};
      for (var k = 0; k < res.length && out.length < limit; k++) {
        if (seen[res[k][0]]) continue; // a character may have several reference variants
        seen[res[k][0]] = true;
        out.push(res[k][0]);
      }
      return out;
    } catch (e) {
      return [];
    }
  };

  // exposed for tests / debugging
  HW._internal = { decodeStroke: decodeStroke, preprocess: preprocess, momentNormalize: momentNormalize, extractFeatures: extractFeatures };

  if (root.HW_PATTERNS) { HW.load(root.HW_PATTERNS); root.HW_PATTERNS = null; }
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
