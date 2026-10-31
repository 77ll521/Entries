/* 营销文案模板库 页面逻辑（每产品 × 6模板字段 × 3版本） */
(function () {
  "use strict";
  // 6 个模板字段：kind=line 单行；multi 每行一条
  var TEMPLATE_FIELDS = [
    { key: "痛点", label: "客户痛点", kind: "line" },
    { key: "钩子", label: "口播开场钩子", kind: "line" },
    { key: "人群", label: "目标人群", kind: "line" },
    { key: "卖点", label: "核心卖点", kind: "multi" },
    { key: "场景", label: "适用场景", kind: "multi" },
    { key: "绘图场景", label: "AI绘图·场景描述", kind: "line" }
  ];
  var VERSIONS = ["务实稳健", "激情营销", "专业高端"];

  var state = {
    all: [],          // [{行业,产品,材质,简述,variants:[{style,fields:{...}}]}]
    filtered: [],
    shown: 0,
    pageSize: 40,
    current: null,
    curVariant: 0
  };

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function asText(v) { return Array.isArray(v) ? v.join("\n") : (v || ""); }

  function loadData() {
    var d = window.LIBRARY_DATA || [];
    state.all = d.filter(function (r) { return r.variants && r.variants.length; });
    var totalV = 0;
    state.all.forEach(function (r) { totalV += r.variants.length; });
    $("libBadge").textContent = "共 " + state.all.length + " 产品 · " + totalV + " 套模板";
    var inds = [];
    state.all.forEach(function (r) { if (inds.indexOf(r["行业"]) < 0) inds.push(r["行业"]); });
    var sel = $("libIndustry");
    inds.forEach(function (n) { var o = document.createElement("option"); o.value = n; o.textContent = n; sel.appendChild(o); });
  }

  function itemHay(r) {
    var parts = [r["产品"], r["行业"], r["材质"] || "", r["简述"] || ""];
    r.variants.forEach(function (v) {
      parts.push(v.style || "");
      TEMPLATE_FIELDS.forEach(function (f) { parts.push(asText((v.fields || {})[f.key])); });
    });
    return parts.join(" ").toLowerCase();
  }

  function applyFilter() {
    var kw = $("libSearch").value.trim().toLowerCase();
    var ind = $("libIndustry").value;
    state.filtered = state.all.filter(function (r) {
      if (ind && r["行业"] !== ind) return false;
      if (!kw) return true;
      return itemHay(r).indexOf(kw) >= 0;
    });
    state.shown = 0;
    $("libCards").innerHTML = "";
    var cnt = 0; state.filtered.forEach(function (r) { cnt += r.variants.length; });
    $("libCount").textContent = "匹配 " + state.filtered.length + " 产品 / " + cnt + " 套模板";
    if (!state.filtered.length) {
      $("libCards").innerHTML = '<div class="lib-empty">没有匹配的模板，换个关键词试试</div>';
      $("libLoadmore").style.display = "none";
      return;
    }
    renderMore();
  }

  function renderMore() {
    var frag = document.createDocumentFragment();
    var end = Math.min(state.shown + state.pageSize, state.filtered.length);
    for (var i = state.shown; i < end; i++) frag.appendChild(makeCard(state.filtered[i]));
    $("libCards").appendChild(frag);
    state.shown = end;
    $("libLoadmore").style.display = end < state.filtered.length ? "block" : "none";
  }

  function makeCard(rec) {
    var card = document.createElement("div");
    card.className = "lib-card" + (state.current === rec ? " sel" : "");
    var sub = (rec["材质"] ? rec["材质"] + " · " : "") + (rec["简述"] || "");
    card.innerHTML = '<div class="lib-card-title">' + esc(rec["产品"]) +
      '<span class="lib-tag">' + esc(rec["行业"]) + "</span>" +
      '<span class="lib-tag lib-tag-v">' + rec.variants.length + "版本</span></div>" +
      '<div class="lib-card-sub">' + esc(sub) + "</div>";
    card.addEventListener("click", function () { showDetail(rec, card); });
    return card;
  }

  function showDetail(rec, card) {
    state.current = rec;
    state.curVariant = 0;
    document.querySelectorAll(".lib-card").forEach(function (x) { x.classList.remove("sel"); });
    if (card) card.classList.add("sel");
    renderDetail();
  }

  function renderDetail() {
    var rec = state.current;
    var d = $("libDetail");
    d.innerHTML = "";

    var h = document.createElement("div"); h.className = "lib-detail-h"; h.textContent = rec["产品"];
    var meta = document.createElement("div"); meta.className = "lib-detail-meta";
    meta.textContent = "行业：" + rec["行业"] + "　|　材质：" + (rec["材质"] || "—") +
      (rec["简述"] ? ("　|　" + rec["简述"]) : "");
    d.appendChild(h); d.appendChild(meta);

    // 版本切换
    var vbar = document.createElement("div"); vbar.className = "ver-bar";
    var vlabel = document.createElement("span"); vlabel.className = "ver-bar-label"; vlabel.textContent = "风格版本：";
    vbar.appendChild(vlabel);
    rec.variants.forEach(function (v, vi) {
      var b = document.createElement("button");
      b.className = "ver-btn" + (vi === state.curVariant ? " active" : "");
      b.textContent = v.style || ("版本" + (vi + 1));
      b.addEventListener("click", function () { state.curVariant = vi; renderDetail(); });
      vbar.appendChild(b);
    });
    d.appendChild(vbar);

    var fields = (rec.variants[state.curVariant] || {}).fields || {};

    // 6 字段逐项展示
    var wrap = document.createElement("div"); wrap.className = "tpl-fields";
    TEMPLATE_FIELDS.forEach(function (fd) {
      var row = document.createElement("div"); row.className = "tpl-field-row";
      var name = document.createElement("div"); name.className = "tpl-field-name"; name.textContent = fd.label;
      var val = document.createElement("div"); val.className = "tpl-field-val";
      var v = fields[fd.key];
      if (fd.kind === "multi") {
        var arr = Array.isArray(v) ? v : String(v || "").split(/\n/).filter(Boolean);
        if (arr.length) {
          var ul = document.createElement("ol"); ul.className = "tpl-list";
          arr.forEach(function (x) { var li = document.createElement("li"); li.textContent = x; ul.appendChild(li); });
          val.appendChild(ul);
        } else { val.textContent = "—"; }
      } else {
        val.textContent = (v || "—").toString().trim() || "—";
      }
      row.appendChild(name); row.appendChild(val);
      wrap.appendChild(row);
    });
    d.appendChild(wrap);

    var acts = document.createElement("div"); acts.className = "detail-actions";
    var bImp = document.createElement("button"); bImp.className = "btn btn-primary"; bImp.textContent = "📥 一键导入到模板管理";
    bImp.addEventListener("click", function () { importToTemplateManage(rec); });
    var b2 = document.createElement("button"); b2.className = "btn btn-ghost"; b2.textContent = "复制本版本模板";
    b2.addEventListener("click", function () {
      copyText(composeVariant(rec, variants(rec))).then(function (ok) { toast(ok ? "已复制本版本模板" : "复制失败"); });
    });
    var b3 = document.createElement("button"); b3.className = "btn btn-ghost"; b3.textContent = "⬇ 下载本版本";
    b3.addEventListener("click", function () {
      downloadText(composeVariant(rec, variants(rec)), "模板_" + safeName(rec["行业"] + "_" + rec["产品"] + "_" + (rec.variants[state.curVariant].style || "")) + ".txt");
    });
    acts.appendChild(bImp); acts.appendChild(b2); acts.appendChild(b3);
    d.appendChild(acts);
  }

  function variants(rec) { return rec.variants[state.curVariant]; }

  // 把产品当前版本的 6 字段，导入到“模板管理”（写 localStorage，与 app.js 共用）
  var LS_KEY_TPL = "mfg_copy_templates_v1";
  var VCOUNT = 4;
  function importToTemplateManage(rec) {
    var v = variants(rec);
    var fields = v.fields || {};
    // 目标名称：产品名（若重名则加行业前缀）
    var name = rec["产品"] || "未命名模板";
    // 读取现有模板：优先 localStorage，否则用内嵌默认
    var base;
    try {
      var raw = localStorage.getItem(LS_KEY_TPL);
      base = raw ? JSON.parse(raw) : null;
    } catch (e) { base = null; }
    if (!base || typeof base !== "object") {
      base = JSON.parse(JSON.stringify(window.TEMPLATES_DATA || {}));
    }
    var existed = !!base[name];
    if (existed) { name = rec["产品"] + "（" + rec["行业"] + "）"; existed = !!base[name]; }

    // 构造 profile：{field:{v:[4],active:0}, _versions:{...}} —— 导入版本放在“版本1”
    var DEF = [
      { key: "痛点", multi: false }, { key: "钩子", multi: false }, { key: "人群", multi: false },
      { key: "卖点", multi: true }, { key: "场景", multi: true }, { key: "绘图场景", multi: false }
    ];
    var prof = {}, vstore = {};
    DEF.forEach(function (d) {
      var val = fields[d.key];
      var first;
      if (d.multi) {
        first = Array.isArray(val) ? val.slice() : String(val || "").split(/\n/).filter(Boolean);
      } else {
        first = (val || "").toString().trim();
      }
      var varr = [first];
      while (varr.length < VCOUNT) varr.push(d.multi ? [] : "");
      prof[d.key] = first;
      vstore[d.key] = { v: varr, active: 0 };
    });
    prof._versions = vstore;
    base[name] = prof;

    try {
      localStorage.setItem(LS_KEY_TPL, JSON.stringify(base));
      toast("已导入「" + name + "」到模板管理" + (existed ? "（已覆盖同名）" : ""));
    } catch (e) {
      toast("导入失败：" + (e && e.message ? e.message : e));
    }
  }

  function composeVariant(rec, v) {
    var out = ["产品：" + rec["产品"] + "　行业：" + rec["行业"] +
      (rec["材质"] ? "　材质：" + rec["材质"] : "") + "　风格版本：" + (v.style || "")];
    TEMPLATE_FIELDS.forEach(function (fd) {
      var val = (v.fields || {})[fd.key];
      if (fd.kind === "multi") {
        var arr = Array.isArray(val) ? val : String(val || "").split(/\n/).filter(Boolean);
        out.push("\n【" + fd.label + "】\n" + arr.map(function (x, i) { return (i + 1) + ". " + x; }).join("\n"));
      } else {
        out.push("\n【" + fd.label + "】\n" + (val || ""));
      }
    });
    return out.join("\n");
  }

  function copyText(text) {
    if (!text) return Promise.resolve(false);
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text).then(function () { return true; }).catch(function () { return fallbackCopy(text); });
    }
    return Promise.resolve(fallbackCopy(text));
  }
  function fallbackCopy(text) {
    try {
      var ta = document.createElement("textarea");
      ta.value = text; ta.style.position = "fixed"; ta.style.left = "-9999px";
      document.body.appendChild(ta); ta.select();
      var ok = document.execCommand("copy"); document.body.removeChild(ta); return ok;
    } catch (e) { return false; }
  }
  function safeName(s) { return String(s).replace(/[\\/:*?"<>|\s]+/g, "_"); }
  function downloadText(text, fn) {
    var blob = new Blob(["\uFEFF" + text], { type: "text/plain;charset=utf-8" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a"); a.href = url; a.download = fn;
    document.body.appendChild(a); a.click();
    setTimeout(function () { document.body.removeChild(a); URL.revokeObjectURL(url); }, 100);
  }
  function toast(msg) {
    var t = document.createElement("div");
    t.textContent = msg;
    t.style.cssText = "position:fixed;left:50%;top:24px;transform:translateX(-50%);background:#1f3a5f;color:#fff;padding:8px 18px;border-radius:6px;font-size:13px;z-index:999;opacity:.95";
    document.body.appendChild(t);
    setTimeout(function () { document.body.removeChild(t); }, 1400);
  }

  function exportAll() {
    if (!state.filtered.length) { toast("当前没有可导出的模板"); return; }
    var lines = [];
    state.filtered.forEach(function (rec, i) {
      lines.push("════════ 第 " + (i + 1) + " 个产品 · " + rec["行业"] + " · " + rec["产品"] + " ════════");
      lines.push("材质：" + (rec["材质"] || "—"));
      rec.variants.forEach(function (v, vi) {
        lines.push("\n──── 风格版本 " + (vi + 1) + "（" + (v.style || "") + "）────");
        TEMPLATE_FIELDS.forEach(function (fd) {
          var val = (v.fields || {})[fd.key];
          if (fd.kind === "multi") {
            var arr = Array.isArray(val) ? val : String(val || "").split(/\n/).filter(Boolean);
            lines.push("【" + fd.label + "】\n" + arr.map(function (x, j) { return (j + 1) + ". " + x; }).join("\n"));
          } else {
            lines.push("【" + fd.label + "】\n" + (val || ""));
          }
        });
      });
      lines.push("");
    });
    downloadText(lines.join("\n"), "模板库导出_" + state.filtered.length + "产品.txt");
    toast("已导出 " + state.filtered.length + " 个产品");
  }

  function init() {
    loadData();
    applyFilter();
    $("libSearch").addEventListener("input", debounce(applyFilter, 200));
    $("libIndustry").addEventListener("change", applyFilter);
    $("btnLoadmore").addEventListener("click", renderMore);
    $("btnExportAll").addEventListener("click", exportAll);
    if (state.all.length) showDetail(state.all[0], document.querySelector(".lib-card"));
  }
  function debounce(fn, ms) {
    var t; return function () { clearTimeout(t); var a = arguments, self = this; t = setTimeout(function () { fn.apply(self, a); }, ms); };
  }

  document.addEventListener("DOMContentLoaded", init);
})();
