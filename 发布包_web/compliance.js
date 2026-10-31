// 广告法合规检测与替换（工业宣传绝对化用语）。web 与生成流程共用。
// 设计要点：
//  1) 只拦"绝对化/虚假宣传用语"，_不_误伤客观规格参数（如"最大回转直径""100%全检""耐火极限""第一时间"）。
//  2) 命中后优先按映射做安全替换；生成流程里再叠加 AI 合规改写（更懂语境）。
(function (root) {
  // 明确违法违规的绝对化用语 -> 合规替代
  // 顺序：长词在前，避免被短词先替换
  var REPLACE = [
    // 用户点名 + 同类顶级极限词
    ["全球顶尖", "业内领先"],
    ["世界顶尖", "业内领先"],
    ["全球第一", "业内领先"],
    ["世界第一", "业内领先"],
    ["全国第一", "业内领先"],
    ["业内第一", "业内领先"],
    ["行业第一", "业内领先"],
    ["销量第一", "销量靠前"],
    ["第一名", "前列"],
    ["全球领先", "业内领先"],
    ["世界领先", "业内领先"],
    ["行业领先", "行业较优"],
    ["国内领先", "国内较优"],
    ["业内领先", "业内较优"],
    ["首屈一指", "表现突出"],
    ["史无前例", "较为少见"],
    ["无与伦比", "表现出色"],
    ["独一无二", "有特色"],
    ["最高精度", "高精度"],
    ["最高级", "高级"],
    ["最先进", "较先进"],
    ["国家级", "高标准"],   // 无官方认定不得自称"国家级"
    ["世界级", "高标准"],
    ["顶级", "高品质"],
    ["极致", "出色"],
    ["完美", "出色"],
    ["最好", "更好"],
    ["最强", "更强"],
    ["最佳", "更佳"],
    ["最优", "更优"],
    ["最专业", "专业"],
    ["最便宜", "更实惠"],
    ["最低价", "实惠价"],
    ["100%保证", "全力保障"],
    ["百分百保证", "全力保障"],
    ["绝对安全", "安全可靠"],
    ["绝对可靠", "稳定可靠"],
    ["绝对划算", "很划算"],
  ];

  // "最大/最高/最低/最小/最长/最多" 后面跟这些"客观量/规格"时视为规格参数，保留
  var SPEC_WORDS = "回转直径|加工长度|加工直径|加工尺寸|尺寸|直径|长度|宽度|高度|厚度|载重|承重|载荷|功率|转速|流量|压力|温度|粒度|产能|产量|跨度|行程|孔径|通孔|扭矩|速度|角度|重量|电压|电流|频率|模数";

  // 命中位置上下文里出现这些词，视为正常语义，不判违规
  var SAFE_CTX = ["第一时间", "第一件", "第一步", "第一道", "第一站", "第一眼", "第一天", "第一大", "第一批",
    "耐火极限", "弹性极限", "疲劳极限", "极限氧指数", "屈服极限", "抗拉极限",
    "100%全检", "100%检测", "100%耐压", "100%检验", "全检", "达标率100%", "合格率100%", "100%全新", "100%纯", "100%固含量"];

  function isSpec(maxch, after) {
    if (!after) return false;
    return new RegExp("^(的)?" + SPEC_WORDS).test(after);
  }

  // 扫描：返回命中列表 [{word, repl, index, context}]
  // 仅针对 REPLACE 表中的明确违规绝对化用语；"最大/最快/最高达X"等带客观量的事实性表达不拦。
  // 做法：先把安全词（第一时间/耐火极限/100%全检…）用占位符遮住，再扫描，避免误伤。
  function maskSafe(text) {
    var store = [];
    var masked = text;
    // 安全词按长度降序处理，避免短词先被替换
    var safeList = SAFE_CTX.slice().sort(function (a, b) { return b.length - a.length; });
    safeList.forEach(function (s) {
      if (masked.indexOf(s) >= 0) {
        var ph = "\u0001" + store.length + "\u0001";
        masked = masked.split(s).join(ph);
        store.push(s);
      }
    });
    return { masked: masked, store: store };
  }
  function unmaskSafe(text, store) {
    for (var i = store.length - 1; i >= 0; i--) {
      text = text.split("\u0001" + i + "\u0001").join(store[i]);
    }
    return text;
  }

  function scan(text) {
    text = String(text || "");
    var m = maskSafe(text);
    var out = [];
    REPLACE.forEach(function (pair) {
      var w = pair[0], r = pair[1];
      var idx = 0;
      while (true) {
        var i = m.masked.indexOf(w, idx);
        if (i < 0) break;
        var context = text.slice(Math.max(0, i - 12), i + w.length + 12);
        out.push({ word: w, repl: r, index: i, context: context });
        idx = i + w.length;
      }
    });
    var seen = {}, uniq = [];
    out.forEach(function (h) { var key = h.index + "|" + h.word; if (!seen[key]) { seen[key] = 1; uniq.push(h); } });
    uniq.sort(function (a, b) { return a.index - b.index; });
    return uniq;
  }

  // 安全替换：遮住安全词 -> 替换违规词 -> 还原安全词。
  function sanitize(text) {
    text = String(text || "");
    var m = maskSafe(text);
    var result = m.masked;
    REPLACE.forEach(function (pair) {
      var w = pair[0], r = pair[1];
      result = result.split(w).join(r);
    });
    result = unmaskSafe(result, m.store);
    return { text: result, hits: scan(text) };
  }

  var api = { scan: scan, sanitize: sanitize, REPLACE: REPLACE };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.Compliance = api;
})(typeof window !== "undefined" ? window : this);
