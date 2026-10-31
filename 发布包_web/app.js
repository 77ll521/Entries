/* ============================================================
 * 制造企业文案助手 · 网页版（基础款 + AI升级款）
 * 纯静态、无后端、无外部依赖。
 * 逻辑移植自 Python 版 copy_app.py（模板引擎 / 行业识别 / 字段解析 / 产品库 / AI 调用）。
 * 升级款：用户在浏览器本地填自己的 API 密钥，直连 OpenAI 兼容接口；密钥不上传。
 * ============================================================ */
(function () {
  "use strict";

  var SECTION_KEYS = ["1688硬核工业风", "短视频", "朋友圈短文案", "AI绘图Prompt", "博客", "邮件"];
  var PRODUCT_FIELDS = ["产品编号", "产品名称", "行业品类", "材质", "尺寸规格", "重量", "交期", "认证", "备注"];
  var TEMPLATE_FIELDS = [
    { key: "痛点", label: "客户痛点（一句话描述客户最头疼的问题）", kind: "line" },
    { key: "钩子", label: "口播开场钩子（抖音黄金3秒开场）", kind: "line" },
    { key: "人群", label: "目标人群（文案面向谁）", kind: "line" },
    { key: "卖点", label: "核心卖点（每行一条）", kind: "multi" },
    { key: "场景", label: "适用场景（每行一条）", kind: "multi" },
    { key: "绘图场景", label: "AI绘图·场景描述（一句话）", kind: "line" }
  ];
  var VERSION_LABELS = ["版本1", "版本2", "版本3", "自定义"];
  var VERSION_COUNT = 4;

  var LS_KEY_TPL = "mfg_copy_templates_v1";
  var LS_KEY_PROD = "mfg_copy_products_v1";
  var LS_KEY_AI = "mfg_copy_ai_v1";

  var DEFAULT_AI = {
    api_url: "https://api.deepseek.com/v1/chat/completions",
    api_key: "",
    model: "deepseek-chat",
    temperature: 0.7,
    timeout: 90
  };

  // ---------- 小工具 ----------
  function $(id) { return document.getElementById(id); }
  function deepCopy(o) { return JSON.parse(JSON.stringify(o)); }
  function escHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  // ============================================================
  // 模板数据：优先浏览器本地保存，否则用内嵌默认（含三套风格）
  // ============================================================
  function defaultTemplates() {
    return deepCopy(window.TEMPLATES_DATA || {});
  }

  function loadTemplates() {
    try {
      var raw = localStorage.getItem(LS_KEY_TPL);
      if (raw) {
        var data = JSON.parse(raw);
        if (data && typeof data === "object") return data;
      }
    } catch (e) { /* ignore */ }
    return defaultTemplates();
  }

  function saveTemplates(tpl) {
    localStorage.setItem(LS_KEY_TPL, JSON.stringify(tpl));
  }

  // 把某行业画像规整为 {field: {v:[..4..], active:idx}}
  function profileToVersions(prof) {
    prof = prof || {};
    var old = prof._versions;
    var out = {};
    TEMPLATE_FIELDS.forEach(function (f) {
      var kind = f.kind, key = f.key;
      var v = [], active = 0;
      if (old && old[key] && Array.isArray(old[key].v)) {
        v = old[key].v.slice();
        active = parseInt(old[key].active || 0, 10) || 0;
      } else {
        var cur = prof[key];
        v = [cur !== undefined ? cur : (kind === "multi" ? [] : "")];
        active = 0;
      }
      while (v.length < VERSION_COUNT) v.push(kind === "multi" ? [] : "");
      v = v.slice(0, VERSION_COUNT);
      if (kind === "multi") {
        v = v.map(function (x) {
          if (Array.isArray(x)) return x;
          if (typeof x === "string" && x) return x.split(/\r?\n/).filter(Boolean);
          return [];
        });
      } else {
        v = v.map(function (x) { return x == null ? "" : String(x); });
      }
      if (active < 0 || active >= VERSION_COUNT) active = 0;
      out[key] = { v: v, active: active };
    });
    return out;
  }

  // 三版结构 -> 画像（主键取 active 版 + 附带 _versions）
  function versionsToProfile(versions) {
    var prof = {}, vstore = {};
    TEMPLATE_FIELDS.forEach(function (f) {
      var key = f.key, kind = f.kind;
      var entry = versions[key] || {};
      var v = (entry.v || []).slice();
      var active = parseInt(entry.active || 0, 10) || 0;
      while (v.length < VERSION_COUNT) v.push(kind === "multi" ? [] : "");
      v = v.slice(0, VERSION_COUNT);
      if (active < 0 || active >= VERSION_COUNT) active = 0;
      prof[key] = v[active];
      vstore[key] = { v: v, active: active };
    });
    prof._versions = vstore;
    return prof;
  }

  // ============================================================
  // 字段解析 / 行业识别 / 模板渲染（移植自 Python）
  // ============================================================
  function extractFieldsFromText(text) {
    text = text || "";
    var fields = {};
    PRODUCT_FIELDS.forEach(function (f) { fields[f] = ""; });
    PRODUCT_FIELDS.forEach(function (f) {
      var re = new RegExp(f.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*[:：]\\s*([^；;\\n]+)");
      var m = text.match(re);
      if (m) fields[f] = m[1].trim();
    });
    if (!fields["产品名称"]) {
      var segs = text.trim().split(/[；;，,\n]/);
      for (var i = 0; i < segs.length; i++) {
        var s = segs[i].trim();
        if (!s) continue;
        var isField = PRODUCT_FIELDS.some(function (f) { return s.indexOf(f + "：") === 0; });
        if (!isField) { fields["产品名称"] = s.length <= 24 ? s : s.slice(0, 12); break; }
      }
    }
    fields._raw = text.trim();
    return fields;
  }

  function detectIndustry(fields, rawText, tpl) {
    tpl = tpl || window.TEMPLATES_DATA;
    var KW = window.INDUSTRY_KEYWORDS || {};
    var tag = (fields["行业品类"] || "").trim();
    if (tag) {
      for (var name in tpl) {
        if (name !== "通用" && tag.indexOf(name) >= 0) return name;
      }
      var low = tag.toLowerCase();
      for (var n2 in KW) {
        if (!(n2 in tpl)) continue;
        for (var k = 0; k < KW[n2].length; k++) {
          if (low.indexOf(KW[n2][k]) >= 0) return n2;
        }
      }
    }
    var t = (rawText || "").toLowerCase();
    var best = "通用", bestHits = 0;
    for (var n3 in KW) {
      if (!(n3 in tpl) && n3 !== "通用") continue;
      var hits = 0;
      KW[n3].forEach(function (kw) { if (t.indexOf(kw) >= 0) hits++; });
      if (hits > bestHits) { best = n3; bestHits = hits; }
    }
    if (!(best in tpl)) best = ("通用" in tpl) ? "通用" : (Object.keys(tpl)[0] || "通用");
    return best;
  }

  function fmtSpecs(fields) {
    var order = ["产品编号", "产品名称", "材质", "尺寸规格", "重量", "交期", "认证"];
    var parts = [];
    order.forEach(function (f) {
      var v = (fields[f] || "").trim();
      if (v) parts.push(f + "：" + v);
    });
    return parts.join("　｜　");
  }

  function renderBasicSections(text, tpl) {
    tpl = tpl || loadTemplates();
    var fields = extractFieldsFromText(text);
    var industry = detectIndustry(fields, text, tpl);
    var profRaw = tpl[industry] || tpl["通用"] || window.GENERAL_PROFILE || {};

    function active(field, kind) {
      var vs = profRaw._versions;
      if (vs && vs[field] && Array.isArray(vs[field].v)) {
        var v = vs[field].v, a = parseInt(vs[field].active || 0, 10) || 0;
        if (a >= 0 && a < v.length) return v[a];
      }
      var val = profRaw[field];
      return val !== undefined ? val : (kind === "multi" ? [] : "");
    }
    var GEN = window.GENERAL_PROFILE || { 钩子: "", 卖点: [], 场景: [], 绘图场景: "" };
    var prof = {
      "痛点": active("痛点", "line"),
      "钩子": active("钩子", "line") || GEN["钩子"],
      "人群": active("人群", "line"),
      "卖点": (active("卖点", "multi") || []).length ? active("卖点", "multi") : (GEN["卖点"] || []),
      "场景": (active("场景", "multi") || []).length ? active("场景", "multi") : (GEN["场景"] || []),
      "绘图场景": active("绘图场景", "line") || GEN["绘图场景"]
    };

    var name = fields["产品名称"] || "本厂产品";
    var material = fields["材质"] || "";
    var spec = fields["尺寸规格"] || "";
    var lead = fields["交期"] || "面议";
    var cert = fields["认证"] || "";
    var remark = fields["备注"] || "";
    var specs = fmtSpecs(fields);

    var points = prof["卖点"] || [];
    var scenes = prof["场景"] || [];
    if (!points.length) points = ["质量稳定、做工可靠"];
    if (!scenes.length) scenes = ["各类工业场景"];

    // ① 1688
    var pLines = points.map(function (p, i) { return (i + 1) + ". " + p; }).join("\n");
    var specLine = specs || name;
    var s1688 = "【" + name + "】" + industry + "源头工厂直供 ｜ 质量稳 交期准 支持定制\n\n" +
      "一、核心卖点\n" + pLines + "\n\n" +
      "二、规格参数\n" + specLine + "\n\n" +
      "三、适用场景\n" + scenes.join("、") + "\n\n" +
      "四、厂家承诺\n" +
      "山东源头工厂，" + (cert ? ("出厂通过" + cert + "认证，") : "") +
      "常规交期" + lead + "，支持非标定制与批量供货，量大价优，欢迎来厂考察洽谈。";

    // ② 抖音
    var hook = prof["钩子"];
    var pointTalk = points.slice(0, 3).join("、");
    var certTalk = cert ? ("，出厂都过" + cert + "认证") : "";
    var douyin = "【口播】" + hook + "\n" +
      "【画面】" + prof["绘图场景"] + "，镜头扫过产品与车间\n\n" +
      "【口播】咱们这款" + name + "，" + (material ? (material + "材质，") : "") +
      "主打就是" + pointTalk + "。\n" +
      "【口播】不管是" + scenes.slice(0, 2).join("、") + "都能用得上，" +
      (spec ? ("规格" + spec + "，") : "") + (lead ? ("交期" + lead + "，") : "") +
      "源头工厂直接发货" + certTalk + "。\n" +
      "【口播】有需要的老板，点个关注、私信我，或者直接来厂里看货！";

    // ③ 朋友圈
    var c1 = "【务实型】" + name + "，" + (material ? (material + "材质，") : "") + points[0] + "。" +
      (lead ? ("交期" + lead + "，") : "") + "源头工厂，质量有保障，欢迎老板们询价。";
    var c2 = "【场景型】做" + scenes.slice(0, 2).join("、") + "的老板看过来——这款" + name +
      (spec ? ("，" + spec) : "") + "，" + (points[1] || points[0]) + "，用过的都说省心。";
    var c3 = "【活动型】" + name + "本月特惠！" + (cert ? ("认证" + cert + "，") : "") +
      "量大从优，" + (lead ? ("交期" + lead + "，") : "") + "先到先得，私信我留货 🚀";
    var moments = c1 + "\n\n" + c2 + "\n\n" + c3;

    // ④ AI Prompt
    var matPhrase = material ? (material + "材质，") : "";
    var prompt1 = "写实产品展示风：主体是一款" + name + "，" + matPhrase +
      (spec ? ("尺寸" + spec + "，") : "") + "置于纯净浅灰背景，柔和的影棚光线与清晰反光，细节锐利，工业产品摄影质感，高清 8K。";
    var prompt2 = "场景应用风：" + prof["绘图场景"] + "，" + name + "正在使用中，" +
      "光线明亮真实，构图稳重，突出" + points[0] + "与专业可靠的工作氛围，纪实摄影风格，高清画质。";
    var aiPrompt = prompt1 + "\n\n" + prompt2;

    if (remark) s1688 += "\n\n五、补充说明\n" + remark;

    // ⑤ 博客（基础款模板拼装）
    var blog = "【" + name + "选购指南】" + industry + "厂家怎么挑？\n\n" +
      "一、产品价值\n" + name + "是" + industry + "领域的高性价比之选，" +
      (material ? ("采用" + material + "材质，") : "") + "主打" + points.slice(0, 2).join("、") + "。\n\n" +
      "二、技术亮点\n" + points.map(function (p, i) { return (i + 1) + ". " + p; }).join("\n") + "\n\n" +
      "三、应用场景\n广泛适用于" + scenes.join("、") + "等场景，" + (spec ? ("规格" + spec + "，") : "") + "可按需定制。\n\n" +
      "四、选购建议\n选择源头工厂更省心，关注" + (cert ? (cert + "等认证、") : "") + "交期与售后。常规交期" + lead + "，量大价优，欢迎来厂考察。";

    // ⑥ 邮件（基础款模板）
    var mail = "主题：关于" + name + "的合作与报价（" + industry + "源头工厂）\n\n" +
      "尊敬的客户：\n\n" +
      "您好！我们是山东" + industry + "源头制造企业，现就" + name + "与您探讨合作可能。\n\n" +
      name + "主要优势：\n" + points.slice(0, 3).map(function (p, i) { return (i + 1) + ". " + p; }).join("\n") + "\n\n" +
      (cert ? ("产品通过" + cert + "等认证，") : "") + "常规交期" + lead + "，支持非标定制与批量供货，量大价优。\n\n" +
      "如您有兴趣，烦请回复本邮件或回电，我们将第一时间提供样品与报价。顺祝商祺！\n\n" +
      "山东" + industry + "制造企业　敬上";

    var res = {};
    res["1688硬核工业风"] = s1688;
    res["短视频"] = douyin;
    res["朋友圈短文案"] = moments;
    res["AI绘图Prompt"] = aiPrompt;
    res["博客"] = blog;
    res["邮件"] = mail;
    return res;
  }

  function productToText(rec) {
    var lines = [];
    PRODUCT_FIELDS.forEach(function (f) {
      var v = rec[f];
      if (v) lines.push(f + "：" + v);
    });
    // 非标准字段
    for (var k in rec) {
      if (k === "_id") continue;
      if (PRODUCT_FIELDS.indexOf(k) >= 0) continue;
      if (rec[k]) lines.push(k + "：" + rec[k]);
    }
    return lines.join("；");
  }

  // ============================================================
  // AI 升级款：配置存储 / Prompt / 解析 / 调用（移植自 Python）
  // ============================================================
  function loadAIConfig() {
    var cfg = deepCopy(DEFAULT_AI);
    try {
      var raw = localStorage.getItem(LS_KEY_AI);
      if (raw) {
        var d = JSON.parse(raw);
        if (d && typeof d === "object") {
          Object.keys(DEFAULT_AI).forEach(function (k) { if (d[k] !== undefined) cfg[k] = d[k]; });
        }
      }
    } catch (e) { /* ignore */ }
    return cfg;
  }
  function saveAIConfig(cfg) {
    try { localStorage.setItem(LS_KEY_AI, JSON.stringify(cfg)); }
    catch (e) { alert("保存 AI 设置失败：" + e.message); }
  }

  // 与 Python build_prompt 完全一致的 prompt
  function buildPrompt(productInfo, styleReq) {
    var styleBlock = "";
    if (styleReq && String(styleReq).trim()) {
      styleBlock = "\n【老板的文案风格需求（务必优先满足）】\n" + String(styleReq).trim() + "\n" +
        "请在撰写时严格贴合上述风格需求（语气、受众、侧重点、称呼、忌讳等），在此前提下再遵循下方各段要求。\n";
    }
    return "你是资深的工业与制造企业营销文案师，长期服务山东中小制造企业\n" +
      "（机床、五金、装备、机电、橡塑、纺织、化工、家居建材、食品机械等行业）。\n" +
      "下面是某制造企业的一款产品介绍/参数，请基于它创作营销文案：\n\n" +
      "【产品信息】\n" + productInfo + "\n" + styleBlock + "\n" +
      "请先判断产品所属行业和品类，再按行业特点撰写。一次性输出以下 6 个部分，\n" +
      "并用下面固定的分隔标记分开（分隔标记必须原样保留，方便系统分栏）：\n\n" +
      "===1688硬核工业风===\n" +
      "面向 1688/阿里巴巴采购商、经销商与下游工厂负责人的文案。突出核心性能、品质、\n" +
      "效率、稳定性、性价比与交期优势。包含：一句话卖点标题 + 3~5 条核心卖点/参数亮点\n" +
      "（尽量带数据）+ 适用场景 + 行动号召。语言专业、可信、不空泛。\n\n" +
      "===短视频===\n" +
      "接地气的短视频口播脚本（适用于抖音/快手/视频号），时长约 30~45 秒。包含：黄金 3 秒\n" +
      "开场钩子 + 客户痛点场景 + 产品亮点口语化表达 + 结尾引导（点赞/私信/到厂参观/加微信）。\n" +
      "语气像当地厂长或老师傅口吻，自然不尬，标注【口播】与【画面】提示。\n\n" +
      "===朋友圈短文案===\n" +
      "3 条不同角度的短文案（务实型 / 场景型 / 活动促销型各一条），每条 60 字以内，\n" +
      "口语化、有网感、可直接发朋友圈，可带少量 emoji。\n\n" +
      "===AI绘图Prompt===\n" +
      "给出 2 条适配这款产品的 AI 绘图提示词（中文，可直接用于文生图工具）：\n" +
      "一条写实产品展示风，一条场景应用风。写明主体、材质、背景、光线、构图、画质描述。\n\n" +
      "===博客===\n" +
      "一篇可发布在企业官网/公众号/自媒体平台的博客文章，标题 + 正文（约 500~800 字），\n" +
      "分 3~4 个小标题展开：产品价值、技术亮点、应用场景、选购建议。语言专业但可读，\n" +
      "自然融入 SEO 关键词，结尾可带品牌介绍或联系方式。\n\n" +
      "===邮件===\n" +
      "一封面向潜在客户/经销商的商务开发邮件，含：恰当的主题行 + 称呼 + 开场（点明来意与\n" +
      "价值）+ 产品核心亮点 2~3 条 + 明确行动号召（回电/回复/索取样品与报价）+ 落款。\n" +
      "语气专业、得体、简洁，不冗长。\n\n" +
      "注意：\n" +
      "- 参数若信息不足，可合理补充同类产品通用卖点，但不要编造离谱数字或虚假资质。\n" +
      "- 贴合山东制造企业务实、实在的表达风格。\n" +
      "- 只输出上述 6 个部分，不要输出多余的解释或前言。\n\n" + COMMON_RULES;
  }

  // 与 Python parse_sections 一致的解析
  function parseSections(text) {
    var result = {};
    SECTION_KEYS.forEach(function (k) { result[k] = ""; });
    if (!text) return result;
    // 以 === 标题 === 分割：模拟 re.split(r"=+\s*([^=\n]+?)\s*=+", text)
    var re = /=+\s*([^=\n]+?)\s*=+/g;
    var parts = [];
    var last = 0, m;
    while ((m = re.exec(text))) {
      parts.push(text.slice(last, m.index));
      parts.push(m[1]);                 // 标题（捕获组）
      last = re.lastIndex;
    }
    parts.push(text.slice(last));
    // parts: [前言, 标题1, 内容1, 标题2, 内容2, ...]
    if (parts.length >= 3) {
      for (var i = 1; i < parts.length - 1; i += 2) {
        var title = (parts[i] || "").trim();
        var content = (parts[i + 1] || "").trim();
        var matched = false;
        for (var j = 0; j < SECTION_KEYS.length; j++) {
          var key = SECTION_KEYS[j];
          if (title.replace(/ /g, "").indexOf(key.replace(/ /g, "")) >= 0) {
            result[key] = content; matched = true; break;
          }
        }
        if (!matched) {
          for (var t = 0; t < SECTION_KEYS.length; t++) {
            if (!result[SECTION_KEYS[t]]) { result[SECTION_KEYS[t]] = content; break; }
          }
        }
      }
    } else {
      result[SECTION_KEYS[0]] = text;
    }
    return result;
  }

  // ---- 所有 AI 功能共用内容红线（保真 / 去AI化 / 语言规范；用户需求优先）----
  var COMMON_RULES =
    "【内容红线（所有输出都必须严格遵守）】\n" +
    "· 核心信息保真红线：必须100%保留原文的核心观点、关键数据、专有名词、核心逻辑、既定段落结构、" +
    "用户指定的特殊格式与标注【不可修改】的内容；严禁擅自修改、增删核心信息，不得改变原文的立意与核心主旨。\n" +
    "· 去AI化核心要求：必须彻底消除 AI 写作的典型通病，严禁保留滥用的刻板过渡词" +
    "（综上所述、由此可见、一言以蔽之、总而言之等）、无意义的排比堆砌、空洞无物的套话、" +
    "同质化的句式、过度书面化的冗余表达、缺乏主语的残缺短句。\n" +
    "· 语言规范约束：必须使用规范现代汉语，符合中文母语者的表达习惯，不得出现错别字、语病、标点使用错误；" +
    "不得使用网络低俗用语、网络黑话，除非原文有明确的场景需求。\n" +
    "· 优先执行用户需求：以上规则在用户明确提出的特殊需求面前让位，始终优先满足用户的具体要求。\n";

  // ---- 分段生成长 prompt（每段单独调用，避免长输出被截断）----
  var SECTION_SPEC = {
    "1688硬核工业风": "面向 1688/阿里巴巴采购商、经销商与下游工厂负责人的文案。包含：一句话卖点标题 + 4 条核心卖点/参数亮点（尽量带数据）+ 适用场景 + 行动号召。语言专业、可信、不空泛，200~400 字。只输出这一段正文，不要输出分隔标记或其它段。",
    "短视频": "接地气的短视频口播脚本（适用于抖音/快手/视频号），约 30~45 秒。包含：黄金 3 秒开场钩子 + 客户痛点场景 + 产品亮点口语化表达 + 结尾引导（点赞/私信/到厂参观/加微信）。语气像当地厂长或老师傅，自然不尬，标注【口播】与【画面】提示。只输出这一段正文。",
    "朋友圈短文案": "3 条不同角度的短文案（务实型 / 场景型 / 活动促销型各一条），每条 60 字以内，口语化、有网感、可直接发朋友圈，可带少量 emoji。只输出这 3 条，用空行分隔。",
    "AI绘图Prompt": "给出 2 条适配这款产品的 AI 绘图提示词（中文，可直接用于文生图工具）：一条写实产品展示风，一条场景应用风。写明主体、材质、背景、光线、构图、画质描述。只输出这 2 条提示词。",
    "博客": "一篇可发布在企业官网/公众号/自媒体平台的博客文章，含标题 + 正文（约 500~800 字），分 3~4 个小标题展开：产品价值、技术亮点、应用场景、选购建议。语言专业但可读，自然融入 SEO 关键词，结尾可带品牌介绍或联系方式。只输出这篇文章正文。",
    "邮件": "一封面向潜在客户/经销商的商务开发邮件，含：恰当的主题行 + 称呼 + 开场（点明来意与价值）+ 产品核心亮点 2~3 条 + 明确行动号召（回电/回复/索取样品与报价）+ 落款。语气专业、得体、简洁。只输出这封邮件。"
  };

  function buildSectionPrompt(productInfo, key, styleReq) {
    var styleBlock = "";
    if (styleReq && String(styleReq).trim()) {
      styleBlock = "【老板的文案风格需求（务必优先满足）】" + String(styleReq).trim() + "\n\n";
    }
    return "你是资深的工业与制造企业营销文案师，长期服务山东中小制造企业。\n" +
      "下面是某制造企业的一款产品介绍/参数：\n【产品信息】\n" + productInfo + "\n\n" +
      styleBlock +
      COMMON_RULES + "\n" +
      "请只创作【" + key + "】这一个部分。要求：\n" + SECTION_SPEC[key] + "\n\n" +
      "【数据真实性红线】严禁编造产品信息中未提供的具体数据：不得杜撰未给出的精度数值、认证资质、交期天数、材质牌号、规格尺寸、产地或客户案例等；原文未提到的信息一律不写具体数字/资质，可用概括性表述。贴合山东制造企业务实、实在的表达。";
  }

  async function callSection(cfg, productInfo, key, styleReq) {
    if (!cfg.api_key) {
      throw new Error("尚未配置 API 密钥。请点右上角「⚙ 设置」填写并保存密钥。");
    }
    var url = cfg.api_url || DEFAULT_AI.api_url;
    var body = {
      model: cfg.model || "deepseek-chat",
      messages: [{ role: "user", content: buildSectionPrompt(productInfo, key, styleReq) }],
      temperature: (cfg.temperature != null ? cfg.temperature : 0.8),
      max_tokens: 2000
    };
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, (cfg.timeout || 90) * 1000);
    var resp;
    try {
      resp = await fetch(url, {
        method: "POST",
        headers: { "Authorization": "Bearer " + cfg.api_key, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: ctrl.signal
      });
    } catch (e) {
      clearTimeout(timer);
      if (e && e.name === "AbortError") throw new Error("请求超时（" + (cfg.timeout || 90) + " 秒）。请检查网络。");
      throw new Error("网络/跨域请求失败：" + (e && e.message ? e.message : e) +
        "\n若浏览器拦截跨域(CORS)，可改用「下载单机完整版」在本地用 AI。");
    }
    clearTimeout(timer);
    var raw = await resp.text();
    if (!resp.ok) throw new Error("接口返回错误 HTTP " + resp.status + "：" + raw.slice(0, 300));
    var payload;
    try { payload = JSON.parse(raw); } catch (e) { throw new Error("接口返回内容无法解析：\n" + raw.slice(0, 300)); }
    try { return (payload.choices[0].message.content || "").trim(); }
    catch (e) { throw new Error("接口返回结构异常：\n" + raw.slice(0, 300)); }
  }

  async function callSectionWithRetry(cfg, productInfo, key, styleReq, maxRetry) {
    maxRetry = maxRetry || 5;
    var last = "";
    for (var i = 0; i < maxRetry; i++) {
      try {
        var c = await callSection(cfg, productInfo, key, styleReq);
        c = String(c || "").trim();
        // 去掉可能残留的段标题
        c = c.replace(/^=+\s*[^=\n]+?\s*=+\s*/, "").replace(/^【\s*[^】]+?\s*】\s*/, "").trim();
        if (c.length >= 20) return c;
        last = c;
      } catch (e) { last = e && e.message ? e.message : String(e); }
      await new Promise(function (r) { setTimeout(r, 1200 + i * 1200); });
    }
    return last;
  }

  // 调用模型（整段，保留备用于润色/兼容）
  async function callModel(cfg, productInfo, styleReq) {
    if (!cfg.api_key) {
      throw new Error("尚未配置 API 密钥。请点右上角「⚙ 设置」填写并保存密钥。");
    }
    var url = cfg.api_url || DEFAULT_AI.api_url;
    var body = {
      model: cfg.model || "deepseek-chat",
      messages: [{ role: "user", content: buildPrompt(productInfo, styleReq) }],
      temperature: (cfg.temperature != null ? cfg.temperature : 0.7)
    };
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, (cfg.timeout || 90) * 1000);
    var resp;
    try {
      resp = await fetch(url, {
        method: "POST",
        headers: {
          "Authorization": "Bearer " + cfg.api_key,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(body),
        signal: ctrl.signal
      });
    } catch (e) {
      clearTimeout(timer);
      if (e && e.name === "AbortError") throw new Error("请求超时（" + (cfg.timeout || 90) + " 秒）。请检查网络。");
      throw new Error("网络/跨域请求失败：" + (e && e.message ? e.message : e) +
        "\n若浏览器拦截跨域(CORS)，可改用「下载单机完整版」在本地用 AI。");
    }
    clearTimeout(timer);
    var raw = await resp.text();
    if (!resp.ok) {
      throw new Error("接口返回错误 HTTP " + resp.status + "：" + raw.slice(0, 300));
    }
    var payload;
    try { payload = JSON.parse(raw); }
    catch (e) { throw new Error("接口返回内容无法解析：\n" + raw.slice(0, 300)); }
    try {
      return payload.choices[0].message.content;
    } catch (e) {
      throw new Error("接口返回结构异常：\n" + raw.slice(0, 300));
    }
  }

  // ---- 智能润色 ----
  function buildPolishPrompt(original, style) {
    var hasSpecial = !!(style && String(style).trim());
    var special = hasSpecial ? String(style).trim() : "";
    return "你是资深的制造企业营销文案编辑，请对下面这段【原文案】进行智能润色改写。\n\n" +
      "【润色规则（必须严格遵守）】\n" +
      "1. 基础输出规则：若用户仅提供原文、无特殊格式要求，默认直接输出完整的润色后全文，" +
      "不额外添加“润色说明”“修改对比”“前言后语”等无关内容。\n" +
      "2. 格式保留规则：完全保留原文的段落结构、换行、分级标题、列表、加粗、斜体等排版格式，" +
      "不得擅自调整原文的排版结构。\n" +
      "3. 质量达标标准（须同时满足）：\n" +
      "   • 核心信息零偏差，与原文立意、核心观点、关键数据完全一致；\n" +
      "   • 表达地道自然，完全符合中文母语者的写作习惯，无 AI 机械感与生硬感；\n" +
      "   • 行文流畅顺滑，逻辑连贯，过渡自然，无逻辑断层与生硬衔接；\n" +
      "   • 无错别字、语病、标点错误，表达规范严谨；\n" +
      "   • 完美贴合原文的文体与语气，适配目标受众的阅读习惯。\n" +
      "4. 特殊需求适配规则：若用户明确提出特殊需求（见下），优先按照用户的要求输出对应内容。\n" +
      "5. 适度润色原则：润色以“自然、地道、去 AI 化、人性化”为核心，不得过度炫技、过度修改，" +
      "不得添加与原文无关的个人观点或额外内容，不得大幅改变原文的篇幅比例。\n" +
      "6. 用户需求优先原则：若用户附带了特殊润色要求（如仅精简、仅调整语气、仅修正语病、" +
      "提供修改对比等），必须优先执行用户的特殊要求，再匹配本提示词的基础规则。\n" +
      COMMON_RULES + "\n" +
      (hasSpecial
        ? ("\n【用户的特殊需求（最高优先级，务必满足）】\n" + special + "\n")
        : "\n（用户无特殊需求，按基础输出规则：只输出润色后的完整全文。）\n") +
      "\n【原文案】\n" + String(original).trim();
  }

  async function callPolish(cfg, original, style) {
    if (!cfg.api_key) {
      throw new Error("尚未配置 API 密钥。请点右上角「⚙ 设置」填写并保存密钥。");
    }
    var url = cfg.api_url || DEFAULT_AI.api_url;
    var body = {
      model: cfg.model || "deepseek-chat",
      messages: [{ role: "user", content: buildPolishPrompt(original, style) }],
      temperature: (cfg.temperature != null ? cfg.temperature : 0.7)
    };
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, (cfg.timeout || 90) * 1000);
    var resp;
    try {
      resp = await fetch(url, {
        method: "POST",
        headers: { "Authorization": "Bearer " + cfg.api_key, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: ctrl.signal
      });
    } catch (e) {
      clearTimeout(timer);
      if (e && e.name === "AbortError") throw new Error("请求超时（" + (cfg.timeout || 90) + " 秒）。请检查网络。");
      throw new Error("网络/跨域请求失败：" + (e && e.message ? e.message : e) +
        "\n若浏览器拦截跨域(CORS)，可改用「下载单机完整版」在本地用 AI。");
    }
    clearTimeout(timer);
    var raw = await resp.text();
    if (!resp.ok) throw new Error("接口返回错误 HTTP " + resp.status + "：" + raw.slice(0, 300));
    var payload;
    try { payload = JSON.parse(raw); } catch (e) { throw new Error("接口返回内容无法解析：\n" + raw.slice(0, 300)); }
    try { return payload.choices[0].message.content; }
    catch (e) { throw new Error("接口返回结构异常：\n" + raw.slice(0, 300)); }
  }

  // ============================================================
  // Excel(xlsx) / CSV 读取：纯前端，无外部库
  //   xlsx = zip，用浏览器原生 DecompressionStream('deflate-raw') 解压
  // ============================================================
  async function readFileRecords(file) {
    var name = (file.name || "").toLowerCase();
    if (name.endsWith(".csv")) {
      var txt = await readAsText(file, "GBK") ;  // 先试 GBK
      var rows = parseCSV(txt);
      return rowsToRecords(rows);
    }
    // xlsx
    var buf = await file.arrayBuffer();
    var rows = await parseXlsx(buf);
    return rowsToRecords(rows);
  }

  function readAsText(file, enc) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () {
        var txt = fr.result;
        // 若含替换符（解码失败），改试 UTF-8
        if (txt.indexOf("\uFFFD") >= 0 && enc !== "UTF-8") {
          var fr2 = new FileReader();
          fr2.onload = function () { resolve(fr2.result); };
          fr2.onerror = reject;
          fr2.readAsText(file, "UTF-8");
        } else resolve(txt);
      };
      fr.onerror = reject;
      fr.readAsText(file, enc);
    });
  }

  // 简易 CSV 解析（支持引号包裹、逗号、换行）
  function parseCSV(text) {
    var rows = [], cur = [], field = "", inQ = false, i = 0;
    text = text.replace(/^\uFEFF/, "");
    while (i < text.length) {
      var ch = text[i];
      if (inQ) {
        if (ch === '"') {
          if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
          inQ = false; i++; continue;
        }
        field += ch; i++; continue;
      }
      if (ch === '"') { inQ = true; i++; continue; }
      if (ch === ",") { cur.push(field); field = ""; i++; continue; }
      if (ch === "\r") { i++; continue; }
      if (ch === "\n") { cur.push(field); rows.push(cur); cur = []; field = ""; i++; continue; }
      field += ch; i++;
    }
    if (field !== "" || cur.length) { cur.push(field); rows.push(cur); }
    return rows;
  }

  // 读取 zip 内所有条目（返回 name->Uint8Array），支持 store(0) 与 deflate(8)
  async function unzip(buf) {
    var view = new DataView(buf);
    var u8 = new Uint8Array(buf);
    // 找 End Of Central Directory (EOCD) 签名 0x06054b50，从尾部往前
    var eocd = -1;
    for (var i = buf.byteLength - 22; i >= 0; i--) {
      if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error("不是有效的 xlsx（zip）文件");
    var cdOffset = view.getUint32(eocd + 16, true);
    var cdCount = view.getUint16(eocd + 10, true);
    var entries = {};
    var p = cdOffset;
    for (var n = 0; n < cdCount; n++) {
      if (view.getUint32(p, true) !== 0x02014b50) break;
      var method = view.getUint16(p + 10, true);
      var compSize = view.getUint32(p + 20, true);
      var nameLen = view.getUint16(p + 28, true);
      var extraLen = view.getUint16(p + 30, true);
      var commLen = view.getUint16(p + 32, true);
      var localOff = view.getUint32(p + 42, true);
      var nameBytes = u8.subarray(p + 46, p + 46 + nameLen);
      var fname = utf8Decode(nameBytes);
      // 读 local header 得到数据起点
      var lnameLen = view.getUint16(localOff + 26, true);
      var lextraLen = view.getUint16(localOff + 28, true);
      var dataStart = localOff + 30 + lnameLen + lextraLen;
      var comp = u8.subarray(dataStart, dataStart + compSize);
      var data;
      if (method === 0) {
        data = comp;
      } else if (method === 8) {
        data = await inflateRaw(comp);
      } else {
        data = null;
      }
      entries[fname] = data;
      p += 46 + nameLen + extraLen + commLen;
    }
    return entries;
  }

  function utf8Decode(bytes) {
    try { return new TextDecoder("utf-8").decode(bytes); }
    catch (e) { var s = ""; for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]); return s; }
  }

  async function inflateRaw(bytes) {
    if (typeof DecompressionStream === "undefined") {
      throw new Error("当前浏览器不支持解压 xlsx，请改用 CSV 导入，或换用新版 Chrome/Edge 浏览器。");
    }
    var ds = new DecompressionStream("deflate-raw");
    var stream = new Blob([bytes]).stream().pipeThrough(ds);
    var ab = await new Response(stream).arrayBuffer();
    return new Uint8Array(ab);
  }

  async function parseXlsx(buf) {
    var entries = await unzip(buf);
    var dec = new TextDecoder("utf-8");
    // sharedStrings
    var shared = [];
    if (entries["xl/sharedStrings.xml"]) {
      var ssXml = dec.decode(entries["xl/sharedStrings.xml"]);
      var siRe = /<si\b[^>]*>([\s\S]*?)<\/si>/g, m;
      while ((m = siRe.exec(ssXml))) {
        var inner = m[1];
        var tRe = /<t\b[^>]*>([\s\S]*?)<\/t>/g, tm, txt = "";
        while ((tm = tRe.exec(inner))) txt += tm[1];
        shared.push(xmlUnescape(txt));
      }
    }
    // 第一张 sheet
    var sheetKey = null;
    for (var k in entries) {
      if (/^xl\/worksheets\/sheet\d+\.xml$/.test(k)) { sheetKey = k; break; }
    }
    if (!sheetKey) throw new Error("xlsx 中未找到工作表");
    var sheetXml = dec.decode(entries[sheetKey]);
    var rows = [];
    var rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>/g, rm;
    while ((rm = rowRe.exec(sheetXml))) {
      var rowInner = rm[1];
      var cells = [];
      var cRe = /<c\b([^>]*)\/>|<c\b([^>]*)>([\s\S]*?)<\/c>/g, cm;
      while ((cm = cRe.exec(rowInner))) {
        var attrs = cm[1] || cm[2] || "";
        var body = cm[3] || "";
        var refM = attrs.match(/r="([A-Z]+)\d+"/);
        var col = refM ? colToIndex(refM[1]) : cells.length;
        var tM = attrs.match(/t="([^"]+)"/);
        var type = tM ? tM[1] : "";
        var val = "";
        if (type === "inlineStr") {
          var itRe = /<t\b[^>]*>([\s\S]*?)<\/t>/g, im, itxt = "";
          while ((im = itRe.exec(body))) itxt += im[1];
          val = xmlUnescape(itxt);
        } else {
          var vM = body.match(/<v\b[^>]*>([\s\S]*?)<\/v>/);
          if (vM) {
            if (type === "s") {
              var idx = parseInt(vM[1], 10);
              val = shared[idx] != null ? shared[idx] : "";
            } else {
              val = xmlUnescape(vM[1]);
            }
          }
        }
        cells[col] = val;
      }
      var arr = [];
      for (var i2 = 0; i2 < cells.length; i2++) arr.push(cells[i2] != null ? cells[i2] : "");
      rows.push(arr);
    }
    return rows;
  }

  function colToIndex(letters) {
    var n = 0;
    for (var i = 0; i < letters.length; i++) n = n * 26 + (letters.charCodeAt(i) - 64);
    return n - 1;
  }
  function xmlUnescape(s) {
    return String(s).replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
  }

  // 二维表 -> 记录数组（找「产品编号」类表头）
  function rowsToRecords(rows) {
    if (!rows || !rows.length) return { records: [], idKey: null, error: "文件为空" };
    var header = rows[0].map(function (s) { return String(s || "").trim(); });
    var idAliases = ["产品编号", "编号", "产品编号/型号", "型号", "产品型号", "ID", "id"];
    var idKey = null;
    for (var i = 0; i < header.length; i++) {
      if (idAliases.indexOf(header[i]) >= 0) { idKey = header[i]; break; }
    }
    if (!idKey) return { records: [], idKey: null, error: "缺少「产品编号」列，请检查第一行表头（列名如：产品编号 / 编号 / 型号）" };
    var records = [];
    for (var r = 1; r < rows.length; r++) {
      var row = rows[r];
      if (!row || row.every(function (c) { return String(c || "").trim() === ""; })) continue; // 跳过空行
      var rec = {};
      for (var c = 0; c < header.length; c++) {
        var h = header[c];
        if (!h) continue;
        rec[h] = row[c] != null ? String(row[c]).trim() : "";
      }
      records.push(rec);
    }
    return { records: records, idKey: idKey, error: null };
  }

  // ============================================================
  // 应用状态与界面交互
  // ============================================================
  var state = {
    templates: loadTemplates(),
    records: [],
    idKey: null,
    current: null,
    curVersions: {},        // 当前行业的三版工作副本
    activeIndustry: "",
    outSections: {},
    curOutTab: SECTION_KEYS[0],
    mode: "basic",          // basic | pro
    ai: loadAIConfig(),
    generating: false
  };

  // ---- 顶栏提示 ----
  function setHint(msg) { $("hint").textContent = msg; }
  function setProdHint(msg) { $("prodHint").textContent = msg; }

  // ---- 复制（兼容 http / file / 老浏览器）----
  function copyText(text) {
    if (!text) return Promise.resolve(false);
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text).then(function () { return true; })
        .catch(function () { return fallbackCopy(text); });
    }
    return Promise.resolve(fallbackCopy(text));
  }
  function fallbackCopy(text) {
    try {
      var ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed"; ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      var ok = document.execCommand("copy");
      document.body.removeChild(ta);
      return ok;
    } catch (e) { return false; }
  }

  // ---- 标签页切换 ----
  function initTabs() {
    var btns = document.querySelectorAll(".tab-btn");
    btns.forEach(function (b) {
      b.addEventListener("click", function () {
        btns.forEach(function (x) { x.classList.remove("active"); });
        b.classList.add("active");
        document.querySelectorAll(".panel").forEach(function (p) { p.classList.remove("active"); });
        $("tab-" + b.getAttribute("data-tab")).classList.add("active");
      });
    });
  }

  // ---- 生成文案 ----
  // ---- 智能参数识别 ----
  var PF_KEYS = ["product", "material", "spec", "precision", "cert", "delivery", "scene"];
  var PF_LABELS = { product: "产品名称", material: "材质", spec: "规格尺寸", precision: "加工精度", cert: "认证", delivery: "交期", scene: "适用场景" };
  var smartExtractTimer = null;
  var smartDidExtract = false;

  function collectSmartFields() {
    var f = {};
    PF_KEYS.forEach(function (k) {
      var el = document.querySelector('[data-pf="' + k + '"]');
      f[k] = el ? el.value.trim() : "";
    });
    return f;
  }

  function fillSmartFields(fields) {
    PF_KEYS.forEach(function (k) {
      var el = document.querySelector('[data-pf="' + k + '"]');
      if (el) el.value = fields[k] || "";
    });
  }

  function updateSmartState(fields) {
    var badge = $("smartParamBadge");
    var tipsEl = $("smartTips");
    if (!window.ParamParser) return;
    var tips = window.ParamParser.validate(fields);
    var filledCount = PF_KEYS.filter(function (k) { return (fields[k] || "").trim(); }).length;
    // 标记缺失字段
    PF_KEYS.forEach(function (k) {
      var el = document.querySelector('[data-pf="' + k + '"]');
      if (el) { if (!(fields[k] || "").trim()) el.classList.add("miss"); else el.classList.remove("miss"); }
    });
    if (badge) {
      if (filledCount === 0) { badge.textContent = "未识别到参数"; badge.className = "smart-badge"; }
      else if (tips.length) { badge.textContent = "已识别 " + filledCount + " 项"; badge.className = "smart-badge warn"; }
      else { badge.textContent = "参数完整 ✓"; badge.className = "smart-badge ok"; }
    }
    if (tipsEl) {
      if (filledCount > 0 && tips.length) {
        tipsEl.style.display = "";
        tipsEl.innerHTML = "⚠️ 参数不够完整，补充后文案更专业：<ul>" + tips.map(function (t) { return "<li>" + t + "</li>"; }).join("") + "</ul>";
      } else {
        tipsEl.style.display = "none"; tipsEl.innerHTML = "";
      }
    }
    $("btnSmartContinue").style.display = (filledCount > 0 && tips.length) ? "" : "none";
    // 有识别结果就自动展开
    if (filledCount > 0) {
      $("smartParamBody").style.display = "";
      $("smartParamArrow").classList.add("open");
    }
  }

  function runSmartExtract(force) {
    if (!window.ParamParser) return;
    var text = $("inputText").value.trim();
    if (!text) { updateSmartState({ product: "", material: "", spec: "", precision: "", cert: "", delivery: "", scene: "" }); return; }
    // 若用户已手动改过表单且非强制，不覆盖用户编辑
    var fields = window.ParamParser.extract(text);
    var cur = collectSmartFields();
    var userEdited = PF_KEYS.some(function (k) { return (cur[k] || "").trim() && (cur[k] || "").trim() !== (window.__lastExtract && window.__lastExtract[k] || ""); });
    if (!force && userEdited) { updateSmartState(cur); return; }
    fillSmartFields(fields);
    window.__lastExtract = fields;
    smartDidExtract = true;
    updateSmartState(fields);
  }

  // 生成时实际用的文本：若智能表单有内容，则按表单（结构化），否则用原始输入框
  function resolveGenText() {
    var fields = collectSmartFields();
    var any = PF_KEYS.some(function (k) { return (fields[k] || "").trim(); });
    if (any && window.ParamParser) return window.ParamParser.toText(fields);
    return $("inputText").value.trim();
  }

  function doGenerate(text) {
    text = (text || "").trim();
    if (!text) { alert("请先补充参数或输入产品说明。"); return; }
    if (state.mode === "pro") {
      generatePro(text);
    } else {
      var secs = renderBasicSections(text, state.templates);
      showSections(secs);
      setHint("生成完成 ✓ " + new Date().toLocaleTimeString());
    }
  }

  function initGenerate() {
    // 智能参数：折叠开关
    var spHead = $("smartParamHead");
    if (spHead) {
      spHead.addEventListener("click", function () {
        var body = $("smartParamBody"), arrow = $("smartParamArrow");
        var open = body.style.display !== "none";
        body.style.display = open ? "none" : "";
        arrow.classList.toggle("open", !open);
      });
    }
    // 输入变化 -> 防抖自动识别
    var inputEl = $("inputText");
    if (inputEl) {
      inputEl.addEventListener("input", function () {
        clearTimeout(smartExtractTimer);
        smartExtractTimer = setTimeout(function () { runSmartExtract(false); }, 500);
      });
    }
    var reBtn = $("btnSmartReextract");
    if (reBtn) reBtn.addEventListener("click", function () { runSmartExtract(true); setHint("已按当前输入重新识别参数"); });
    // 表单字段改动 -> 更新校验
    document.querySelectorAll('[data-pf]').forEach(function (el) {
      el.addEventListener("input", function () { updateSmartState(collectSmartFields()); });
    });
    var contBtn = $("btnSmartContinue");
    if (contBtn) contBtn.addEventListener("click", function () {
      var t = resolveGenText();
      if (!t) { alert("请先补充参数或输入产品说明。"); return; }
      doGenerate(t);
    });

    // 输出区标签
    var outTabs = $("outTabs");
    SECTION_KEYS.forEach(function (k, i) {
      var btn = document.createElement("button");
      btn.className = "out-tab" + (i === 0 ? " active" : "");
      btn.textContent = k;
      btn.addEventListener("click", function () {
        state.curOutTab = k;
        document.querySelectorAll(".out-tab").forEach(function (x) { x.classList.remove("active"); });
        btn.classList.add("active");
        renderOutContent();
      });
      outTabs.appendChild(btn);
    });

    $("btnGenerate").addEventListener("click", function () {
      if (state.generating) return;
      // 先做一次识别（若还没识别过）
      if (!smartDidExtract) runSmartExtract(false);
      var fields = collectSmartFields();
      var anyField = PF_KEYS.some(function (k) { return (fields[k] || "").trim(); });
      var raw = $("inputText").value.trim();
      if (!raw && !anyField) { alert("请先粘贴或输入产品参数/产品说明。"); return; }

      // 缺失校验：识别到部分参数但有缺项时，提示并让用户选择“仍然继续”
      if (anyField && window.ParamParser) {
        var tips = window.ParamParser.validate(fields);
        if (tips.length) {
          $("smartParamBody").style.display = "";
          $("smartParamArrow").classList.add("open");
          $("btnSmartContinue").style.display = "";
          updateSmartState(fields);
          setHint("参数不够完整，可补充后再生成，或点「仍然继续生成」。");
          return;
        }
      }
      doGenerate(resolveGenText());
    });

    $("btnClear").addEventListener("click", function () {
      $("inputText").value = "";
      $("outText").value = "";
      state.outSections = {};
      setHint("已清空");
    });

    $("btnCopyOne").addEventListener("click", function () {
      var t = (state.outSections[state.curOutTab] || "").trim();
      if (!t) { setHint("本栏暂无内容"); return; }
      copyText(t).then(function (ok) { setHint(ok ? "已复制「" + state.curOutTab + "」" : "复制失败，请手动选择复制"); });
    });

    $("btnCopyAll").addEventListener("click", function () {
      var all = composeAll();
      if (!all.trim()) { setHint("还没有生成内容"); return; }
      copyText(all).then(function (ok) { setHint(ok ? "已复制全部文案" : "复制失败，请手动选择复制"); });
    });

    $("btnExportTxt").addEventListener("click", function () {
      var all = composeAll();
      if (!all.trim()) { alert("还没有生成内容。"); return; }
      var blob = new Blob([all], { type: "text/plain;charset=utf-8" });
      downloadBlob(blob, "产品文案_" + tsName() + ".txt");
      setHint("已导出 TXT");
    });

    // ---- 智能润色 ----
    var btnPolishToggle = $("btnPolishToggle");
    if (btnPolishToggle) {
      btnPolishToggle.addEventListener("click", function () {
        var p = $("polishPanel");
        var on = p.style.display === "none" || !p.style.display;
        p.style.display = on ? "block" : "none";
        if (on) $("polishInput").focus();
      });
    }
    var btnPolishRun = $("btnPolishRun");
    if (btnPolishRun) {
      btnPolishRun.addEventListener("click", async function () {
        var src = $("polishInput").value.trim();
        if (!src) { alert("请先粘贴要润色的原文案。"); return; }
        if (!state.ai.api_key) {
          setHint("智能润色需要先配置 API 密钥");
          openSettings(true);
          return;
        }
        var sty = $("polishStyle") ? $("polishStyle").value.trim() : "";
        var old = btnPolishRun.textContent;
        btnPolishRun.disabled = true; btnPolishRun.textContent = "润色中……";
        setHint("正在润色，请稍候……");
        try {
          var out = await callPolish(state.ai, src, sty);
          var pr = { text: out || "", hits: [] };
          if (window.Compliance) pr = window.Compliance.sanitize(out || "");
          $("polishOutput").value = (pr.text || "").trim();
          var pn = (pr.hits && pr.hits.length) ? "；已自动合规替换 " + pr.hits.length + " 处绝对化用语" : "";
          setHint("润色完成 ✓ " + new Date().toLocaleTimeString() + pn);
        } catch (e) {
          setHint("润色失败");
          alert("润色失败：\n" + (e && e.message ? e.message : e));
        } finally {
          btnPolishRun.disabled = false; btnPolishRun.textContent = old;
        }
      });
    }
    var btnPolishCopy = $("btnPolishCopy");
    if (btnPolishCopy) {
      btnPolishCopy.addEventListener("click", function () {
        var t = $("polishOutput").value.trim();
        if (!t) { setHint("暂无可复制的润色结果"); return; }
        copyText(t).then(function (ok) { setHint(ok ? "已复制润色结果" : "复制失败，请手动选择复制"); });
      });
    }
  }

  function renderOutContent() {
    $("outText").value = state.outSections[state.curOutTab] || "";
  }

  // 统一把六段结果展示出来（基础款/升级款共用）
  function showSections(secs) {
    state.outSections = secs || {};
    state.curOutTab = SECTION_KEYS[0];
    document.querySelectorAll(".out-tab").forEach(function (x, i) {
      x.classList.toggle("active", i === 0);
    });
    renderOutContent();
  }

  // 升级款：调用模型生成
  async function generatePro(text) {
    if (!state.ai.api_key) {
      setHint("升级款需要先配置 API 密钥");
      openSettings(true);
      return;
    }
    state.generating = true;
    var btn = $("btnGenerate");
    var oldLabel = btn.textContent;
    btn.disabled = true; btn.textContent = "🤖 AI 生成中……（请稍候）";
    setHint("正在分段请求大模型（6 段并行），请稍候……");
    var styleEl = $("styleReq");
    var styleReq = styleEl ? styleEl.value.trim() : "";
    try {
      // 6 段并行生成（每段独立调用，避免长输出被截断）
      var jobs = SECTION_KEYS.map(function (k) {
        return callSectionWithRetry(state.ai, text, k, styleReq).then(function (c) { return { k: k, c: c }; });
      });
      var done = await Promise.all(jobs);
      var secs = {};
      var replacedTotal = [];
      done.forEach(function (d) {
        var s = d.c;
        if (window.Compliance) {
          var r = window.Compliance.sanitize(s);
          s = r.text;
          if (r.hits && r.hits.length) r.hits.forEach(function (h) { replacedTotal.push(h.word); });
        }
        secs[d.k] = s;
      });
      showSections(secs);
      var empty = SECTION_KEYS.filter(function (k) { return !(secs[k] || "").trim(); });
      var notice = "";
      if (replacedTotal.length) {
        notice = "；已自动合规替换 " + replacedTotal.length + " 处绝对化用语（" + Array.from(new Set(replacedTotal)).join("、") + "）";
      }
      if (empty.length) {
        setHint("AI 生成完成，但以下段为空：" + empty.join("、") + "（可重试）" + notice);
      } else {
        setHint("AI 生成完成 ✓ " + new Date().toLocaleTimeString() + notice);
      }
    } catch (e) {
      setHint("生成失败");
      alert("生成失败：\n" + (e && e.message ? e.message : e));
    } finally {
      state.generating = false;
      btn.disabled = false; btn.textContent = oldLabel;
    }
  }

  function composeAll() {
    var blocks = [];
    SECTION_KEYS.forEach(function (k) {
      blocks.push("【" + k + "】\n" + ((state.outSections[k] || "").trim()));
    });
    return blocks.join("\n\n");
  }
  function tsName() {
    var d = new Date(), p = function (n) { return (n < 10 ? "0" : "") + n; };
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + "_" + p(d.getHours()) + p(d.getMinutes());
  }
  function downloadBlob(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    setTimeout(function () { document.body.removeChild(a); URL.revokeObjectURL(url); }, 100);
  }

  // ---- UTF-8 BOM 导出的 JSON/TXT 助手 ----
  function downloadText(text, filename, mime) {
    var blob = new Blob(["\uFEFF" + text], { type: (mime || "text/plain") + ";charset=utf-8" });
    downloadBlob(blob, filename);
  }

  // ============================================================
  // 产品资料查询
  // ============================================================
  function loadProductsFromStore() {
    try {
      var raw = localStorage.getItem(LS_KEY_PROD);
      if (raw) {
        var d = JSON.parse(raw);
        if (d && Array.isArray(d.records)) { state.records = d.records; state.idKey = d.idKey; return; }
      }
    } catch (e) { /* ignore */ }
    state.records = []; state.idKey = null;
  }
  function saveProductsToStore() {
    try {
      localStorage.setItem(LS_KEY_PROD, JSON.stringify({ records: state.records, idKey: state.idKey }));
    } catch (e) { alert("保存产品库失败（可能超出浏览器存储上限）：" + e.message); }
  }

  function normalizeId(rec) { return String(rec[state.idKey] != null ? rec[state.idKey] : "").trim().toLowerCase().replace(/\s/g, ""); }

  function searchProducts(keyword) {
    var key = String(keyword || "").trim().toLowerCase().replace(/\s/g, "");
    if (!key) return { exact: [], fuzzy: [] };
    var exact = [], fuzzy = [];
    state.records.forEach(function (rec) {
      var rid = normalizeId(rec);
      if (rid === key) exact.push(rec);
      else if (rid.indexOf(key) >= 0) fuzzy.push(rec);
    });
    return { exact: exact, fuzzy: fuzzy };
  }

  // 表格渲染（分批，防大表卡顿）
  var treeOrder = []; // 当前显示顺序（记录引用数组）
  function refreshProductTable(priority) {
    var tbody = $("prodTbody");
    tbody.innerHTML = "";
    var base = state.records.slice();
    var ordered;
    if (priority && priority.length) {
      var priSet = new Set(priority);
      ordered = priority.slice();
      base.forEach(function (r) { if (!priSet.has(r)) ordered.push(r); });
    } else {
      ordered = base;
    }
    treeOrder = ordered;
    // 分批插入
    var idx = 0, BATCH = 200;
    function step() {
      var frag = document.createDocumentFragment();
      var end = Math.min(idx + BATCH, ordered.length);
      for (; idx < end; idx++) {
        var rec = ordered[idx];
        var tr = document.createElement("tr");
        tr.dataset.idx = idx;
        tr.innerHTML = "<td>" + escHtml(rec[state.idKey] || "") + "</td>" +
          "<td>" + escHtml(rec["产品名称"] || "") + "</td>" +
          "<td>" + escHtml(rec["行业品类"] || "") + "</td>" +
          "<td>" + escHtml(rec["材质"] || "") + "</td>";
        (function (rec) {
          tr.addEventListener("click", function () { selectRow(tr, rec); });
        })(rec);
        frag.appendChild(tr);
      }
      tbody.appendChild(frag);
      if (idx < ordered.length) requestAnimationFrame(step);
    }
    step();
  }

  function selectRow(tr, rec) {
    document.querySelectorAll(".prod-table tbody tr").forEach(function (x) { x.classList.remove("sel"); });
    tr.classList.add("sel");
    showRecord(rec);
  }

  function showRecord(rec) {
    state.current = rec;
    var lines = [];
    PRODUCT_FIELDS.forEach(function (f) {
      if (rec[f]) lines.push(f + "：" + rec[f]);
    });
    for (var k in rec) {
      if (PRODUCT_FIELDS.indexOf(k) >= 0) continue;
      if (rec[k]) lines.push(k + "：" + rec[k]);
    }
    $("prodDetail").value = lines.join("\n") || "（该记录无详细字段）";
    ["btnProdFill", "btnProdGen", "btnProdEdit", "btnProdDel"].forEach(function (id) { $(id).disabled = false; });
  }
  function disableProdActions() {
    ["btnProdFill", "btnProdGen", "btnProdEdit", "btnProdDel"].forEach(function (id) { $(id).disabled = true; });
  }

  function clearCandidates() { $("candBox").style.display = "none"; $("candList").innerHTML = ""; }

  function doSearch() {
    var kw = $("prodKeyword").value.trim();
    if (!kw) { setProdHint("请输入产品编号"); return; }
    if (!state.records.length) { setProdHint("资料库为空，请先导入资料"); return; }
    var r = searchProducts(kw);
    clearCandidates();
    if (r.exact.length) {
      showRecord(r.exact[0]);
      refreshProductTable(r.exact);
      var msg = r.exact.length > 1
        ? ("✓ 共查到 " + r.exact.length + " 条编号为「" + kw + "」的产品（编号重复），已置顶；下方详情为第 1 条。")
        : ("✓ 找到产品：" + (r.exact[0][state.idKey] || ""));
      setProdHint(msg);
    } else if (r.fuzzy.length) {
      state.current = null; disableProdActions();
      $("prodDetail").value = "未找到完全一致的编号，下面可能是你要找的产品，请点击选择：";
      $("candBox").style.display = "block";
      $("candList").innerHTML = "";
      r.fuzzy.forEach(function (rec) {
        var tag = rec["行业品类"] || "";
        var label = (rec[state.idKey] || "") + "  |  " + (rec["产品名称"] || "") + (tag ? ("  〔" + tag + "〕") : "");
        var item = document.createElement("div");
        item.className = "cand-item";
        item.textContent = label;
        item.addEventListener("click", function () { showRecord(rec); setProdHint("已选择：" + (rec[state.idKey] || "")); });
        $("candList").appendChild(item);
      });
      refreshProductTable(r.fuzzy);
      setProdHint("未找到编号「" + kw + "」，是否输错了？共 " + r.fuzzy.length + " 个相近结果（已置顶）。");
    } else {
      state.current = null; disableProdActions();
      refreshProductTable(null);
      $("prodDetail").value = "未找到产品编号「" + kw + "」（共 0 条匹配）。\n请检查编号是否输入正确，或先导入资料。";
      setProdHint("✗ 未找到「" + kw + "」，共 0 条匹配。");
    }
  }

  function initProduct() {
    loadProductsFromStore();
    refreshProductTable(null);
    $("prodKeyword").addEventListener("keydown", function (e) { if (e.key === "Enter") doSearch(); });
    $("btnProdSearch").addEventListener("click", doSearch);
    $("btnProdReload").addEventListener("click", function () {
      loadProductsFromStore(); refreshProductTable(null);
      setProdHint("已重新加载：共 " + state.records.length + " 条产品");
    });
    $("btnProdImport").addEventListener("click", function () { $("prodFile").click(); });
    $("prodFile").addEventListener("change", function (e) {
      var file = e.target.files[0];
      if (!file) return;
      setProdHint("正在读取文件……");
      readFileRecords(file).then(function (res) {
        if (res.error) { alert("导入失败：" + res.error); setProdHint("导入失败"); return; }
        if (!res.records.length) { alert("文件中没有数据行。"); setProdHint("导入失败"); return; }
        state.records = res.records; state.idKey = res.idKey;
        refreshProductTable(null);
        var ask = confirm("导入成功，共 " + res.records.length + " 条产品（编号列：" + res.idKey + "）。\n\n是否保存到本浏览器（供下次打开继续用）？\n选“取消”则仅本次使用。");
        if (ask) { saveProductsToStore(); setProdHint("✓ 已导入并保存 " + res.records.length + " 条产品"); }
        else { setProdHint("✓ 已导入 " + res.records.length + " 条（仅本次，未保存）"); }
      }).catch(function (err) {
        alert("读取文件失败：" + err.message);
        setProdHint("读取失败");
      });
      e.target.value = "";
    });

    $("btnProdFill").addEventListener("click", function () {
      if (!state.current) return;
      $("inputText").value = productToText(state.current);
      switchTab("gen");
      setHint("已填入产品资料，可直接生成文案");
    });
    $("btnProdGen").addEventListener("click", function () {
      if (!state.current) return;
      $("inputText").value = productToText(state.current);
      switchTab("gen");
      $("btnGenerate").click();
    });
    $("btnProdEdit").addEventListener("click", function () { editCurrent(); });
    $("btnProdDel").addEventListener("click", function () { deleteCurrent(); });
  }

  function editCurrent() {
    if (!state.current) return;
    var rec = state.current;
    // 用逐字段 prompt 简化（纯静态环境无丰富对话框，这里用简单表单弹层）
    openFieldEditor(rec);
  }

  function openFieldEditor(rec) {
    var fields = Object.keys(rec);
    var overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    var box = document.createElement("div");
    box.className = "modal-box";
    var h = document.createElement("h3"); h.textContent = "编辑产品"; box.appendChild(h);
    var inputs = {};
    fields.forEach(function (f) {
      var lab = document.createElement("label"); lab.className = "modal-lbl"; lab.textContent = f;
      var inp = document.createElement("input");
      inp.type = "text"; inp.value = rec[f] || ""; inp.className = "modal-input";
      inputs[f] = inp;
      box.appendChild(lab); box.appendChild(inp);
    });
    var bar = document.createElement("div"); bar.className = "modal-bar";
    var ok = document.createElement("button"); ok.className = "btn btn-primary"; ok.textContent = "保存";
    var cancel = document.createElement("button"); cancel.className = "btn btn-ghost"; cancel.textContent = "取消";
    bar.appendChild(ok); bar.appendChild(cancel); box.appendChild(bar);
    overlay.appendChild(box); document.body.appendChild(overlay);
    cancel.addEventListener("click", function () { document.body.removeChild(overlay); });
    ok.addEventListener("click", function () {
      var newRec = {};
      fields.forEach(function (f) { newRec[f] = inputs[f].value.trim(); });
      // 编号唯一性校验（排除自身）
      if (state.idKey) {
        var nid = (newRec[state.idKey] || "").trim();
        if (!nid) { alert("产品编号不能为空。"); return; }
        for (var i = 0; i < state.records.length; i++) {
          var r = state.records[i];
          if (r === rec) continue;
          if (String(r[state.idKey] || "").trim().toLowerCase() === nid.toLowerCase()) {
            alert("产品编号「" + nid + "」已存在，请换一个（编号必须唯一）。"); return;
          }
        }
      }
      // 就地更新
      Object.keys(rec).forEach(function (k) { delete rec[k]; });
      Object.keys(newRec).forEach(function (k) { rec[k] = newRec[k]; });
      saveProductsToStore();
      refreshProductTable(null);
      showRecord(rec);
      document.body.removeChild(overlay);
      setProdHint("✓ 已保存修改");
    });
  }

  function deleteCurrent() {
    if (!state.current) return;
    var rec = state.current;
    if (!confirm("确定删除产品「" + (rec[state.idKey] || "") + "」吗？")) return;
    var idx = state.records.indexOf(rec);
    if (idx >= 0) state.records.splice(idx, 1);
    state.current = null; disableProdActions();
    saveProductsToStore();
    refreshProductTable(null);
    $("prodDetail").value = "";
    setProdHint("✓ 已删除，剩余 " + state.records.length + " 条");
  }

  // ============================================================
  // 模板管理
  // ============================================================
  function initTemplate() {
    var sel = $("tplIndustry");
    Object.keys(state.templates).forEach(function (name) {
      var opt = document.createElement("option"); opt.value = name; opt.textContent = name; sel.appendChild(opt);
    });
    sel.addEventListener("change", function () { loadIndustryIntoForm(sel.value); });

    // 生成字段输入行
    var wrap = $("tplFields");
    wrap.innerHTML = "";
    state._fieldEls = {};
    TEMPLATE_FIELDS.forEach(function (f) {
      var row = document.createElement("div");
      row.className = "tpl-field-row";
      var lab = document.createElement("div");
      lab.className = "tpl-field-label";
      if (f.kind === "multi") lab.innerHTML = f.label + "<br><span class='tpl-sub'>(每行一条，每次换版分别编辑)</span>";
      else lab.textContent = f.label;
      var mid = document.createElement("div"); mid.className = "tpl-field-mid";
      var inp;
      if (f.kind === "multi") {
        inp = document.createElement("textarea");
      } else {
        inp = document.createElement("input"); inp.type = "text";
      }
      inp.className = "tpl-input"; inp.dataset.key = f.key;
      mid.appendChild(inp);
      var right = document.createElement("div"); right.className = "tpl-field-right";
      var vsel = document.createElement("select"); vsel.className = "ver-sel";
      VERSION_LABELS.forEach(function (lb, i) {
        var o = document.createElement("option"); o.value = String(i); o.textContent = lb; vsel.appendChild(o);
      });
      vsel.addEventListener("change", function () { onVersionSwitch(f.key); });
      right.appendChild(vsel);
      row.appendChild(lab); row.appendChild(mid); row.appendChild(right);
      wrap.appendChild(row);
      state._fieldEls[f.key] = { input: inp, sel: vsel, kind: f.kind };
    });

    // 载入首个行业
    if (Object.keys(state.templates).length) {
      sel.value = Object.keys(state.templates)[0];
      loadIndustryIntoForm(sel.value);
    }

    $("btnTplSave").addEventListener("click", saveCurrentTemplate);
    $("btnTplAdd").addEventListener("click", addIndustry);
    $("btnTplDel").addEventListener("click", deleteIndustry);
    $("btnTplReset").addEventListener("click", resetTemplates);
    $("btnTplExport").addEventListener("click", exportTemplates);
    $("btnTplImport").addEventListener("click", function () { $("tplFile").click(); });
    $("tplFile").addEventListener("change", importTemplates);
  }

  function setTplHint(msg) { $("tplHint").textContent = msg; }

  function loadIndustryIntoForm(name) {
    state.activeIndustry = name;
    var prof = state.templates[name] || {};
    state.curVersions = profileToVersions(prof);
    TEMPLATE_FIELDS.forEach(function (f) {
      var entry = state.curVersions[f.key] || { v: ["", "", "", ""], active: 0 };
      var a = parseInt(entry.active || 0, 10) || 0;
      var el = state._fieldEls[f.key];
      var val = entry.v[a];
      if (f.kind === "multi") el.input.value = Array.isArray(val) ? val.join("\n") : (val || "");
      else el.input.value = val || "";
      el.sel.value = String(a);
    });
  }

  function collectFieldValue(key, kind) {
    var el = state._fieldEls[key];
    if (kind === "multi") {
      return el.input.value.split(/\r?\n/).map(function (s) { return s.trim(); }).filter(Boolean);
    }
    return el.input.value.trim();
  }
  function setFieldValue(key, kind, val) {
    var el = state._fieldEls[key];
    if (kind === "multi") el.input.value = Array.isArray(val) ? val.join("\n") : (val || "");
    else el.input.value = val || "";
  }

  function onVersionSwitch(key) {
    var f = TEMPLATE_FIELDS.filter(function (x) { return x.key === key; })[0];
    var el = state._fieldEls[key];
    var newIdx = parseInt(el.sel.value, 10) || 0;
    var entry = state.curVersions[key];
    if (!entry) return;
    var oldIdx = parseInt(entry.active || 0, 10) || 0;
    if (oldIdx === newIdx) return;
    entry.v[oldIdx] = collectFieldValue(key, f.kind);
    entry.active = newIdx;
    setFieldValue(key, f.kind, entry.v[newIdx]);
  }

  function saveCurrentTemplate() {
    var name = state.activeIndustry;
    if (!name) { alert("请先选择或新增一个行业。"); return; }
    // 把当前编辑器内容存回 active 版
    TEMPLATE_FIELDS.forEach(function (f) {
      var entry = state.curVersions[f.key];
      if (entry) entry.v[parseInt(entry.active || 0, 10) || 0] = collectFieldValue(f.key, f.kind);
    });
    state.templates[name] = versionsToProfile(state.curVersions);
    saveTemplates(state.templates);
    setTplHint("✓ 已保存行业「" + name + "」的模板。下次生成将使用。");
  }

  function addIndustry() {
    var name = prompt("请输入新行业名称（如：包装机械）：");
    if (!name) return;
    name = name.trim();
    if (!name) return;
    if (state.templates[name]) { alert("行业「" + name + "」已存在。"); }
    else {
      var base = state.templates["通用"] ? deepCopy(state.templates["通用"]) : {};
      state.templates[name] = base;
    }
    var sel = $("tplIndustry");
    if (!Array.from(sel.options).some(function (o) { return o.value === name; })) {
      var opt = document.createElement("option"); opt.value = name; opt.textContent = name; sel.appendChild(opt);
    }
    sel.value = name;
    loadIndustryIntoForm(name);
    setTplHint("已切换到「" + name + "」，修改后点「保存模板」。");
  }

  function deleteIndustry() {
    var name = state.activeIndustry;
    if (!name) { alert("请先选中要删除的行业。"); return; }
    if (window.TEMPLATES_DATA && window.TEMPLATES_DATA[name]) {
      alert("「" + name + "」是内置行业，不能删除。\n（如需修改内容，直接编辑保存即可；要还原可点「恢复默认」。）");
      return;
    }
    if (!confirm("确定删除自定义行业「" + name + "」吗？")) return;
    delete state.templates[name];
    saveTemplates(state.templates);
    var sel = $("tplIndustry");
    var opt = Array.from(sel.options).filter(function (o) { return o.value === name; })[0];
    if (opt) sel.removeChild(opt);
    var remain = Object.keys(state.templates);
    if (remain.length) { sel.value = remain[0]; loadIndustryIntoForm(remain[0]); }
    setTplHint("✓ 已删除行业「" + name + "」。");
  }

  function resetTemplates() {
    if (!confirm("确定把所有模板恢复为内置默认吗？\n（将覆盖你在网页里做的模板修改）")) return;
    state.templates = defaultTemplates();
    saveTemplates(state.templates);
    var sel = $("tplIndustry");
    sel.innerHTML = "";
    Object.keys(state.templates).forEach(function (name) {
      var opt = document.createElement("option"); opt.value = name; opt.textContent = name; sel.appendChild(opt);
    });
    var first = Object.keys(state.templates)[0];
    sel.value = first; loadIndustryIntoForm(first);
    setTplHint("✓ 已恢复为内置默认模板。");
  }

  function exportTemplates() {
    // 先把当前编入，避免未保存丢失
    if (state.activeIndustry) {
      TEMPLATE_FIELDS.forEach(function (f) {
        var entry = state.curVersions[f.key];
        if (entry) entry.v[parseInt(entry.active || 0, 10) || 0] = collectFieldValue(f.key, f.kind);
      });
      state.templates[state.activeIndustry] = versionsToProfile(state.curVersions);
    }
    downloadText(JSON.stringify(state.templates, null, 2), "templates_导出.json", "application/json");
    setTplHint("✓ 已导出模板文件。");
  }

  function importTemplates(e) {
    var file = e.target.files[0];
    if (!file) return;
    var fr = new FileReader();
    fr.onload = function () {
      try {
        var data = JSON.parse(fr.result);
        if (!data || typeof data !== "object") throw new Error("格式不正确（应为 JSON 对象）");
        if (!confirm("导入将覆盖当前模板（含 " + Object.keys(data).length + " 个行业）。是否继续？")) return;
        // 合并：以导入为准，缺失内置行业用默认补
        var merged = defaultTemplates();
        Object.keys(data).forEach(function (name) {
          var p = data[name];
          if (p && typeof p === "object") {
            if (!merged[name]) merged[name] = {};
            merged[name] = p;
          }
        });
        state.templates = merged;
        saveTemplates(state.templates);
        var sel = $("tplIndustry"); sel.innerHTML = "";
        Object.keys(merged).forEach(function (name) {
          var opt = document.createElement("option"); opt.value = name; opt.textContent = name; sel.appendChild(opt);
        });
        var first = Object.keys(merged)[0];
        sel.value = first; loadIndustryIntoForm(first);
        setTplHint("✓ 已导入并保存模板（共 " + Object.keys(merged).length + " 个行业）。");
      } catch (err) {
        alert("导入失败：" + err.message);
      }
    };
    fr.readAsText(file, "utf-8");
    e.target.value = "";
  }

  // ---- 标签切换辅助 ----
  function switchTab(name) {
    var btn = Array.from(document.querySelectorAll(".tab-btn")).filter(function (b) { return b.getAttribute("data-tab") === name; })[0];
    if (btn) btn.click();
  }

  // ---- 模式切换（基础款 / 升级款·AI）----
  function applyMode(mode) {
    state.mode = mode;
    var bit = $("modeBadge");
    var libBtn = $("btnLibrary");
    var tplTab = $("tabBtnTemplate");
    var styleWrap = $("styleReqWrap");
    var polishBtn = $("btnPolishToggle");
    if (mode === "pro") {
      bit.textContent = "升级款";
      bit.className = "badge badge-pro";
      $("proNotice").style.display = "flex";
      if (libBtn) libBtn.style.display = "none";      // 升级款下隐藏模板库入口
      if (tplTab) tplTab.style.display = "none";       // 升级款下隐藏模板管理标签
      if (styleWrap) styleWrap.style.display = "block"; // 升级款显示「文案风格需求」
      if (polishBtn) polishBtn.style.display = "";      // 升级款才提供「智能润色」入口（需 AI 密钥）
      // 若当前正停在模板管理页，切到升级款时自动跳回生成文案
      var tplPanel = $("tab-template");
      if (tplPanel && tplPanel.classList.contains("active")) {
        var genBtn = document.querySelector('.tab-btn[data-tab="gen"]');
        if (genBtn) genBtn.click();
      }
    } else {
      bit.textContent = "基础款";
      bit.className = "badge badge-basic";
      $("proNotice").style.display = "none";
      if (libBtn) libBtn.style.display = "";
      if (tplTab) tplTab.style.display = "";
      if (styleWrap) styleWrap.style.display = "none";  // 基础款隐藏「文案风格需求」
      if (polishBtn) polishBtn.style.display = "none";  // 基础款不显示「智能润色」入口（润色需 AI 密钥）
      var polishPanelEl = $("polishPanel");
      if (polishPanelEl) polishPanelEl.style.display = "none"; // 顺带收起润色面板，避免残留
    }
    document.querySelectorAll(".ms-btn").forEach(function (b) {
      b.classList.toggle("active", b.getAttribute("data-mode") === mode);
    });
    refreshProKeyState();
  }

  function refreshProKeyState() {
    var el = $("proKeyState");
    if (!el) return;
    if (state.ai.api_key) {
      el.textContent = "✓ 已配置密钥（" + (state.ai.model || "deepseek-chat") + "）";
      el.className = "pro-key-state ok";
    } else {
      el.textContent = "⚠ 还未配置密钥，点右上角「⚙ 设置」";
      el.className = "pro-key-state warn";
    }
  }

  function initMode() {
    document.querySelectorAll(".ms-btn").forEach(function (b) {
      b.addEventListener("click", function () {
        var mode = b.getAttribute("data-mode");
        applyMode(mode);
        if (mode === "pro" && !state.ai.api_key) {
          setHint("升级款需先配置 API 密钥");
          openSettings(true);
        } else {
          setHint(mode === "pro" ? "已切换到升级款·AI 模式" : "已切换到基础款（无需联网）");
        }
      });
    });
    applyMode("basic");
  }

  // ---- AI 设置弹层 ----
  function openSettings(needKey) {
    $("setApiUrl").value = state.ai.api_url || DEFAULT_AI.api_url;
    $("setApiKey").value = state.ai.api_key || "";
    $("setModel").value = state.ai.model || "deepseek-chat";
    $("settingsModal").style.display = "flex";
    if (needKey) {
      setTimeout(function () { try { $("setApiKey").focus(); } catch (e) {} }, 50);
    }
  }
  function closeSettings() { $("settingsModal").style.display = "none"; }

  function initSettings() {
    $("btnSettings").addEventListener("click", function () { openSettings(false); });
    $("setCancelBtn").addEventListener("click", closeSettings);
    $("setSaveBtn").addEventListener("click", function () {
      var url = $("setApiUrl").value.trim() || DEFAULT_AI.api_url;
      var key = $("setApiKey").value.trim();
      var model = $("setModel").value.trim() || "deepseek-chat";
      state.ai = { api_url: url, api_key: key, model: model, temperature: 0.7, timeout: 90 };
      saveAIConfig(state.ai);
      closeSettings();
      refreshProKeyState();
      setHint(key ? "✓ AI 设置已保存（仅存于本浏览器）" : "已清空密钥");
    });
    $("setTestBtn").addEventListener("click", async function () {
      var url = $("setApiUrl").value.trim() || DEFAULT_AI.api_url;
      var key = $("setApiKey").value.trim();
      var model = $("setModel").value.trim() || "deepseek-chat";
      if (!key) { alert("请先填写密钥再测试。"); return; }
      var btn = $("setTestBtn"); var old = btn.textContent;
      btn.disabled = true; btn.textContent = "测试中……";
      try {
        var out = await callModel({ api_url: url, api_key: key, model: model, temperature: 0.7, timeout: 40 },
          "产品名称：测试；行业品类：通用");
        alert("连接成功 ✓ 模型已返回内容（" + (out ? out.length : 0) + " 字）。可点「保存」使用。");
      } catch (e) {
        alert("连接失败：\n" + (e && e.message ? e.message : e));
      } finally {
        btn.disabled = false; btn.textContent = old;
      }
    });
  }

  // ============================================================
  // 启动
  // ============================================================
  function bootstrap() {
    initTabs();
    initGenerate();
    initProduct();
    initTemplate();
    initSettings();
    initMode();
  }

  // 测试/复用钩子：Node 环境下暴露纯函数
  if (typeof window !== "undefined") {
    window.__APP__ = {
      renderBasicSections: renderBasicSections,
      extractFieldsFromText: extractFieldsFromText,
      detectIndustry: detectIndustry,
      rowsToRecords: rowsToRecords,
      parseCSV: parseCSV,
      profileToVersions: profileToVersions,
      versionsToProfile: versionsToProfile,
      loadTemplates: loadTemplates,
      defaultTemplates: defaultTemplates,
      buildPrompt: buildPrompt,
      parseSections: parseSections,
      buildPolishPrompt: buildPolishPrompt,
      buildSectionPrompt: buildSectionPrompt,
      SECTION_KEYS: SECTION_KEYS,
      loadAIConfig: loadAIConfig
    };
  }

  if (typeof document !== "undefined") {
    document.addEventListener("DOMContentLoaded", bootstrap);
  }
})();
