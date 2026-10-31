// 智能参数提取：从杂乱产品说明中识别结构化字段（纯本地规则，零依赖）。
// 字段：product(产品名称)/material(材质)/spec(规格)/precision(加工精度)/cert(认证)/delivery(交期)/scene(适用场景)
(function (root) {
  // 每个字段的匹配规则：正则 + 归一化函数
  var FIELD_DEFS = [
    { key: "material", label: "材质", re: /(?:材质|材料|用料|采用|使用)?\s*[:：]?\s*((?:[A-Za-z0-9]*[A-Za-z][A-Za-z0-9\-]*|[\u4e00-\u9fa5]{1,6})(?:材质|钢|铁|铝|铜|合金|塑料|橡胶|不锈钢|碳钢|铸铁|有机玻璃|亚克力|PVC|PE|PP|ABS|PTFE|尼龙|陶瓷|玻璃|木材|布料|面料|针织|无纺布)?)/g },
  ];

  // 简化：用"关键词 + 就近取值"的启发式，更稳。
  function firstMatch(text, re) {
    var m = re.exec(text);
    return m ? (m[1] || m[0]).trim() : "";
  }

  // ============ 口语/同义归一化词典（在正则前把说法"翻译"成规范形态） ============
  // 目的：把"一个丝/半个月/铁的/一米"等口语，尽量改写成带单位的规范表达，供后续正则识别。
  var CN_NUM = { "零": 0, "一": 1, "两": 2, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9, "十": 10 };
  function cn2num(s) {
    s = String(s || "").trim();
    if (/^\d+(\.\d+)?$/.test(s)) return parseFloat(s);
    if (s === "半") return 0.5;
    // 十/十几/二十几 等
    if (s.indexOf("十") >= 0) {
      var parts = s.split("十");
      var head = parts[0] === "" ? 1 : (CN_NUM[parts[0]] !== undefined ? CN_NUM[parts[0]] : NaN);
      var tail = parts[1] === "" ? 0 : (CN_NUM[parts[1]] !== undefined ? CN_NUM[parts[1]] : NaN);
      if (!isNaN(head) && !isNaN(tail)) return head * 10 + tail;
    }
    if (CN_NUM[s] !== undefined) return CN_NUM[s];
    return NaN;
  }

  // 支持"百/十/个位"的中文数字 → 数值（四百=400，两百五十=250，十五=15，一百二十=120）
  var CN_DIGIT = { "零": 0, "一": 1, "两": 2, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9 };
  function cn2num100(s) {
    s = String(s || "");
    if (!s) return NaN;
    var total = 0, section = 0, num = 0, seen = false;
    for (var i = 0; i < s.length; i++) {
      var c = s.charAt(i);
      if (CN_DIGIT[c] !== undefined) { num = CN_DIGIT[c]; seen = true; }
      else if (c === "十") { section += (num === 0 ? 1 : num) * 10; num = 0; seen = true; }
      else if (c === "百") { section += (num === 0 ? 1 : num) * 100; num = 0; seen = true; }
      else return NaN;
    }
    if (!seen) return NaN;
    return total + section + num;
  }

  function preprocess(text) {
    var t = String(text || "");
    // 1) 全角字母数字 → 半角
    t = t.replace(/[\uFF01-\uFF5E]/g, function (ch) { return String.fromCharCode(ch.charCodeAt(0) - 0xFEE0); })
         .replace(/\u3000/g, " ");
    // 1.5) 中文数字 → 阿拉伯数字（仅转换 2 字以上且含"十/百"的组合，如 四百/两百五十/十五/二十，
    //      避免把"一体机/一个"里的单字"一"误转）
    t = t.replace(/([零一二两三四五六七八九十百]{2,})/g, function (m) {
      if (!/十|百/.test(m)) return m;
      var n = cn2num100(m);
      return isNaN(n) ? m : String(n);
    });
    // 2) 口语精度 → 规范
    //   "头发丝的十分之一" / "头发丝那么细" 视为 0.01mm 级（不臆造数值，仅标注"高精度"→留空更稳，这里只在有数字时规整）
    t = t.replace(/([一二两三四五六七八九十半])\s*个?\s*丝/g, function (m0, cn) {
      var n = cn2num(cn); return isNaN(n) ? m0 : (n + "丝");
    });
    t = t.replace(/([一二两三四五六七八九十半])\s*丝(?:以内|左右|之内)?/g, function (m0, cn) {
      var n = cn2num(cn); return isNaN(n) ? m0 : (n + "丝");
    });
    t = t.replace(/千分之一毫米/g, "0.001mm").replace(/百分之一毫米/g, "0.01mm");
    t = t.replace(/道(?:以内|左右)?/g, "丝"); // "丝"俗称"道"
    //   IT 等级 → 保留 ITx
    t = t.replace(/(?:IT|it)\s*([1-9]\d?)\s*级?/g, "IT$1级");
    // 3) 口语交期 → 规范
    t = t.replace(/半个月/g, "15天").replace(/一个来月/g, "1个月");
    t = t.replace(/半?\s*个?\s*来月/g, "1个月");
    t = t.replace(/([一二两三四五六七八九十])\s*个?\s*(星期|周)/g, function (m0, cn, u) {
      var n = cn2num(cn); return isNaN(n) ? m0 : (n + u + "内");
    });
    t = t.replace(/([一二两三四五六七八九十])\s*个?\s*月/g, function (m0, cn) {
      var n = cn2num(cn); return isNaN(n) ? m0 : (n + "个月");
    });
    t = t.replace(/十来天|十几天|十来日/g, "十天左右");
    t = t.replace(/([一二两三四五六七八九])来天/g, function (m0, cn) {
      var n = cn2num(cn); return isNaN(n) ? m0 : (n + "天左右");
    });
    // 中文数字 + 天 → 阿拉伯数字天（覆盖"十天左右""三天内"等，含"十X"）
    t = t.replace(/([一二两三四五六七八九十]+)\s*天/g, function (m0, cn) {
      var n = cn2num(cn); return isNaN(n) ? m0 : (n + "天");
    });
    t = t.replace(/当天(?:发|发货|发出)?|现货(?:发)?/g, "现货");
    // 4) 口语规格/单位 → 规范
    t = t.replace(/一米长|一米/g, "1000mm").replace(/两米长|两米/g, "2000mm");
    t = t.replace(/[Øø∅]/g, "Φ");
    t = t.replace(/(\d+(?:\.\d+)?)\s*寸/g, function (m0, d) { return "DN" + d + "寸"; });
    // 5) 材质口语 → 规范
    t = t.replace(/铁的|是铁|铁质/g, "铁");
    return t;
  }

  function extract(text) {
    text = String(text || "");
    // 统一全角字母/数字为半角 + 口语归一化，便于后续匹配
    var norm = preprocess(text);
    var res = { product: "", material: "", spec: "", precision: "", cert: "", delivery: "", scene: "" };

    // 1) 产品名称/品类
    //   a. 显式"产品名称/品名/名称/型号：xxx"
    var pm = norm.match(/(?:产品名称|品名|名称|产品型号|型号)\s*[:：]\s*([^\n；;，,]{1,30})/);
    if (pm) res.product = pm[1].trim();
    //   b. "产品：xxx"（独立产品词）
    if (!res.product) {
      var pm2 = norm.match(/产品\s*[:：]\s*([^\n；;，,]{1,30})/);
      if (pm2) res.product = pm2[1].trim();
    }
    //   c. 品类词库 + 通用"XX机/XX床/XX管/XX件/XX螺栓"结构
    if (!res.product) {
      var km = norm.match(/(数控车床|加工中心|铣床|铣车|车床|床子|钻床|磨床|折弯机|切割机|激光切割机|减速机|齿轮减速电机|电机|伺服电机|变频器|离心泵|轴流风机|风机|真空泵|电动滚筒|控制柜|螺栓|螺母|垫圈|法兰盘|法兰|卡箍|U型卡|扣件|自攻螺钉|焊管|方管|镀锌方管|彩钢瓦|C型钢|铝型材|钢管|楼承板|夹芯板|钢筋网片|钢格板|雨水管|密封圈|油封|垫片|软接头|油管|橡胶板|密封胶条|保温管|坯布|牛津布|工装面料|帆布|无纺布|摇粒绒|里布|网眼布|亚麻布|阻燃布|针织布|结构胶|防腐涂料|聚氨酯胶|瞬间胶|密封胶|水性漆|防锈剂|玻璃胶|热熔胶|陶瓷涂料|脱模剂|搅拌机|肉丸成型机|滚揉机|和面机|压面机|果蔬清洗机|杀菌锅|灌装机|切丁机|豆制品生产线|中央厨房设备|雕刻机|开料机|封边机|砂光机|多片锯|打孔机|激光雕刻机|拼板机|木门加工中心|榫卯机|机架|非标设备|输送线|钣金件|精密零件|工装夹具|钢结构件|铝制品|模具配件|冲压件|打包机|换热器|阀门|轴承|齿轮|皮带|弹簧)/);
      if (km) res.product = km[1];
    }
    //   d. 句首"做/生产/主营 XX"结构兜底（取到逗号/顿号前，≤16字）
    if (!res.product) {
      var pm3 = norm.match(/(?:做|生产|主营|厂家|供应|批发)\s*([\u4e00-\u9fa5A-Za-z0-9]{2,16})/);
      if (pm3) res.product = pm3[1].trim();
    }
    //   e. 清洗：去掉句尾"的"，去掉误吞的"周期/时间"等
    if (res.product) {
      res.product = res.product.replace(/(?:的|周期|时间|十来天|左右|以内)$/g, "").trim();
      if (/^(周期|时间|交期|十来天)/.test(res.product)) res.product = "";
    }

    // 2) 材质
    var matM = norm.match(/(?:材质|材料|用料|采用|使用|选用|料子(?:是|为)?)\s*[:：]?\s*(?:为|是)?\s*([^\n；;，,。]{1,20})/);
    if (matM) res.material = matM[1].trim();
    if (!res.material || res.material.length > 12) {
      var matK = norm.match(/([0-9]{1,2}#?钢|Q235|Q345|40Cr|20Cr|304不锈钢|316不锈钢|不锈钢|碳钢|铸铁|铸钢|球墨铸铁|铝合金|锌合金|黄铜|紫铜|PVC|PE|PP|ABS|PTFE|聚四氟|聚氨酯|硅胶|橡胶|尼龙|亚克力|有机玻璃|玻璃|陶瓷|石墨|铜|铝|钢|铁)/);
      if (matK && (!res.material || res.material.length > 12)) res.material = matK[1];
    }
    if (res.material) {
      res.material = res.material.replace(/(?:的|材质|材料|做的)$/g, "").trim();
    }

    // 3) 规格（尺寸）：优先"XXX卡盘"；再认显式规格字段；再认 M螺纹/Φ/×；再数×数
    var chunkSize = norm.match(/([Φφ]?\s*\d[\d.]*)\s*(?:的)?\s*卡盘/);
    if (chunkSize) res.spec = chunkSize[1].trim();
    if (!res.spec) {
      var specM = norm.match(/(?:尺寸规格|规格|尺寸|加工范围|最大回转直径|最大加工)[^0-9MmΦφ]{0,6}([Mm]\s*\d[\d.]*(?:\s*[×xX*]\s*\d[\d.]*)?|[Φφ]?\s*\d[\d.]*(?:\s*[×xX*]\s*\d[\d.]*\s*)*(?:mm|cm|m|毫米|厘米|米)?)/i);
      if (specM && specM[1] && /\d/.test(specM[1])) res.spec = specM[1].trim();
    }
    if (!res.spec) {
      var anySize = norm.match(/[Mm]\s*\d+\s*(?:[×xX*]\s*\d+)?|[Φφ]\s*\d[\d.]*(?:\s*[×xX*]\s*\d[\d.]*)?(?:mm|毫米)?|\d[\d.]*(?:\s*[×xX*]\s*\d[\d.]*)+(?:mm|毫米|cm|厘米)?/);
      if (anySize) res.spec = anySize[0].trim();
    }

    // 4) 加工精度：±数值 / H7 IT6 公差等级 / 数字+μm丝 / 0.01mm(可无±) / 裸"X丝"
    var precM = norm.match(/(?:加工精度|配合精度|精度|公差等级|公差|误差|重复定位精度|定位精度|光洁度|圆度)\s*[:：]?\s*(?:为|是|达|可达|达到|能到|控制在)?\s*(±\s*\d[\d.]*\s*(?:mm|毫米|μm|um|微米|丝|°|度)?|[A-Z]{1,2}\d{1,2}(?:级)?|\d[\d.]*\s*(?:μm|um|微米|丝|mm|毫米)|[A-Za-z]\d{1,2}\s*级?)/i);
    if (precM) res.precision = precM[1].trim();
    if (!res.precision) {
      // 兜底只认 ±数值 与 数字+丝/μm/微米（不吞纯 mm 尺寸，避免把规格当精度）
      var pAny = norm.match(/±\s*\d[\d.]*\s*(?:mm|毫米|μm|um|微米|丝|°|度)?|\d[\d.]*\s*(?:μm|um|微米|丝)(?:以内|左右|之内)?/);
      if (pAny) res.precision = pAny[0].trim();
    }

    // 5) 认证（norm 已把全角转半角；忽略大小写）
    var certs = [];
    var certRe = /(ISO\s*\d{4,5}|CE认证|CE|SGS|RoHS|3C认证|CCC|CNAS|国标认证|GB\/?T?\s*\d+|船级社认证|劳氏认证|3A认证)/gi, cm;
    while ((cm = certRe.exec(norm)) !== null) { certs.push(cm[0].replace(/\s+/g, " ").trim()); }
    if (certs.length) res.cert = Array.from(new Set(certs)).join("、");
    if (!res.cert) {
      var cAny = norm.match(/(?:认证|通过|持有|获得|符合)\s*[:：]?\s*([^\n；;，,。]{2,30})/);
      if (cAny) res.cert = cAny[1].trim();
    }

    // 6) 交期
    var delivM = norm.match(/(?:交期|交货期|工期|货期|生产周期|周期)\s*[:：]?\s*(?:为|是|约|大概|需|需要)?\s*(\d+\s*(?:个)?\s*(?:天|工作日|周|星期|个月|月|小时)(?:左右|内|以内|之内)?|现货)/);
    if (delivM) res.delivery = delivM[1].trim().replace(/^[:：\s]+/, "");
    if (!res.delivery) {
      var dAny = norm.match(/(\d+\s*(?:个)?\s*(?:天|工作日|周|星期|个月|月|小时))(?:左右|内|以内)?(?:交货|发货|交付|交期)?|现货/);
      if (dAny) res.delivery = dAny[0].trim();
    }

    // 7) 适用场景
    var sceneM = norm.match(/(?:适用场景|应用场景|可用场景|适配场景|应用领域|应用范围|适用行业|适用|应用于|用于|适用于|广泛用于|主要用于|主要用来|主要是用来|主要|适合|常规批次)\s*[:：]?\s*([^\n。]{2,60})/);
    if (sceneM) res.scene = sceneM[1].trim().replace(/^[:：\s]+/, "");

    // 清理异常值
    Object.keys(res).forEach(function (k) {
      res[k] = (res[k] || "").replace(/^[:：、，,\s]+|[:：、，,\s]+$/g, "").trim();
      if (res[k].length > 60) res[k] = res[k].slice(0, 60);
    });
    return res;
  }

  // 校验必填项缺失，返回提示列表
  var FIELD_LABELS = {
    product: "产品名称", material: "材质", spec: "规格尺寸",
    precision: "加工精度", cert: "认证", delivery: "交期", scene: "适用场景"
  };
  function validate(fields) {
    var tips = [];
    var order = ["product", "material", "spec", "precision", "cert", "delivery", "scene"];
    // 关键字段缺失给针对性提示
    if (!fields.precision) tips.push("缺少加工精度参数，补充后文案更专业");
    if (!fields.cert) tips.push("缺少认证信息（如 ISO9001），补充后更可信");
    if (!fields.delivery) tips.push("缺少交期信息，补充后方便客户决策");
    if (!fields.spec) tips.push("缺少规格尺寸，补充后产品描述更完整");
    if (!fields.material) tips.push("缺少材质信息，补充后卖点更具体");
    if (!fields.scene) tips.push("缺少适用场景，补充后更贴合客户需求");
    return tips;
  }

  // 把已确认的表单字段拼回一段结构化文本，供生成使用
  function toText(fields) {
    var parts = [];
    // 输出用词与基础款字段解析保持一致（尺寸规格/材质/交期/认证/产品名称）
    var MAP = {
      product: "产品名称", material: "材质", spec: "尺寸规格",
      precision: "加工精度", cert: "认证", delivery: "交期", scene: "适用场景"
    };
    var order = ["product", "material", "spec", "precision", "cert", "delivery", "scene"];
    order.forEach(function (k) {
      if (fields[k] && String(fields[k]).trim()) {
        parts.push(MAP[k] + "：" + String(fields[k]).trim());
      }
    });
    return parts.join("；");
  }

  var api = { extract: extract, validate: validate, toText: toText, FIELD_LABELS: FIELD_LABELS };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.ParamParser = api;
})(typeof window !== "undefined" ? window : this);
